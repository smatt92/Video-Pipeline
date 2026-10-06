#!/usr/bin/env node
/**
 * The YouTube "Save and test" probe, against a stub fetch (src/lib/publish/youtube-probe.ts).
 *
 * PROVES: the two checks are distinct and ordered; every refusal is named — missing fields
 * (nothing called), invalid_grant ("refresh token revoked or expired (7-day Testing
 * expiry)"), any other token failure, 403 as "token belongs to a different channel", 403 for
 * a missing scope as that, any other status; the accept path queries Analytics v2 with
 * ids=channel==<external id> over the last seven days, or channel==MINE (said so) when the id
 * is null; and every request it makes is a token exchange or an Analytics GET — never an
 * upload, never videos.insert, never the Data API.
 *
 * DOES NOT PROVE: Google's real responses. Only "Save and test" on the deploy does (0008 §18).
 *
 * Usage: node scripts/test-youtube-probe.mjs   (after tsc -p tsconfig.verify.json)
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { probeYoutube } = require(`${B}/publish/youtube-probe.js`);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};

const CH = 'UCsAOylowJKXg7TENr5GskGQ';
const NOW = new Date('2026-10-06T12:00:00Z');
const creds = { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt' };

/** A stub Google: token endpoint and Analytics, each answer configurable. Records every request. */
function google({ token = { status: 200, body: { access_token: 'at-1', expires_in: 3599 } }, report = { status: 200, body: { columnHeaders: [{ name: 'views' }], rows: [[12]] } } } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({ url: u, method: (init.method ?? 'GET').toUpperCase(), headers: init.headers ?? {}, body: init.body ? String(init.body) : '' });
    const pick = u.hostname === 'oauth2.googleapis.com' ? token : u.hostname === 'youtubeanalytics.googleapis.com' ? report : { status: 599, body: { error: 'unexpected host' } };
    const text = typeof pick.body === 'string' ? pick.body : JSON.stringify(pick.body);
    return new Response(text, { status: pick.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests };
}
const byName = (r, n) => r.checks.find((c) => c.name === n);
const neverWrites = (requests) =>
  requests.every((q) => (q.url.hostname === 'oauth2.googleapis.com' && q.url.pathname === '/token' && q.method === 'POST')
    || (q.url.hostname === 'youtubeanalytics.googleapis.com' && q.url.pathname === '/v2/reports' && q.method === 'GET'));

console.log('\nYouTube probe — two checks, every refusal by name\n');

// 1. Missing fields
let g = google();
let r = await probeYoutube({ clientId: 'cid', clientSecret: undefined, refreshToken: 'rt', channelExternalId: CH, fetchImpl: g.fetchImpl, now: () => NOW });
check(!byName(r, 'credentials').passed && /all required/.test(byName(r, 'credentials').detail) && g.requests.length === 0,
  'a missing field → credentials fails, nothing called');
check(r.checks.length === 2 && !byName(r, 'channel').passed && byName(r, 'channel').required, 'both checks reported, both required');

// 2. invalid_grant
g = google({ token: { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } });
r = await probeYoutube({ ...creds, channelExternalId: CH, fetchImpl: g.fetchImpl, now: () => NOW });
check(!byName(r, 'credentials').passed && /^Refresh token revoked or expired \(7-day Testing expiry\)/.test(byName(r, 'credentials').detail),
  'invalid_grant → "Refresh token revoked or expired (7-day Testing expiry)"', byName(r, 'credentials').detail.slice(0, 70));
check(!byName(r, 'channel').passed && /Not attempted/.test(byName(r, 'channel').detail) && g.requests.length === 1, 'and the channel check is not attempted');
const tokenReq = g.requests[0];
const form = new URLSearchParams(tokenReq.body);
check(form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'rt' && form.get('client_id') === 'cid', 'the exchange sends the refresh token, client id and secret');

// 3. Other token failure
g = google({ token: { status: 401, body: { error: 'invalid_client' } } });
r = await probeYoutube({ ...creds, channelExternalId: CH, fetchImpl: g.fetchImpl, now: () => NOW });
check(!byName(r, 'credentials').passed && /token exchange failed \(http_401\)/.test(byName(r, 'credentials').detail), 'invalid_client → named as an exchange failure, not as expiry');

// 4. 200 with the Bureau channel id
g = google();
r = await probeYoutube({ ...creds, channelExternalId: CH, fetchImpl: g.fetchImpl, now: () => NOW });
const rep = g.requests.find((q) => q.url.hostname === 'youtubeanalytics.googleapis.com');
check(byName(r, 'credentials').passed && byName(r, 'channel').passed, 'token + 200 → both pass', byName(r, 'channel').detail);
check(rep?.url.searchParams.get('ids') === `channel==${CH}`, 'LOAD-BEARING: the query names the Bureau channel, not MINE', rep?.url.searchParams.get('ids'));
check(rep?.url.searchParams.get('startDate') === '2026-09-29' && rep?.url.searchParams.get('endDate') === '2026-10-06', 'over the last seven days');
check(rep?.headers.authorization === 'Bearer at-1', 'with the access token just minted');
check(neverWrites(g.requests), 'every request is the token exchange or an Analytics GET — no upload, no Data API');

// 5. 403 — a different channel
g = google({ report: { status: 403, body: { error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED' } } } });
r = await probeYoutube({ ...creds, channelExternalId: CH, fetchImpl: g.fetchImpl, now: () => NOW });
check(byName(r, 'credentials').passed && !byName(r, 'channel').passed && /^Token belongs to a different channel/.test(byName(r, 'channel').detail),
  '403 → "token belongs to a different channel", credentials still passed', byName(r, 'channel').detail.slice(0, 60));

// 6. 403 — missing scope
g = google({ report: { status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } } });
r = await probeYoutube({ ...creds, channelExternalId: CH, fetchImpl: g.fetchImpl, now: () => NOW });
check(!byName(r, 'channel').passed && /lacks the https:\/\/www.googleapis.com\/auth\/yt-analytics.readonly scope/.test(byName(r, 'channel').detail),
  '403 for scope → names the missing scope instead');

// 7. Other status
g = google({ report: { status: 500, body: { error: 'backend' } } });
r = await probeYoutube({ ...creds, channelExternalId: CH, fetchImpl: g.fetchImpl, now: () => NOW });
check(!byName(r, 'channel').passed && /Analytics query failed \(500\)/.test(byName(r, 'channel').detail), '500 → named as a failed query');

// 8. No external id → MINE, said so
g = google();
r = await probeYoutube({ ...creds, channelExternalId: null, fetchImpl: g.fetchImpl, now: () => NOW });
const mine = g.requests.find((q) => q.url.hostname === 'youtubeanalytics.googleapis.com');
check(mine?.url.searchParams.get('ids') === 'channel==MINE' && byName(r, 'channel').passed && /does not prove it is the right channel/.test(byName(r, 'channel').detail),
  'no external id → channel==MINE, and the pass says what it does not prove');

console.log(failures === 0 ? '\nYouTube probe: all checks passed.\n' : `\nYouTube probe: ${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
