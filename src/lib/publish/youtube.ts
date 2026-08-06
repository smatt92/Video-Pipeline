/**
 * The YouTube publish driver. Vendor names are legal here and nowhere above it (rule 1).
 *
 * ── Everything below was read from the API's own discovery document ──────────
 *
 * `https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest`, revision 20260805,
 * fetched from this container — `*.googleapis.com` is on the environment's Trusted
 * allowlist, so this is one of the few vendor surfaces that can be checked from here
 * rather than recalled. Field names, scopes and the resumable protocol path all come from
 * it. The one thing that does NOT is the quota costs: those live in Google's separate
 * quota calculator, are not in the discovery document, and are marked below as what they
 * are.
 *
 * The field that matters most is the one this project would otherwise have guessed:
 *
 *   containsSyntheticMedia — "Indicates if the video contains altered or synthetic media."
 *
 * That is `publications.altered_content_disclosed`'s counterpart, verified rather than
 * inferred from the name. Getting it wrong would produce uploads that succeed, look
 * correct, and are undisclosed — a compliance failure with no error message anywhere.
 *
 * ── Why resumable, and why the session URI is a database column ──────────────
 *
 * `videos.insert` costs 1,600 units of a 10,000-unit daily allowance, and Google charges
 * the attempt rather than the success. Six failed uploads is a day's quota. A resumable
 * session lets a worker that died mid-transfer continue rather than start again, so the
 * session URI has to outlive the process — which makes it `publications.upload_session_url`
 * rather than a local variable.
 */

/** Where uploads go. The discovery document also exposes `/resumable/upload/...`; this is
 *  the form Google documents, and the two are the same endpoint. */
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * What each call costs, in quota units.
 *
 * NOT from the discovery document — Google publishes these in a separate quota calculator
 * and the API does not describe its own prices. So this is a documented constant that
 * nobody here has watched hold, which is exactly what `integrations.quota_source =
 * 'documented'` records. The day a 403 quotaExceeded arrives at a figure these do not
 * predict, the ceiling becomes observable and both change together.
 *
 * `search.list` is present and unused on purpose: it is 100× the cost of reading an
 * uploads playlist for the same information, and naming it here with its price is what
 * stops it being reached for. See Addendum 04.
 */
export const QUOTA_UNITS = {
  'videos.insert': 1600,
  'videos.list': 1,
  'channels.list': 1,
  'playlistItems.list': 1,
  'search.list': 100,
} as const;

export type QuotaEndpoint = keyof typeof QUOTA_UNITS;

/** The scope an upload needs, per the discovery document's `videos.insert.scopes`. */
export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

export interface OauthApp {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type AccessToken =
  | { ok: true; accessToken: string; expiresAt: string }
  | { ok: false; code: string; detail: string; credentialRevoked: boolean };

/**
 * Exchange the refresh token for an access token.
 *
 * `credentialRevoked` is the return value's whole point. Google answers a dead refresh
 * token with `invalid_grant`, and that is categorically different from a network blip: one
 * needs a human to re-consent, the other needs a retry. Collapsing them into "refresh
 * failed" is how a broken credential is retried for a week — see
 * `channels.token_last_refreshed_at` for why this is the only expiry signal that exists.
 */
export async function fetchAccessToken(
  app: OauthApp,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessToken> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        refresh_token: app.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      detail: err instanceof Error ? err.message : String(err),
      credentialRevoked: false,
    };
  }

  const text = await res.text();
  if (!res.ok) {
    // `invalid_grant` is the revoked/expired case and the only one a retry cannot fix.
    const revoked = /invalid_grant/i.test(text);
    return {
      ok: false,
      code: revoked ? 'invalid_grant' : `http_${res.status}`,
      detail: revoked
        ? 'The refresh token is no longer valid — revoked, or expired because the OAuth '
          + 'consent screen is still in Testing (seven days). Re-consent is required; no '
          + 'number of retries will fix it.'
        : text.slice(0, 400),
      credentialRevoked: revoked,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: 'unparseable', detail: text.slice(0, 400), credentialRevoked: false };
  }

  const parsed = body as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
    return {
      ok: false,
      code: 'unexpected_shape',
      detail: 'The token response carried no access_token/expires_in pair.',
      credentialRevoked: false,
    };
  }

  return {
    ok: true,
    accessToken: parsed.access_token,
    // The access token's expiry IS knowable — the vendor states it. This is the one
    // timestamp in the OAuth path that is a measurement rather than a guess.
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000).toISOString(),
  };
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  /** `publications.altered_content_disclosed`. Required, never defaulted — see below. */
  alteredContentDisclosed: boolean;
  privacyStatus: 'private' | 'unlisted' | 'public';
  madeForKids: boolean;
  /** ISO 8601. Only permitted when privacyStatus is 'private', per the schema. */
  publishAt?: string;
}

