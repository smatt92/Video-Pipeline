#!/usr/bin/env node
/**
 * The Bureau stages refuse an integration that has not verified — the same predicate the
 * Settings banner counts with (J's "Found on the way" #4; src/lib/integrations/state.ts).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   §1  The predicates' truth tables, and that `usability()` — the refusal — answers usable
 *       exactly when the banner's `hasVerified` says so, for every timestamp shape, read back
 *       from rows this harness wrote as INPUTS, never from a value it asserts on. Including
 *       the one case the pill and the refusal differ on: verified once, failed since.
 *   §2  `verifiedCredentials` refuses by name with the key PRESENT in the environment
 *       (written explicitly, deleted at the end — never `??=`), so the refusal can only be
 *       verification; and accepts, returning that key, once verified.
 *   §3  Dispatch, the consumer: `dispatchProvider` given the production `credentialsFor`
 *       refuses with the reason and never calls submit; verified, it does not refuse.
 *   §4  Embeddings, the consumer: `ledgeredEmbedder` refuses an unverified integration
 *       before the ledger row; verified, the key reaches the vendor call (a stub fetch).
 *
 *   §5  "Save and test" on YouTube end to end through `verifyIntegration`: the Analytics query
 *       names the Bureau channel row's external_id (set here as an input), two check rows are
 *       written, and a 403 leaves the integration unverified with the channel check naming why.
 *
 *   Voice and dubs are driven the same way inside verify:episode, where their worlds exist.
 *
 * DOES NOT PROVE: the Trigger tasks pass these functions in production (they do, one line
 * each — `21-gen-dispatch`, `20-episode`, `24-dubs`, and `effects.ts` for embeddings — but
 * no harness imports a task; see CLAUDE.md on refusals that live in tasks).
 *
 * Usage: node scripts/verify-integration-gate.mjs <db-url>
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-integration-gate.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { integrationState, hasVerified } = require(`${B}/integrations/state.js`);
const { usability, verifiedCredentials, verifyIntegration } = require(`${B}/integrations/verify.js`);
const { dispatchProvider } = require(`${B}/bureau/dispatch.js`);
const { ledgeredEmbedder } = require(`${B}/bureau/embed.js`);
const { BUREAU_CHANNEL_ID } = require(`${B}/bureau/bible.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};

const scratch = await scratchDatabase(dbUrl, 'intgate');
const client = scratch.client;
const db = supabaseShim(client);
const setTimes = (slug, checked, verified, error = null) =>
  client.query(
    `update integrations set is_enabled = true, last_checked_at = ${checked}, last_verified_at = ${verified}, last_error = $2 where slug = $1`,
    [slug, error],
  );
const realFetch = globalThis.fetch;

console.log('\nStages refuse an unverified integration — the banner\'s predicate\n');
try {
  // ═══ 1 ═══
  console.log('1. One predicate, the banner\'s and the refusal\'s\n');
  const t0 = '2026-10-01T00:00:00Z';
  const t1 = '2026-10-02T00:00:00Z';
  check(integrationState({ last_checked_at: null, last_verified_at: null }) === 'never_run', 'never checked → never_run');
  check(integrationState({ last_checked_at: t1, last_verified_at: null }) === 'failed', 'checked, never verified → failed');
  check(integrationState({ last_checked_at: t1, last_verified_at: t0 }) === 'failed', 'verified, then failed a later check → failed');
  check(integrationState({ last_checked_at: t0, last_verified_at: t1 }) === 'verified', 'latest check verified → verified');
  check(integrationState({ last_checked_at: null, last_verified_at: t0 }) === 'verified', 'verified with no checked time (pre-0007 rows) → verified');
  check(integrationState({ last_checked_at: new Date(t0), last_verified_at: t1 }) === 'verified', 'a Date and a string compare as instants');

  const cases = [
    ['null', 'null'],
    ["now()", 'null'],
    ["now()", "now() - interval '1 hour'"],
    ["now() - interval '1 second'", 'now()'],
    ['null', 'now()'],
  ];
  for (const [checked, verified] of cases) {
    await setTimes('runway', checked, verified);
    const row = (await client.query(`select last_checked_at, last_verified_at from integrations where slug = 'runway'`)).rows[0];
    const use = await usability(db, 'runway');
    check(use.usable === hasVerified(row), `checked=${checked}, verified=${verified}: pill ${integrationState(row)}, banner ${hasVerified(row) ? 'verified' : 'never verified'}, stage ${use.usable ? 'usable' : 'refused'}`);
  }

  // ═══ 2 ═══
  console.log('\n2. verifiedCredentials — key present, verification decides\n');
  process.env.RUNWAY_API_KEY = 'rk-from-env';
  process.env.GEMINI_API_KEY = 'gk-from-env';
  await setTimes('runway', 'null', 'null');
  let c = await verifiedCredentials(db, 'runway');
  check(!c.ok && c.code === 'integration_unverified' && /runway integration has never verified/.test(c.reason) && /Save and test/.test(c.reason),
    'never verified, key in the environment → refused by name, naming the click', c.ok ? 'accepted' : c.reason.slice(0, 80));
  await setTimes('runway', 'now()', 'null', 'HTTP 401: bad key');
  c = await verifiedCredentials(db, 'runway');
  check(!c.ok && /never verified/.test(c.reason) && /HTTP 401: bad key/.test(c.reason), 'tested and failed, never verified → refused, with the last error', c.ok ? 'accepted' : c.reason.slice(0, 80));
  await setTimes('runway', 'now()', "now() - interval '1 hour'", 'timeout');
  c = await verifiedCredentials(db, 'runway');
  check(c.ok, 'verified once, failed a re-test → still used (a re-test failure may be a blip; the banner says so)');
  await setTimes('runway', "now() - interval '1 second'", 'now()');
  c = await verifiedCredentials(db, 'runway');
  check(c.ok && c.values.RUNWAY_API_KEY === 'rk-from-env', 'verified → the environment key', c.ok ? 'ok' : c.reason);
  delete process.env.RUNWAY_API_KEY;
  c = await verifiedCredentials(db, 'runway');
  check(!c.ok && c.code === 'no_credential' && /RUNWAY_API_KEY/.test(c.reason), 'verified, key since removed → no_credential, by field name');
  process.env.RUNWAY_API_KEY = 'rk-from-env';

  // ═══ 3 ═══
  console.log('\n3. Dispatch refuses before the claim\n');
  const submits = [];
  const deps = (log) => ({
    db, worker: 'gate', usdInrRate: 88,
    credentialsFor: (p) => verifiedCredentials(db, p),
    submit: async (i) => { submits.push(i); return { ok: false, code: 'x', detail: 'x' }; },
    poll: async () => ({ state: 'running', vendorState: 'x' }),
    ingest: async () => ({ ok: false, code: 'x', detail: 'x' }),
    log,
  });
  await setTimes('runway', 'null', 'null');
  const errors = [];
  const refused = await dispatchProvider('runway', 5, deps({ info() {}, error: (m, d) => errors.push(d) }));
  check(/^integration_unverified: The runway integration has never verified/.test(refused.refused ?? '') && refused.claimed === 0,
    'unverified → refused with the reason, nothing claimed', refused.refused?.slice(0, 80));
  check(submits.length === 0 && errors[0]?.code === 'integration_unverified', 'submit never called; the refusal is logged by code');
  await setTimes('runway', "now() - interval '1 second'", 'now()');
  const accepted = await dispatchProvider('runway', 5, deps({ info() {}, error() {} }));
  check(accepted.refused === undefined, 'verified → dispatch proceeds to the claim', JSON.stringify(accepted));

  // ═══ 4 ═══
  console.log('\n4. Embeddings refuse before the ledger row\n');
  const ledger = async () => Number((await client.query(`select count(*) n from cost_ledger where stage = '20-embed'`)).rows[0].n);
  await setTimes('gemini', 'null', 'null');
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push({ url: String(url), headers: init?.headers });
    return new Response(JSON.stringify({ embeddings: [{ values: new Array(768).fill(0.01) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const before = await ledger();
  const embed = ledgeredEmbedder(db, BUREAU_CHANNEL_ID, 88);
  const e1 = await embed(['a premise']);
  check(!e1.ok && /gemini integration has never verified/.test(e1.detail), 'unverified → refused by name', e1.ok ? 'embedded' : e1.detail.slice(0, 80));
  check((await ledger()) === before && fetched.length === 0, 'no ledger row, no vendor call');
  await setTimes('gemini', "now() - interval '1 second'", 'now()');
  await embed(['a premise']);
  const sentKey = fetched.some((f) => f.url.includes('gk-from-env') || JSON.stringify(f.headers ?? {}).includes('gk-from-env'));
  check(fetched.length > 0 && sentKey, 'verified → the environment key reaches the vendor call', `${fetched.length} call(s)`);
  check((await ledger()) === before + 1, 'and its ledger row was written first');

  // ═══ 5 ═══
  console.log('\n5. YouTube "Save and test" through verifyIntegration\n');
  const CH = 'UCsAOylowJKXg7TENr5GskGQ';
  await client.query('update channels set external_id = $1 where id = $2', [CH, BUREAU_CHANNEL_ID]);
  process.env.YOUTUBE_CLIENT_ID = 'cid';
  process.env.YOUTUBE_CLIENT_SECRET = 'csec';
  process.env.YOUTUBE_REFRESH_TOKEN = 'rt';
  let reportStatus = 200;
  const yt = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    yt.push({ u, method: (init?.method ?? 'GET').toUpperCase() });
    if (u.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), { status: 200 });
    if (u.hostname === 'youtubeanalytics.googleapis.com') {
      return reportStatus === 200
        ? new Response(JSON.stringify({ columnHeaders: [{ name: 'views' }], rows: [[3]] }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 403, message: 'Forbidden' } }), { status: 403 });
    }
    return new Response('{}', { status: 599 });
  };
  await client.query(`update integrations set last_checked_at = null, last_verified_at = null, last_error = null where slug = 'youtube'`);
  const ok = await verifyIntegration(db, 'youtube');
  const report = yt.find((x) => x.u.hostname === 'youtubeanalytics.googleapis.com');
  check(ok.ok && report?.u.searchParams.get('ids') === `channel==${CH}`, 'LOAD-BEARING: verified, and the query named the Bureau channel row\'s external_id', report?.u.searchParams.get('ids'));
  const rows = (await client.query(`select check_name, passed from integration_checks c join integrations i on i.id = c.integration_id where i.slug = 'youtube' order by check_name`)).rows;
  check(JSON.stringify(rows.map((x) => [x.check_name, x.passed])) === '[["channel",true],["credentials",true]]', 'two check rows: credentials and channel', JSON.stringify(rows));
  check(yt.every((x) => x.u.hostname !== 'www.googleapis.com'), 'no Data API or upload host was called');
  // What rotateIntegration does on success, and only then.
  await client.query(`update integrations set is_enabled = true where slug = 'youtube'`);
  check((await usability(db, 'youtube')).usable, 'and the stages now see it as verified');
  reportStatus = 403;
  const wrong = await verifyIntegration(db, 'youtube');
  const after = (await client.query(`select passed, detail from integration_checks c join integrations i on i.id = c.integration_id where i.slug = 'youtube' and check_name = 'channel'`)).rows[0];
  check(!wrong.ok && !after.passed && /^Token belongs to a different channel/.test(after.detail), 'a 403 → not verified; the channel check names a different channel', after.detail.slice(0, 60));
  const ytRow = (await client.query(`select last_checked_at, last_verified_at from integrations where slug = 'youtube'`)).rows[0];
  check(integrationState(ytRow) === 'failed', 'the pill shows failed — a green tick over a check that just failed would be a lie');
} catch (err) {
  check(false, 'harness threw', err.stack ?? err.message);
} finally {
  globalThis.fetch = realFetch;
  delete process.env.YOUTUBE_CLIENT_ID;
  delete process.env.YOUTUBE_CLIENT_SECRET;
  delete process.env.YOUTUBE_REFRESH_TOKEN;
  delete process.env.RUNWAY_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await scratch.release();
}

console.log(failures === 0 ? '\nIntegration gate: all checks passed.\n' : `\nIntegration gate: ${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
