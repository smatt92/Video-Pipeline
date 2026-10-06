import { httpJson } from '../drivers/http';
import type { ProbeResult } from '../drivers/probes';
import { fetchAccessToken } from './youtube';
import { ANALYTICS_SCOPE } from './yt-analytics';

/**
 * "Save and test" for YouTube: two read-only checks, in order, each a distinct claim.
 *
 *   credentials  The refresh token, client id and secret exchange for an access token.
 *                `invalid_grant` is named for what it almost always is here: a token revoked,
 *                or expired because the OAuth consent screen is still in Testing (seven days).
 *   channel      That access token can read the Bureau channel's own Analytics — a v2 reports
 *                query with `ids=channel==<channels.external_id>` over the last seven days.
 *                200 passes. 403 fails by name: the token belongs to a different channel (or,
 *                when Google says so, it lacks the yt-analytics.readonly scope).
 *
 * Analytics rather than the Data API on purpose: the reports endpoint has its own quota, so
 * pressing the button costs none of the 10,000 daily Data API units an upload needs 1,600 of.
 * Never uploads; never calls videos.insert; nothing here writes anywhere at the vendor.
 *
 * `channelExternalId` null (the Bureau row has no external id yet) falls back to
 * `channel==MINE`, which proves the token can read *a* channel's analytics and says so — the
 * detail names the fallback so a pass is not mistaken for "this is the right channel".
 */

const ANALYTICS_REPORTS = 'https://youtubeanalytics.googleapis.com/v2/reports';

export interface YoutubeProbeInput {
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  channelExternalId: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

export async function probeYoutube(input: YoutubeProbeInput): Promise<ProbeResult> {
  const started = Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;
  const elapsed = () => Date.now() - started;

  if (!input.clientId || !input.clientSecret || !input.refreshToken) {
    return {
      latencyMs: 0,
      checks: [
        { name: 'credentials', passed: false, required: true, detail: 'Client ID, client secret and refresh token are all required. Nothing was called.' },
        { name: 'channel', passed: false, required: true, detail: 'Not attempted: no credentials to attempt it with.' },
      ],
    };
  }

  // ── 1. Credentials ──────────────────────────────────────────────────────────
  const token = await fetchAccessToken(
    { clientId: input.clientId, clientSecret: input.clientSecret, refreshToken: input.refreshToken },
    fetchImpl,
  );
  if (!token.ok) {
    const detail = token.code === 'invalid_grant'
      ? 'Refresh token revoked or expired (7-day Testing expiry). Google answered invalid_grant: '
        + 'the token was revoked, or the OAuth consent screen is still in Testing, where refresh '
        + 'tokens die after seven days. Publish the app, re-consent, paste the new refresh token.'
      : `The token exchange failed (${token.code}): ${token.detail}`;
    return {
      latencyMs: elapsed(),
      checks: [
        { name: 'credentials', passed: false, required: true, detail },
        { name: 'channel', passed: false, required: true, detail: 'Not attempted: no access token.' },
      ],
    };
  }
  const credentials = {
    name: 'credentials' as const,
    passed: true,
    required: true,
    detail: 'The refresh token exchanged for an access token.',
  };

  // ── 2. Channel ──────────────────────────────────────────────────────────────
  const now = (input.now ?? (() => new Date()))();
  const ids = input.channelExternalId ? `channel==${input.channelExternalId}` : 'channel==MINE';
  const q = new URLSearchParams({
    ids,
    startDate: day(new Date(now.getTime() - 7 * 24 * 3600 * 1000)),
    endDate: day(now),
    metrics: 'views',
  });
  const r = await httpJson(`${ANALYTICS_REPORTS}?${q}`, {
    headers: { authorization: `Bearer ${token.accessToken}` },
    fetchImpl,
    timeoutMs: 20_000,
  });

  let channel;
  if (r.ok) {
    channel = {
      name: 'channel' as const,
      passed: true,
      required: true,
      detail: input.channelExternalId
        ? `The token reads ${input.channelExternalId}'s Analytics (last 7 days).`
        : 'The token reads its own channel\'s Analytics (channel==MINE) — the Bureau channel row has no '
          + 'external id yet, so this does not prove it is the right channel.',
    };
  } else if (r.status === 403) {
    const scope = /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(r.detail);
    channel = {
      name: 'channel' as const,
      passed: false,
      required: true,
      detail: scope
        ? `The token lacks the ${ANALYTICS_SCOPE} scope. Re-consent including it and paste the new refresh token.`
        : `Token belongs to a different channel: Google refused ${ids}'s Analytics to it (403). Re-consent `
          + 'signed in as the Google account that owns this channel.',
    };
  } else {
    channel = {
      name: 'channel' as const,
      passed: false,
      required: true,
      detail: `The Analytics query failed (${r.status ?? r.code}): ${r.detail}`,
    };
  }

  return { latencyMs: elapsed(), checks: [credentials, channel] };
}