/**
 * The `videos.insert` request body.
 *
 * Exported and pure so a harness can assert its shape without a network call — which is
 * the only way the disclosure field can be tested at all, since the alternative is
 * uploading a real video to a real channel.
 *
 * `containsSyntheticMedia` is set from `alteredContentDisclosed` with no default and no
 * `??`. An option whose default is the behaviour you are avoiding must be passed
 * explicitly: omitting this field means "not disclosed", which is precisely the state the
 * column exists to prevent, and it would read in the source as absence rather than as a
 * decision.
 */
export function insertBody(meta: VideoMetadata): Record<string, unknown> {
  return {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
    },
    status: {
      privacyStatus: meta.privacyStatus,
      madeForKids: meta.madeForKids,
      selfDeclaredMadeForKids: meta.madeForKids,
      containsSyntheticMedia: meta.alteredContentDisclosed,
      ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
    },
  };
}

export type SessionResult =
  | { ok: true; sessionUrl: string }
  | { ok: false; code: string; detail: string; quotaExceeded: boolean };

/**
 * Open a resumable session. Costs 1,600 units whether or not any bytes follow.
 *
 * The caller must write the quota row BEFORE calling this, not after — same reasoning as
 * rule 5 for money. A process that dies between the call and the row leaves units spent
 * and unrecorded, and the remaining figure then over-reports for the rest of the window.
 */
