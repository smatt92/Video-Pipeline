#!/usr/bin/env node
/**
 * The generation callback, over real HTTP, against real Postgres.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The gap this closes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 0008 §5b: the SQL underneath this endpoint was proven — `confirm_generation_once`
 * returned false to a replayed hostile payload and the row did not move — while everything
 * *above* the SQL was read off the generated types. The RPC argument names, the
 * `Array.isArray` unwrap of a table-returning function, whether a scalar boolean arrives as
 * `data === true`: all inferred, none observed.
 *
 * That is a bad thing to be wrong about. The failure mode is safe rather than silent — the
 * route logs `confirmation_failed` and returns 202 — but it means *no generation ever
 * confirms*, and it would be discovered at Gate 4, after a real generation had been paid
 * for, on the one path where a webhook cannot simply be re-run by hand.
 *
 * PROVES:  the secret gate (unset → 503, absent → 401, wrong → 401, wrong length → 401);
 *          the payload gate (malformed → 400, no job id → 400, all three id spellings
 *          accepted); the `record_webhook_delivery` RPC returning the shape the code
 *          unwraps; a first delivery confirming a generation and writing its asset; a
 *          replay carrying a hostile payload changing nothing; the delivery counter and
 *          `v_replayed_callbacks`; an unknown job refused before any outbound request; and
 *          a vendor that disagrees with the callback winning.
 *
 * DOES NOT: prove that the real vendor's status endpoint returns the shape the stub
 *           returns. That is the one thing left, and it is Gate 4.
 *
 * ── The stub is a real server, not a mock ───────────────────────────────────
 *
 * `HIGGSFIELD_API_BASE_URL` is pointed at a local HTTP server for the duration. The driver
 * builds its own URL, makes its own request, and parses the response with its own Zod
 * schema — none of that is stubbed. What the stub replaces is the far end of a socket,
 * which is the only part a vendor account would change.
 *
 * That matters for the disagreement case: the callback says one thing, the status endpoint
 * says another, and the endpoint is supposed to win. A mocked driver could not test that at
 * all, because the whole assertion is about which source the code believes.
 *
 * Usage: node scripts/verify-webhook.mjs <db-url>
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-webhook.mjs <db-url>');
  process.exit(2);
}

const SECRET = 'a-shared-secret-of-at-least-32-characters';
const HEADER = 'x-higgsfield-secret';

// ── The stub vendor ─────────────────────────────────────────────────────────
//
// Started before the driver module is imported, because the base URL is read from the
// environment at module load.
// The documented shape, which is to say the shape the driver's own Zod schema accepts.
// Getting this wrong is not a harness detail: a stub that returns something the driver
// rejects tests the rejection path and calls it the success path.
const completed = (url) => ({
  status: 'completed',
  jobs: [{ status: 'completed', results: { raw: { url } } }],
});
const failed = (error) => ({ status: 'failed', error, jobs: [{ status: 'failed' }] });

let vendorReply = completed('https://example.invalid/clip.mp4');
let vendorHits = 0;

const vendor = createServer((req, res) => {
  vendorHits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(vendorReply));
});
await new Promise((r) => vendor.listen(0, '127.0.0.1', r));
const vendorPort = vendor.address().port;

process.env.HIGGSFIELD_API_BASE_URL = `http://127.0.0.1:${vendorPort}`;
process.env.HIGGSFIELD_WEBHOOK_SECRET = SECRET;
process.env.HIGGSFIELD_API_KEY ??= 'stub-key';
process.env.HIGGSFIELD_API_SECRET ??= 'stub-secret';
process.env.USD_INR_RATE ??= '88.5';

// The rest of the environment `src/lib/env.ts` insists on. None of it is reached — the
// database comes in as an argument and no Supabase client is constructed — but the module
// validates the whole set at import, which is the right behaviour for a deployment and
// simply has to be satisfied here.
process.env.APP_URL ??= 'http://127.0.0.1:0';
process.env.ALLOWED_EMAIL ??= 'harness@invalid.test';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://harness.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'harness';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { handleCallback } = require(`${BUILD}/generate/webhook.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const scratch = await scratchDatabase(dbUrl, 'webhook');
const client = scratch.client;
const db = supabaseShim(client);

// ── The endpoint, over real HTTP ────────────────────────────────────────────
//
// Not called as a function. A fetch, a socket, a real request object — because the header
// lookup and the raw-body read are part of what is being checked, and calling the handler
// directly would skip exactly the layer that has never run.
let expectedSecret = SECRET;

const app = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const result = await handleCallback(db, expectedSecret, {
    presentedSecret: req.headers[HEADER] ?? null,
    rawBody: Buffer.concat(chunks).toString('utf8'),
  });
  res.writeHead(result.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result.body));
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const appPort = app.address().port;
const URL_ = `http://127.0.0.1:${appPort}/api/webhooks/higgsfield`;

async function post(body, { secret = SECRET, raw = null } = {}) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { [HEADER]: secret }),
    },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// One channel for every generation this file makes. A channel per concept would be
// modelling the harness rather than the pipeline.
const channelId = randomUUID();
await client.query(
  `insert into channels (id, name, platform, niche)
   values ($1, 'verify-webhook', 'youtube', 'verification')`,
  [channelId],
);

async function seedGeneration(jobId, { status = 'queued' } = {}) {
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  const shotId = randomUUID();
  const generationId = randomUUID();

  await client.query(
    `insert into concepts (id, channel_id, title, angle, rubric_version, status)
     values ($1, $2, $3, $4, 'v1', 'in_production')`,
    [conceptId, channelId, 'Webhook harness', 'proving the callback'],
  );
  await client.query(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1, $2, 'a hook', '[]', 'some voiceover', 'claude-opus-5', $3)`,
    [scriptId, conceptId, `verify-webhook-${jobId}`],
  );
  await client.query(
    `insert into shots (id, script_id, idx, shot_kind, description, duration_s)
     values ($1, $2, 0, 'establishing', 'a shot', 4)`,
    [shotId, scriptId],
  );
  await client.query(
    `insert into generations (id, shot_id, kind, status, external_job_id, driver, model,
                              idempotency_key, request_payload)
     values ($1, $2, 'video', $3, $4, 'higgsfield', 'stub-model', $5, '{}'::jsonb)`,
    [generationId, shotId, status, jobId, `key-${jobId}`],
  );
  return { generationId, shotId, scriptId };
}

console.log('\nThe generation callback\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. The secret is the whole of the authentication\n');
{
  expectedSecret = null;
  const unset = await post({ id: 'anything' });
  if (unset.status === 503) ok('an unconfigured deployment refuses every callback', '503');
  else bad('an unconfigured deployment refuses every callback', `got ${unset.status}`);
  expectedSecret = SECRET;

  const absent = await post({ id: 'anything' }, { secret: null });
  if (absent.status === 401) ok('no header at all is refused', '401');
  else bad('no header at all is refused', `got ${absent.status}`);

  const wrong = await post({ id: 'anything' }, { secret: 'x'.repeat(SECRET.length) });
  if (wrong.status === 401) ok('a wrong secret of the right length is refused');
  else bad('a wrong secret of the right length is refused', `got ${wrong.status}`);

  // The length-mismatch branch is the one with the padded comparison in it, and it is the
  // branch a careless refactor deletes as redundant.
  const shortSecret = await post({ id: 'anything' }, { secret: 'short' });
  if (shortSecret.status === 401) ok('  · and so is one of the wrong length', 'the padded compare');
  else bad('  · and so is one of the wrong length', `got ${shortSecret.status}`);

  const before = vendorHits;
  await post({ id: 'anything' }, { secret: 'short' });
  if (vendorHits === before) ok('a refused callback reaches no vendor', 'refused before any request');
  else bad('a refused callback reaches no vendor', `${vendorHits - before} request(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. The body is read for one field and believed for none\n');
{
  const malformed = await post(null, { raw: 'not json at all' });
  if (malformed.status === 400) ok('a malformed body is refused', '400, not a 500');
  else bad('a malformed body is refused', `got ${malformed.status}`);

  const empty = await post({});
  if (empty.status === 400) ok('a well-formed body with no job id is refused');
  else bad('a well-formed body with no job id is refused', `got ${empty.status}`);

  // Three spellings because the vendor's docs are sparse and its payloads have varied.
  // Each is accepted; none is trusted for anything beyond naming a job.
  for (const key of ['id', 'job_set_id', 'jobSetId']) {
    const r = await post({ [key]: `unknown-${key}` });
    const accepted = r.status === 202 && r.body?.outcome === 'unknown_job';
    if (accepted) ok(`  · ${key} names the job`, 'unknown_job, and a 202');
    else bad(`  · ${key} names the job`, JSON.stringify(r));
  }

  const before = vendorHits;
  await post({ id: 'still-unknown' });
  if (vendorHits === before) {
    ok('an unknown job is refused before any outbound request', 'not a request proxy');
  } else {
    bad('an unknown job is refused before any outbound request', `${vendorHits - before} request(s)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// The section 0008 §5b said was unobserved. Everything here is the layer above the SQL.
console.log('\n3. The delivery record — the RPC shape, observed\n');
{
  const jobId = `job-${randomUUID()}`;
  await seedGeneration(jobId);

  vendorReply = completed('https://example.invalid/clip.mp4');

  const first = await post({ id: jobId });
  if (first.status === 202) ok('a first delivery is accepted', `202 ${first.body?.outcome}`);
  else bad('a first delivery is accepted', JSON.stringify(first));

  const { rows: d1 } = await client.query(
    `select webhook_deliveries as deliveries, webhook_received_at is not null as first_stamped,
            webhook_last_received_at is not null as last_stamped
       from generations where external_job_id = $1`,
    [jobId],
  );

  // This is the assertion the whole file exists for. If `record_webhook_delivery` returned
  // a shape the code does not unwrap, `record` would be undefined and `deliveries` would
  // never have been written — and every other check here would still pass.
  if (d1[0]?.deliveries === 1) ok('the RPC wrote the delivery count', 'Array.isArray unwrap is correct');
  else bad('the RPC wrote the delivery count', JSON.stringify(d1[0]));

  if (d1[0]?.first_stamped && d1[0]?.last_stamped) ok('  · and both timestamps');
  else bad('  · and both timestamps', JSON.stringify(d1[0]));

  const { rows: g1 } = await client.query(
    `select status, confirmed_at is not null as confirmed, error_code
       from generations where external_job_id = $1`,
    [jobId],
  );
  if (g1[0]?.status === 'succeeded' && g1[0]?.confirmed) {
    ok('the generation settled', 'succeeded, confirmed');
  } else {
    bad('the generation settled', JSON.stringify(g1[0]));
  }

  // The outcome names the URL it is handing to the worker, and **no asset row exists yet**.
  // That is rule 2, observed: a Vercel route moves an id and a URL, and the worker moves
  // the file. An `assets` row here would mean this route had downloaded something.
  if (first.body?.outcome === 'succeeded') {
    ok('  · and the confirmation won the compare-and-set', 'outcome succeeded, so the ingest was enqueued');
  } else {
    bad(
      '  · and the confirmation won the compare-and-set',
      `outcome ${first.body?.outcome} — a first delivery reporting anything else means ` +
        'confirm_generation_once returned a value the caller does not recognise as a win, ' +
        'and the ingest enqueue below it never runs',
    );
  }

  const { rows: a1 } = await client.query(
    `select count(*)::int as n from assets a
       join generations g on g.id = a.generation_id
      where g.external_job_id = $1`,
    [jobId],
  );
  if (a1[0].n === 0) ok('  · and no bytes moved through the route', 'rule 2 — the worker writes the asset');
  else bad('  · and no bytes moved through the route', `${a1[0].n} assets written by a Vercel route`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. A replay changes nothing, and is visible\n');
{
  const jobId = `replay-${randomUUID()}`;
  await seedGeneration(jobId);

  vendorReply = completed('https://example.invalid/good.mp4');
  await post({ id: jobId });

  // The hostile replay: same job, a payload claiming failure. The body is not believed, and
  // the settlement has already happened, so neither route to changing the row is open.
  vendorReply = failed('forged');
  const second = await post({ id: jobId, status: 'failed', error_code: 'forged' });

  if (second.status === 202 && second.body?.outcome === 'already_confirmed') {
    ok('the replay is recognised', 'already_confirmed');
  } else {
    bad('the replay is recognised', JSON.stringify(second));
  }

  const { rows } = await client.query(
    `select status, error_code, webhook_deliveries as deliveries from generations where external_job_id = $1`,
    [jobId],
  );
  if (rows[0]?.status === 'succeeded' && rows[0]?.error_code === null) {
    ok("  · and the attacker's write did not land", 'still succeeded, error_code null');
  } else {
    bad("  · and the attacker's write did not land", JSON.stringify(rows[0]));
  }

  if (rows[0]?.deliveries === 2) ok('  · while the delivery counter moved', '2');
  else bad('  · while the delivery counter moved', String(rows[0]?.deliveries));

  const { rows: replayed } = await client.query(
    `select count(*)::int as n from v_replayed_callbacks where external_job_id = $1`,
    [jobId],
  );
  if (replayed[0].n === 1) ok('  · and it is readable as a replay', 'v_replayed_callbacks');
  else bad('  · and it is readable as a replay', `${replayed[0].n} rows`);

  // The fast path returns before the driver is reached. A redelivery storm must not become
  // a burst of requests at a vendor whose rate limits fail silently.
  const before = vendorHits;
  await post({ id: jobId });
  if (vendorHits === before) ok('a third delivery costs no vendor request', 'the confirmed_at fast path');
  else bad('a third delivery costs no vendor request', `${vendorHits - before} request(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
//
// The one that cannot be written against a mocked driver, because the assertion is about
// which of two sources the code believes.
console.log('\n5. The vendor is believed; the callback is not\n');
{
  const jobId = `disagree-${randomUUID()}`;
  await seedGeneration(jobId);

  // The callback claims success. The status endpoint — the only source that matters —
  // says it failed.
  vendorReply = failed('moderation');
  const r = await post({ id: jobId, status: 'completed', assets: [{ url: 'https://evil.invalid/x.mp4' }] });

  if (r.status === 202) ok('the callback is accepted', `202 ${r.body?.outcome}`);
  else bad('the callback is accepted', JSON.stringify(r));

  const { rows } = await client.query(
    `select status, error_code from generations where external_job_id = $1`,
    [jobId],
  );
  if (rows[0]?.status === 'failed') {
    ok('  · and the vendor decided the outcome', `failed (${rows[0].error_code ?? 'no code'})`);
  } else {
    bad('  · and the vendor decided the outcome', JSON.stringify(rows[0]));
  }

  const { rows: assets } = await client.query(
    `select count(*)::int as n from assets a
       join generations g on g.id = a.generation_id
      where g.external_job_id = $1`,
    [jobId],
  );
  if (assets[0].n === 0) {
    ok("  · and the payload's url was never written", 'no asset from a body we do not trust');
  } else {
    bad("  · and the payload's url was never written", `${assets[0].n} assets`);
  }
}

vendor.close();
app.close();
await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nThe callback path runs, above the SQL as well as below it.\n' +
    'What is left is Gate 4: whether the real status endpoint returns this shape.\n',
);
