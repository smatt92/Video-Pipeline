#!/usr/bin/env node
/**
 * OAuth 2.1 for /api/mcp, over real HTTP (decision 0016).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Discovery the way a connector walks it: an unauthenticated POST to /api/mcp answers 401
 *   with WWW-Authenticate naming the protected-resource metadata, which names this origin as
 *   the authorization server, whose RFC 8414 document names the endpoints, S256 only, and
 *   metadata-document clients.
 *
 *   The whole authorization-code + PKCE flow, both client types (Dynamic Client Registration
 *   and a Client ID Metadata Document), ending in MCP calls made with the issued token —
 *   driven through the SAME `serveOAuth` and `serveMcp` the Next routes call, behind a
 *   `node:http` socket, against a real Postgres with every migration applied.
 *
 *   The refusals the prompt names, each by its named error: a redirect URI off Claude's
 *   callback list (at registration, in a metadata document, and at authorize — never
 *   redirected); a replayed code (refused, and the connection it minted revoked); a revoked
 *   connection (refused on the next MCP call, and on refresh); an agent-scoped OAuth token
 *   on brief_approve (refused in TypeScript, and by the database when TypeScript is skipped).
 *   Plus refresh rotation and replay, expiry, plain PKCE, a wrong verifier, and Deny.
 *
 *   Static kb_ tokens are unchanged: kind static, no expiry, same surface.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES NOT PROVE — read this before calling the connector verified
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   That Claude's connector client completes this handshake. Its exact requests (which
 *   discovery URLs it tries first, whether it sends `resource`, its client_id metadata URL,
 *   its callback host) are read from the MCP authorization spec, not observed. 0008 §16 says
 *   what Sahil will see when he connects, which is the only proof available.
 *
 *   The consent screen's session check. The harness stands in for the signed-in owner: its
 *   /oauth/authorize handler calls `checkAuthorize` and `decideConsent` exactly as page.tsx
 *   and actions.ts do, minus `getUser()` + ALLOWED_EMAIL, which need a Supabase auth server.
 *   The middleware keeping that page behind sign-in is covered by verify:public.
 *
 * Usage: node scripts/verify-oauth.mjs <db-url>
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-oauth.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { serveMcp } = require(`${BUILD}/studio/serve.js`);
const { serveOAuth } = require(`${BUILD}/oauth/endpoints.js`);
const { authorizeParamsFrom, checkAuthorize, decideConsent } = require(`${BUILD}/oauth/flow.js`);
const { resourceMetadataUrlFor, ALLOWED_REDIRECT_URIS, ACCESS_TOKEN_TTL_S } = require(`${BUILD}/oauth/policy.js`);
const { mintBureauToken, revokeBureauToken, hashToken } = require(`${BUILD}/bureau/tokens.js`);
const { BUREAU_CHANNEL_ID } = require(`${BUILD}/bureau/bible.js`);

const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};
const check = (cond, label, detail = '') => (cond ? ok(label, detail) : bad(label, detail));

const scratch = await scratchDatabase(dbUrl, 'oauth');
const client = scratch.client;
const db = supabaseShim(client);
const count = async (sql, params = []) => Number((await client.query(sql, params)).rows[0].n);

// ── The one metadata document the stub serves, and a record of what was fetched ──
const CIMD_ID = 'https://claude.ai/oauth/verify-client-metadata';
const CIMD_BAD_ID = 'https://claude.ai/oauth/verify-evil-metadata';
const CALLBACK = ALLOWED_REDIRECT_URIS[0];
const fetched = [];
async function fetchDocument(url) {
  fetched.push(url);
  if (url === CIMD_ID) return { client_id: CIMD_ID, client_name: 'Claude', redirect_uris: [...ALLOWED_REDIRECT_URIS] };
  if (url === CIMD_BAD_ID) return { client_id: CIMD_BAD_ID, client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] };
  throw new Error('HTTP 404');
}

// The signed-in owner the harness stands in for (see DOES NOT PROVE).
const { rows: prof } = await client.query(
  `insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'sahil@invalid.test', 88) returning id`,
);
const OWNER = prof[0].id;

// ── The server: the shipped handlers behind one socket ─────────────────────────
let ORIGIN = '';
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, ORIGIN);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === null ? '' : JSON.stringify(body));
    };
    try {
      if (url.pathname === '/api/mcp') {
        let body = null;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return send(400, { error: 'not json' });
        }
        const r = await serveMcp(
          { authorization: req.headers.authorization ?? null, body },
          { db, secret: undefined, resourceMetadataUrl: resourceMetadataUrlFor(ORIGIN) },
        );
        return send(r.status, r.body, r.headers ?? {});
      }
      if (url.pathname === '/oauth/authorize') {
        // page.tsx (GET) and actions.ts (POST), minus the session check.
        const source = req.method === 'POST' ? new URLSearchParams(rawBody) : url.searchParams;
        const params = authorizeParamsFrom((n) => source.get(n));
        const c = await checkAuthorize(db, params, ORIGIN, fetchDocument);
        if (!c.ok) {
          return c.redirectTo
            ? send(302, null, { location: c.redirectTo })
            : send(400, { refused: c.error.kiln, detail: c.error.description });
        }
        if (req.method === 'GET') {
          return send(200, {
            client_name: c.request.client.clientName,
            client_id: c.request.client.clientId,
            redirect_uri: c.request.redirectUri,
            suggested_scope: c.request.suggestedScope,
          });
        }
        const location = await decideConsent(db, {
          request: c.request,
          approve: source.get('decision') === 'approve',
          scope: source.get('grant_scope') ?? '',
          profileId: OWNER,
          channelId: BUREAU_CHANNEL_ID,
          origin: ORIGIN,
        });
        return send(302, null, { location });
      }
      const r = await serveOAuth(
        {
          method: req.method,
          path: url.pathname,
          origin: ORIGIN,
          contentType: req.headers['content-type'] ?? null,
          authorization: req.headers.authorization ?? null,
          rawBody,
        },
        { db, fetchDocument },
      );
      return send(r.status, r.body, r.headers);
    } catch (err) {
      send(500, { error: err.message });
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
ORIGIN = `http://127.0.0.1:${server.address().port}`;
const MCP = `${ORIGIN}/api/mcp`;

// ── Client helpers: what a connector does ──────────────────────────────────────
async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}
async function postForm(path, fields) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
async function rpc(method, params, token) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
function authorizeQuery(clientId, challenge, extra = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: `st-${randomBytes(6).toString('hex')}`,
    resource: MCP,
    ...extra,
  });
}
async function authorizeGet(q) {
  const res = await fetch(`${ORIGIN}/oauth/authorize?${q}`, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), body: text ? JSON.parse(text) : null };
}
/** Consent: press a button. Returns the parsed redirect. */
async function consent(q, decision, scope) {
  const fields = Object.fromEntries(q);
  const r = await postForm('/oauth/authorize', { ...fields, decision, grant_scope: scope });
  return { status: r.status, location: r.headers.get('location') ? new URL(r.headers.get('location')) : null };
}
/** The whole flow for one client and scope. */
async function connect(clientId, scope) {
  const { verifier, challenge } = pkce();
  const q = authorizeQuery(clientId, challenge);
  const back = await consent(q, 'approve', scope);
  const code = back.location?.searchParams.get('code');
  const tok = await postForm('/api/oauth/token', {
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: clientId, resource: MCP,
  });
  return { code, verifier, q, back, tok };
}
const grantOf = async (access) =>
  (await client.query('select * from mcp_tokens where token_hash = $1', [hashToken(access)])).rows[0];