export async function openUploadSession(
  accessToken: string,
  meta: VideoMetadata,
  totalBytes: number,
  contentType = 'video/mp4',
  fetchImpl: typeof fetch = fetch,
): Promise<SessionResult> {
  const url = `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-upload-content-length': String(totalBytes),
        'x-upload-content-type': contentType,
      },
      body: JSON.stringify(insertBody(meta)),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      detail: err instanceof Error ? err.message : String(err),
      quotaExceeded: false,
    };
  }

  if (!res.ok) {
    const text = await res.text();
    // 403 quotaExceeded is the observation that turns the documented ceiling into a
    // measured one. Surfaced distinctly so the caller can record that rather than
    // treating it as a generic failure.
    const quotaExceeded = res.status === 403 && /quotaExceeded|quota/i.test(text);
    return {
      ok: false,
      code: quotaExceeded ? 'quota_exceeded' : `http_${res.status}`,
      detail: text.slice(0, 500),
      quotaExceeded,
    };
  }

  const sessionUrl = res.headers.get('location');
  if (!sessionUrl) {
    return {
      ok: false,
      code: 'no_session_url',
      detail:
        'The session opened and returned no Location header, so there is nowhere to send '
        + 'the bytes. The 1,600 units are spent either way — this is recorded rather than '
        + 'retried blindly.',
      quotaExceeded: false,
    };
  }

  return { ok: true, sessionUrl };
}

export type UploadResult =
  | { ok: true; videoId: string; url: string }
  | { ok: false; code: string; detail: string; resumeFrom: number | null };

/**
 * Send the bytes to an open session.
 *
 * `resumeFrom` on failure is what makes the retry cheap: a 308 carries a `Range` header
 * saying how much arrived, and continuing from there costs no further quota. Null means
 * the position is unknown — which is not zero, and the caller must query the session
 * rather than assume it starts again.
 */
export async function sendUpload(
  sessionUrl: string,
  body: ArrayBuffer | Uint8Array,
  totalBytes: number,
  offset = 0,
  contentType = 'video/mp4',
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  let res: Response;
  try {
    res = await fetchImpl(sessionUrl, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'content-length': String(totalBytes - offset),
        ...(offset > 0
          ? { 'content-range': `bytes ${offset}-${totalBytes - 1}/${totalBytes}` }
          : {}),
      },
      body: body as BodyInit,
    });
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      detail: err instanceof Error ? err.message : String(err),
      resumeFrom: null,
    };
  }

  if (res.status === 308) {
    return {
      ok: false,
      code: 'incomplete',
      detail: 'The session is still open and expects more bytes.',
      resumeFrom: parseResumeOffset(res.headers.get('range')),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      code: `http_${res.status}`,
      detail: (await res.text()).slice(0, 500),
      resumeFrom: null,
    };
  }

  const parsed = (await res.json().catch(() => null)) as { id?: unknown } | null;
  if (!parsed || typeof parsed.id !== 'string') {
    return {
      ok: false,
      code: 'no_video_id',
      detail:
        'The upload completed and the response carried no video id, so nothing can '
        + 'confirm what was published. Refusing to record a publication whose subject is '
        + 'unknown.',
      resumeFrom: null,
    };
  }

  return { ok: true, videoId: parsed.id, url: `https://www.youtube.com/watch?v=${parsed.id}` };
}

/**
 * `Range: bytes=0-N` → N+1, the next byte to send. Null when absent or unparseable.
 *
 * Null rather than 0, and the difference is 1,600 units: 0 means "the server has nothing,
 * start from the beginning" and null means "we do not know what the server has". Treating
 * the second as the first re-sends a whole video that may already be there.
 */