console.log('\nOAuth 2.1 for /api/mcp, over real HTTP\n');

try {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('0. Discovery, the way a connector walks it\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const unauth = await rpc('initialize', { protocolVersion: '2025-06-18' }, null);
  const www = unauth.headers.get('www-authenticate') ?? '';
  check(unauth.status === 401, 'POST /api/mcp with no token → 401', String(unauth.status));
  const prmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  check(prmUrl === `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`, 'WWW-Authenticate names the protected-resource metadata', www);
  check(!/invalid_token/.test(www), 'and does not call a missing token invalid');
  const prm = await getJson(prmUrl);
  check(prm.status === 200 && prm.body.resource === MCP, 'the metadata names /api/mcp as the resource', prm.body?.resource);
  check(JSON.stringify(prm.body.authorization_servers) === JSON.stringify([ORIGIN]), 'and this origin as its authorization server');
  const prmRoot = await getJson(`${ORIGIN}/.well-known/oauth-protected-resource`);
  check(prmRoot.status === 200 && prmRoot.body.resource === MCP, 'the root well-known path serves the same document');
  const asm = await getJson(`${ORIGIN}/.well-known/oauth-authorization-server`);
  check(asm.status === 200 && asm.body.issuer === ORIGIN, 'RFC 8414 metadata: issuer is the origin', asm.body?.issuer);
  check(JSON.stringify(asm.body.code_challenge_methods_supported) === '["S256"]', 'PKCE: S256 and nothing else');
  check(asm.body.client_id_metadata_document_supported === true, 'metadata-document clients advertised');
  check(asm.body.registration_endpoint === `${ORIGIN}/api/oauth/register`, 'DCR endpoint advertised');
  check(asm.body.authorization_endpoint === `${ORIGIN}/oauth/authorize` && asm.body.token_endpoint === `${ORIGIN}/api/oauth/token`,
    'authorize and token endpoints');
  check(JSON.stringify(asm.body.grant_types_supported) === '["authorization_code","refresh_token"]', 'code and refresh grants only');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n1. Dynamic Client Registration\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const reg = await fetch(`${ORIGIN}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'client_secret_post' }),
  });
  const regBody = await reg.json();
  const DCR_ID = regBody.client_id;
  check(reg.status === 201 && /^kiln_dcr_/.test(DCR_ID ?? ''), 'a client with Claude\'s callback registers', DCR_ID);
  check(regBody.token_endpoint_auth_method === 'none' && regBody.client_secret === undefined, 'public client: no secret, auth method none');
  const clientsBefore = await count('select count(*) n from oauth_clients');
  const evilReg = await fetch(`${ORIGIN}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Evil', redirect_uris: [CALLBACK, 'https://evil.example/cb'] }),
  });
  const evilBody = await evilReg.json();
  check(evilReg.status === 400 && evilBody.error === 'invalid_redirect_uri' && /^redirect_uri_not_allowed:/.test(evilBody.error_description),
    'a registration listing a non-Claude callback is refused by name', evilBody.error_description);
  check((await count('select count(*) n from oauth_clients')) === clientsBefore, 'and stores nothing');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n2. Authorize refusals\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const p0 = pkce();
  const wrongRedirect = await authorizeGet(authorizeQuery(DCR_ID, p0.challenge, { redirect_uri: 'https://evil.example/cb' }));
  check(wrongRedirect.status === 400 && wrongRedirect.location === null, 'a wrong redirect_uri is refused on the page, not redirected',
    wrongRedirect.body?.detail);
  check(wrongRedirect.body?.refused === 'redirect_uri_not_registered', 'named redirect_uri_not_registered');
  const badDoc = await authorizeGet(authorizeQuery(CIMD_BAD_ID, p0.challenge, { redirect_uri: 'https://evil.example/cb' }));
  check(badDoc.status === 400 && badDoc.body?.refused === 'redirect_uri_not_allowed',
    'a metadata document listing a non-Claude callback is refused by name', badDoc.body?.detail);
  const fetchedBefore = fetched.length;
  const offHost = await authorizeGet(authorizeQuery('https://evil.example/client.json', p0.challenge));
  check(offHost.status === 400 && offHost.body?.refused === 'client_host_not_allowed', 'a metadata document off Claude\'s hosts is refused');
  check(fetched.length === fetchedBefore, 'without being fetched');
  const unknownClient = await authorizeGet(authorizeQuery('kiln_dcr_nope', p0.challenge));
  check(unknownClient.status === 400 && unknownClient.body?.refused === 'client_unknown', 'an unregistered client_id is refused');
  const plain = await authorizeGet(authorizeQuery(DCR_ID, p0.challenge, { code_challenge_method: 'plain' }));
  const plainLoc = plain.location ? new URL(plain.location) : null;
  check(plain.status === 302 && plainLoc?.origin + plainLoc?.pathname === CALLBACK && plainLoc?.searchParams.get('error') === 'invalid_request',
    'plain PKCE goes back to the client as error=invalid_request', plainLoc?.searchParams.get('error_description'));
  check(/^pkce_method_not_s256/.test(plainLoc?.searchParams.get('error_description') ?? '') && plainLoc?.searchParams.get('state')?.startsWith('st-'),
    'named, with state echoed');
  const noChallenge = await authorizeGet((() => { const q = authorizeQuery(DCR_ID, p0.challenge); q.delete('code_challenge'); return q; })());
  check(new URL(noChallenge.location ?? 'x:/').searchParams.get('error_description')?.startsWith('pkce_required'), 'no code_challenge → pkce_required');
  const wrongResource = await authorizeGet(authorizeQuery(DCR_ID, p0.challenge, { resource: 'https://elsewhere.example/mcp' }));
  check(new URL(wrongResource.location ?? 'x:/').searchParams.get('error') === 'invalid_target', 'a resource that is not this /api/mcp → invalid_target');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n3. Code + PKCE, end to end (DCR client, approver)\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const p1 = pkce();
  const q1 = authorizeQuery(DCR_ID, p1.challenge);
  const view = await authorizeGet(q1);
  check(view.status === 200 && view.body.client_name === 'Claude' && view.body.redirect_uri === CALLBACK,
    'the consent view shows the client name and redirect URI', `${view.body?.client_name} → ${view.body?.redirect_uri}`);
  check(view.body.suggested_scope === 'approver', 'approver is preselected');
  const back1 = await consent(q1, 'approve', 'approver');
  const code1 = back1.location?.searchParams.get('code');
  check(back1.status === 302 && `${back1.location.origin}${back1.location.pathname}` === CALLBACK && !!code1,
    'Approve redirects to Claude\'s callback with a code');
  check(back1.location.searchParams.get('state') === q1.get('state') && back1.location.searchParams.get('iss') === ORIGIN, 'state echoed, iss is the issuer');
  const codeRow = (await client.query('select * from oauth_codes where code_hash = $1', [hashToken(code1)])).rows[0];
  check(!!codeRow && codeRow.profile_id === OWNER && codeRow.scope === 'approver', 'the code is stored hashed, naming the owner and scope');

  const wrongVerifier = await postForm('/api/oauth/token', {
    grant_type: 'authorization_code', code: code1, code_verifier: pkce().verifier, redirect_uri: CALLBACK, client_id: DCR_ID,
  });
  check(wrongVerifier.status === 400 && /^pkce_mismatch/.test(wrongVerifier.body.error_description), 'a wrong code_verifier → pkce_mismatch',
    wrongVerifier.body?.error_description);
  // A failed exchange consumed the code (single use is strict). Start again.
  const p2 = pkce();
  const q2 = authorizeQuery(DCR_ID, p2.challenge);
  const code2 = (await consent(q2, 'approve', 'approver')).location.searchParams.get('code');
  const wrongCallback = await postForm('/api/oauth/token', {
    grant_type: 'authorization_code', code: code2, code_verifier: p2.verifier, redirect_uri: ALLOWED_REDIRECT_URIS[1], client_id: DCR_ID,
  });
  check(wrongCallback.status === 400 && /^redirect_uri_mismatch/.test(wrongCallback.body.error_description), 'a different redirect_uri at the token endpoint → redirect_uri_mismatch');

  const main = await connect(DCR_ID, 'approver');
  const tok = main.tok.body;
  check(main.tok.status === 200 && /^kb_oa_/.test(tok.access_token) && /^kbr_/.test(tok.refresh_token), 'the exchange issues an access and a refresh token',
    `${tok.access_token?.slice(0, 6)}… / ${tok.refresh_token?.slice(0, 4)}…`);
  check(tok.token_type === 'Bearer' && tok.expires_in === ACCESS_TOKEN_TTL_S && tok.scope === 'approver', 'Bearer, one hour, scope approver');
  check(main.tok.headers.get('cache-control') === 'no-store', 'the token response is no-store');
  const g = await grantOf(tok.access_token);
  check(!!g && g.kind === 'oauth' && g.scope === 'approver' && g.profile_id === OWNER && g.channel_id === BUREAU_CHANNEL_ID,
    'it is an mcp_tokens row: kind oauth, same scope, person and channel columns');
  const ttl = (new Date(g.expires_at).getTime() - Date.now()) / 1000;
  check(ttl > ACCESS_TOKEN_TTL_S - 60 && ttl <= ACCESS_TOKEN_TTL_S, 'short-lived: expires in an hour', `${Math.round(ttl)}s`);
  check(g.token_hash === createHash('sha256').update(tok.access_token).digest('hex'), 'only the SHA-256 of the access token is stored');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, tok.access_token);
  check(init.status === 200 && init.body.result.serverInfo.name === 'kiln-bureau', 'the access token opens the Bureau surface over MCP');
  const tools = (await rpc('tools/list', {}, tok.access_token)).body.result.tools.map((t) => t.name);
  check(tools.includes('brief_approve'), 'an approver connection sees brief_approve', `${tools.length} tools`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n4. A replayed code\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const replay = await postForm('/api/oauth/token', {
    grant_type: 'authorization_code', code: main.code, code_verifier: main.verifier, redirect_uri: CALLBACK, client_id: DCR_ID,
  });
  check(replay.status === 400 && replay.body.error === 'invalid_grant' && /^code_replayed/.test(replay.body.error_description),
    'the same code a second time → invalid_grant code_replayed', replay.body?.error_description);
  check((await client.query('select revoked_at from mcp_tokens where id = $1', [g.id])).rows[0].revoked_at !== null,
    'and the connection it minted is revoked');
  const afterReplay = await rpc('tools/list', {}, tok.access_token);
  check(afterReplay.status === 401 && /invalid_token/.test(afterReplay.headers.get('www-authenticate') ?? ''),
    'its access token is refused on the next call, as invalid_token');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n5. Refresh, with rotation (metadata-document client)\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const cimd = await connect(CIMD_ID, 'approver');
  check(cimd.tok.status === 200 && fetched.includes(CIMD_ID), 'a Client ID Metadata Document client completes the flow', CIMD_ID);
  const cg = await grantOf(cimd.tok.body.access_token);
  const grantsBefore = await count('select count(*) n from mcp_tokens');
  const r1 = await postForm('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: cimd.tok.body.refresh_token, client_id: CIMD_ID });
  check(r1.status === 200 && r1.body.access_token !== cimd.tok.body.access_token && r1.body.refresh_token !== cimd.tok.body.refresh_token,
    'refresh issues a new access token and a new refresh token');
  check((await count('select count(*) n from mcp_tokens')) === grantsBefore && (await grantOf(r1.body.access_token))?.id === cg.id,
    'on the same mcp_tokens row (one connection, one row to revoke)');
  check((await rpc('tools/list', {}, cimd.tok.body.access_token)).status === 401, 'the previous access token stops working');
  check((await rpc('tools/list', {}, r1.body.access_token)).status === 200, 'the new one works');
  const reuse = await postForm('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: cimd.tok.body.refresh_token, client_id: CIMD_ID });
  check(reuse.status === 400 && /^refresh_token_replayed/.test(reuse.body.error_description), 'a rotated refresh token presented again → refresh_token_replayed');
  check((await rpc('tools/list', {}, r1.body.access_token)).status === 401, 'and the whole connection is revoked, including the newest access token');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n6. Revoked on Settings → MCP tokens\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const rv = await connect(DCR_ID, 'approver');
  check((await rpc('tools/list', {}, rv.tok.body.access_token)).status === 200, 'a fresh connection works');
  await revokeBureauToken(db, (await grantOf(rv.tok.body.access_token)).id); // what the Revoke button calls
  const afterRevoke = await rpc('tools/list', {}, rv.tok.body.access_token);
  check(afterRevoke.status === 401, 'revoked → the next MCP call is refused', String(afterRevoke.status));
  const refreshRevoked = await postForm('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: rv.tok.body.refresh_token, client_id: DCR_ID });
  check(refreshRevoked.status === 400 && /^grant_revoked/.test(refreshRevoked.body.error_description), 'and refreshing it is refused: grant_revoked');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n7. An agent-scoped OAuth connection cannot decide\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const ag = await connect(CIMD_ID, 'agent');
  check(ag.tok.status === 200 && /^kb_og_/.test(ag.tok.body.access_token) && ag.tok.body.scope === 'agent', 'consent with scope agent issues an agent token');
  const agGrant = await grantOf(ag.tok.body.access_token);
  const agTools = (await rpc('tools/list', {}, ag.tok.body.access_token)).body.result.tools.map((t) => t.name);
  check(!agTools.includes('brief_approve') && agTools.length > 0, 'tools/list hides brief_approve from it', `${agTools.length} tools`);
  const logBefore = await count('select count(*) n from authorship_log');
  const approve = await rpc('tools/call', { name: 'brief_approve', arguments: { id: randomUUID(), punchline: 'A' } }, ag.tok.body.access_token);
  const sc = approve.body?.result?.structuredContent;
  check(sc?.refused === true && sc?.blockers?.[0]?.code === 'scope_denied', 'brief_approve with an agent OAuth token → scope_denied', sc?.blockers?.[0]?.code);
  check((await count('select count(*) n from authorship_log')) === logBefore, 'nothing written');
  // LOAD-BEARING: the database refuses the same row id when the TypeScript is skipped.
  let raised = null;
  try {
    await client.query(`select bureau_brief_approve($1, $2, 'x', 'A', '{}'::jsonb)`, [agGrant.id, randomUUID()]);
  } catch (err) {
    raised = err.message;
  }
  check(/scope_denied/.test(raised ?? ''), 'the database itself refuses bureau_brief_approve for the agent connection', raised ?? 'it ran');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n8. Expiry\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const ex = await connect(DCR_ID, 'approver');
  const exGrant = await grantOf(ex.tok.body.access_token);
  await client.query(`update mcp_tokens set expires_at = now() - interval '1 second' where id = $1`, [exGrant.id]);
  const expired = await rpc('tools/list', {}, ex.tok.body.access_token);
  check(expired.status === 401 && /invalid_token/.test(expired.headers.get('www-authenticate') ?? ''), 'an expired access token → 401 invalid_token');
  raised = null;
  try {
    await client.query(`select bureau_require_scope($1, 'approver')`, [exGrant.id]);
  } catch (err) {
    raised = err.message;
  }
  check(/expired/.test(raised ?? ''), 'and the database\'s scope check refuses it too', raised ?? 'it passed');
  const revived = await postForm('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: ex.tok.body.refresh_token, client_id: DCR_ID });
  check(revived.status === 200 && (await rpc('tools/list', {}, revived.body.access_token)).status === 200, 'refreshing brings it back');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n9. Deny, and the token endpoint\'s edges\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const codesBefore = await count('select count(*) n from oauth_codes');
  const pd = pkce();
  const denied = await consent(authorizeQuery(DCR_ID, pd.challenge), 'deny', 'approver');
  check(denied.location?.searchParams.get('error') === 'access_denied' && !denied.location?.searchParams.get('code'), 'Deny → error=access_denied, no code');
  check((await count('select count(*) n from oauth_codes')) === codesBefore, 'and no code row exists');
  const badGrant = await postForm('/api/oauth/token', { grant_type: 'password', username: 'x', password: 'y' });
  check(badGrant.status === 400 && badGrant.body.error === 'unsupported_grant_type', 'grant_type password → unsupported_grant_type');
  const refreshAsBearer = await rpc('tools/list', {}, revived.body.refresh_token);
  check(refreshAsBearer.status === 401 && /invalid_token/.test(refreshAsBearer.headers.get('www-authenticate') ?? ''),
    'a refresh token is not accepted as a bearer: 401 invalid_token', String(refreshAsBearer.status));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n10. Static kb_ tokens, unchanged\n');
  // ═══════════════════════════════════════════════════════════════════════════
  const stat = await mintBureauToken(db, { name: 'Routine', scope: 'agent', channelId: BUREAU_CHANNEL_ID, profileId: null });
  const statRow = (await client.query('select kind, expires_at from mcp_tokens where id = $1', [stat.id])).rows[0];
  check(/^kb_g_/.test(stat.plaintext) && statRow.kind === 'static' && statRow.expires_at === null, 'a minted token is kind static with no expiry');
  check((await rpc('tools/list', {}, stat.plaintext)).status === 200, 'and still opens the Bureau surface');
  const statApprove = await rpc('tools/call', { name: 'brief_approve', arguments: { id: randomUUID(), punchline: 'A' } }, stat.plaintext);
  check(statApprove.body?.result?.structuredContent?.blockers?.[0]?.code === 'scope_denied', 'and an agent static token still cannot approve');
  let shapeRefused = false;
  try {
    await client.query(`update mcp_tokens set expires_at = now() where id = $1`, [stat.id]);
  } catch {
    shapeRefused = true;
  }
  check(shapeRefused, 'the database refuses an expiry on a static token (mcp_tokens_kind_shape)');
} catch (err) {
  bad('harness threw', err.stack ?? err.message);
} finally {
  server.close();
  await scratch.release();
}

console.log(failures === 0 ? '\nOAuth: all checks passed.\n' : `\nOAuth: ${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