export function parseResumeOffset(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const m = /bytes=0-(\d+)/.exec(rangeHeader);
  if (!m) return null;
  const end = Number(m[1]);
  return Number.isInteger(end) && end >= 0 ? end + 1 : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The read path — competitor signal, Addendum 04
// ═══════════════════════════════════════════════════════════════════════════════
//
// In this file rather than a module of its own, and that is a decision rather than
// laziness: it is the same vendor's same API, and two homes for one API surface is the
// two-modules failure CLAUDE.md names. `src/lib/trends/` consumes these through a deps
// object and never learns the vendor's name.
//
// These calls are read-only and use an API key rather than OAuth — public channel data
// needs no user consent, and an upload credential is the wrong thing to hand a poller.

const DATA_API = 'https://youtube.googleapis.com/youtube/v3';

export interface UploadItem {
  videoId: string;
  title: string;
  publishedAt: string;
}

export type UploadsResult =
  | { ok: true; items: UploadItem[] }
  | { ok: false; code: string; detail: string; quotaExceeded: boolean };

/**
 * A channel's recent uploads, from its uploads playlist.
 *
 * **1 quota unit.** `search.list` returns the same information for 100 — twenty channels
 * daily is 20 units against 2,000, out of an allowance shared with uploads at 1,600 each.
 * `tracked_channels.uploads_playlist_id` exists so this is the only path available; see the
 * column comment in migration 0036.
 */
export async function listUploads(
  apiKey: string,
  uploadsPlaylistId: string,
  maxResults = 20,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadsResult> {
  const url =
    `${DATA_API}/playlistItems?part=contentDetails,snippet`
    + `&playlistId=${encodeURIComponent(uploadsPlaylistId)}`
    + `&maxResults=${Math.min(maxResults, 50)}&key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      detail: err instanceof Error ? err.message : String(err),
      quotaExceeded: false,
    };
  }

  const text = await res.text();
  if (!res.ok) {
    const quotaExceeded = res.status === 403 && /quotaExceeded/i.test(text);
    return {
      ok: false,
      code: quotaExceeded ? 'quota_exceeded' : `http_${res.status}`,
      detail: text.slice(0, 400),
      quotaExceeded,
    };
  }

  let body: { items?: unknown };
  try {
    body = JSON.parse(text) as { items?: unknown };
  } catch {
    return { ok: false, code: 'unparseable', detail: text.slice(0, 300), quotaExceeded: false };
  }

  const items: UploadItem[] = [];
  for (const raw of Array.isArray(body.items) ? body.items : []) {
    const it = raw as {
      contentDetails?: { videoId?: unknown; videoPublishedAt?: unknown };
      snippet?: { title?: unknown };
    };
    const videoId = it.contentDetails?.videoId;
    const publishedAt = it.contentDetails?.videoPublishedAt;
    const title = it.snippet?.title;
    // Skipped rather than defaulted. A playlist item with no video id is a deleted or
    // private video, and inventing a placeholder would put a row in competitor_videos that
    // can never be scored and can never be explained.
    if (typeof videoId !== 'string' || typeof publishedAt !== 'string') continue;
    items.push({ videoId, title: typeof title === 'string' ? title : '', publishedAt });
  }

  return { ok: true, items };
}

export type StatsResult =
  | { ok: true; views: Map<string, number | null> }
  | { ok: false; code: string; detail: string; quotaExceeded: boolean };

/**
 * View counts for up to 50 videos in one call. **1 quota unit**, whatever the batch size.
 *
 * `viewCount` arrives as a **string** — the discovery document types it `string` with
 * format `uint64`, for the same reason Postgres sends bigints as text: the value can exceed
 * what a double holds exactly. `Number()` here is a decision, taken at the boundary, and it
 * is safe because a view count above 2^53 does not exist. A missing or unparseable count
 * becomes `null`, never 0 — a video whose stats are hidden is not a video nobody watched,
 * and 0 would drag the channel's median down and inflate every score on it.
 */
export async function listVideoStats(
  apiKey: string,
  videoIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<StatsResult> {
  if (videoIds.length === 0) return { ok: true, views: new Map() };
  if (videoIds.length > 50) {
    return {
      ok: false,
      code: 'batch_too_large',
      detail: `${videoIds.length} ids in one call; the API accepts 50. Chunk before calling — `
        + 'each chunk is a separate quota unit and must write its own ledger row.',
      quotaExceeded: false,
    };
  }

  const url =
    `${DATA_API}/videos?part=statistics&id=${videoIds.map(encodeURIComponent).join(',')}`
    + `&key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return {
      ok: false,
      code: 'network',
      detail: err instanceof Error ? err.message : String(err),
      quotaExceeded: false,
    };
  }

  const text = await res.text();
  if (!res.ok) {
    const quotaExceeded = res.status === 403 && /quotaExceeded/i.test(text);
    return {
      ok: false,
      code: quotaExceeded ? 'quota_exceeded' : `http_${res.status}`,
      detail: text.slice(0, 400),
      quotaExceeded,
    };
  }

  let body: { items?: unknown };
  try {
    body = JSON.parse(text) as { items?: unknown };
  } catch {
    return { ok: false, code: 'unparseable', detail: text.slice(0, 300), quotaExceeded: false };
  }

  const views = new Map<string, number | null>();
  for (const raw of Array.isArray(body.items) ? body.items : []) {
    const it = raw as { id?: unknown; statistics?: { viewCount?: unknown } };
    if (typeof it.id !== 'string') continue;
    const vc = it.statistics?.viewCount;
    const n = typeof vc === 'string' ? Number(vc) : typeof vc === 'number' ? vc : NaN;
    views.set(it.id, Number.isFinite(n) && n >= 0 ? n : null);
  }
  return { ok: true, views };
}
