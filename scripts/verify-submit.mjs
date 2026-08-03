#!/usr/bin/env node
/**
 * Stage 5 — the submit path, against real Postgres and a real socket.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Written at the same time as the wiring, on purpose
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `submitShots` reached this point complete, unreachable and unproven. Giving it a caller
 * without also giving it a harness would have moved it from "built, tested, unreachable"
 * into "built, untested, reachable", which is strictly worse: it would now run, and it
 * spends money.
 *
 * PROVES:  every refusal happens *before* a vendor call and before a ledger row — no
 *          compiled parameters, an estimated duration rather than a measured one, an
 *          unpriced model, a character reference a recipe cannot carry; that the row is
 *          written before the call and carries the vendor's job id after it; that a vendor
 *          refusal becomes a failed row with the taxonomy code rather than an exception;
 *          that a resubmit is refused by the idempotency key rather than billed twice; and
 *          that the callback URL handed to the vendor is the one the webhook serves.
 *
 * DOES NOT: prove the real vendor accepts these parameters. The stub speaks the SDK's
 *           protocol, not Higgsfield's semantics. That is Gate 4.
 *
 * ── The stub is the vendor's HTTP surface, not a mocked module ───────────────
 *
 * `HIGGSFIELD_API_BASE_URL` points at a local server, so the real `@higgsfield/client`
 * builds the request, signs it, and parses the reply. What that buys is the error taxonomy:
 * a 402 has to travel through the SDK's own error classes to come out as
 * `insufficient_credits`, and mapping it in a mock would only prove the mapping table
 * matches itself.
 *
 * Usage: node scripts/verify-submit.mjs <db-url>
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-submit.mjs <db-url>');
  process.exit(2);
}

// ── The stub vendor ─────────────────────────────────────────────────────────
let reply = { status: 200, body: () => ({ id: `job-${randomUUID()}`, jobs: [] }) };
const seen = [];

const vendor = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  seen.push({
    url: req.url,
    auth: req.headers.authorization ?? null,
    body: raw ? JSON.parse(raw) : null,
  });
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply.body()));
});
await new Promise((r) => vendor.listen(0, '127.0.0.1', r));
const vendorUrl = `http://127.0.0.1:${vendor.address().port}`;

process.env.HIGGSFIELD_API_BASE_URL = vendorUrl;
process.env.HIGGSFIELD_API_KEY ??= 'stub-key';
process.env.HIGGSFIELD_API_SECRET ??= 'stub-secret';
process.env.HIGGSFIELD_WEBHOOK_SECRET ??= 'a-shared-secret-of-at-least-32-characters';
process.env.USD_INR_RATE ??= '88.5';
process.env.APP_URL ??= 'https://harness.invalid';
process.env.WEBHOOK_CALLBACK_BASE_URL ??= 'https://harness.invalid';
process.env.ALLOWED_EMAIL ??= 'harness@invalid.test';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://harness.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'harness';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { submitShots } = require(`${BUILD}/generate/submit.js`);
const { callbackUrl } = require(`${BUILD}/drivers/video-submit.js`);
const { approveConcept } = require(`${BUILD}/concepts/approve.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const scratch = await scratchDatabase(dbUrl, 'submit');
const client = scratch.client;
const db = supabaseShim(client);

const DEPS = {
  db,
  apiKey: 'stub-key',
  apiSecret: 'stub-secret',
  webhookBaseUrl: 'https://harness.invalid',
  webhookSecret: process.env.HIGGSFIELD_WEBHOOK_SECRET,
  usdInrRate: 88.5,
  concurrency: 2,
};

const channelId = randomUUID();
await client.query(
  `insert into channels (id, name, platform, niche)
   values ($1, 'verify-submit', 'youtube', 'verification')`,
  [channelId],
);

/** A priced model, because rule 5 refuses anything it cannot cost. */
async function priceIt(model) {
  await client.query(
    `insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note)
     values ('higgsfield', $1, '/v1/text2image/soul', 'credit', 0.08, 'USD', true, 'harness')
     on conflict do nothing`,
    [model],
  );
}

let seq = 0;
async function seedScript(shots) {
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  seq++;

  await client.query(
    `insert into concepts (id, channel_id, title, angle, rubric_version, status)
     values ($1, $2, 'Submit harness', 'proving stage 5', 'v1', 'in_production')`,
    [conceptId, channelId],
  );
  await client.query(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1, $2, 'a hook', '[]', 'some voiceover', 'claude-opus-5', $3)`,
    [scriptId, conceptId, `verify-submit-${seq}`],
  );

  const ids = [];
  for (const [i, shot] of shots.entries()) {
    const shotId = randomUUID();
    ids.push(shotId);
    await client.query(
      `insert into shots (id, script_id, idx, shot_kind, description, duration_s,
                          duration_source, compiled_params, prompt_id, character_id, compile_note)
       values ($1, $2, $3, 'establishing', $4, 4, $5, $6, $7, $8, $9)`,
      [
        shotId,
        scriptId,
        i,
        `shot ${i}`,
        shot.durationSource ?? 'derived_from_vo',
        shot.compiled === undefined ? JSON.stringify({ model: 'soul' }) : shot.compiled,
        shot.promptId ?? null,
        shot.characterId ?? null,
        shot.note ?? null,
      ],
    );
  }
  return { scriptId, shotIds: ids };
}

async function makeRecipe({ acceptsCharacterRef = true } = {}) {
  const id = randomUUID();
  await client.query(
    `insert into prompts (id, name, driver, model, template, params, accepts_character_ref,
                          discovered_in, is_active)
     values ($1, $2, 'higgsfield', 'soul', 'a template', $3, $4, 'claude-code-mcp', true)`,
    [id, `recipe-${id.slice(0, 8)}`, JSON.stringify({ model: 'soul' }), acceptsCharacterRef],
  );
  return id;
}

const ledgerCount = async () =>
  (await client.query(`select count(*)::int as n from cost_ledger`)).rows[0].n;

console.log('\nStage 5 — the submit path\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. Every refusal happens before the money\n');
{
  await priceIt('soul');
  const recipe = await makeRecipe();

  const before = seen.length;
  const ledgerBefore = await ledgerCount();

  const { scriptId } = await seedScript([
    // No compiled params — stage 4 found no library recipe.
    { compiled: null, promptId: null, note: 'no recipe matched this shot kind' },
    // Still carrying the shotlist's authored estimate rather than a measured duration.
    { durationSource: 'authored', promptId: recipe },
  ]);

  const out = await submitShots(scriptId, DEPS);

  if (out.ok && out.submitted === 0) ok('nothing was submitted', `${out.skipped.length} skipped`);
  else bad('nothing was submitted', JSON.stringify(out));

  if (seen.length === before) ok('  · and the vendor was never called');
  else bad('  · and the vendor was never called', `${seen.length - before} request(s)`);

  if ((await ledgerCount()) === ledgerBefore) ok('  · and no cost row was written');
  else bad('  · and no cost row was written');

  const reasons = (out.skipped ?? []).map((s) => s.reason);
  if (reasons.some((r) => /no recipe matched/.test(r))) {
    ok('  · the uncompiled shot says which stage failed it', 'stage 4 note carried through');
  } else {
    bad('  · the uncompiled shot says which stage failed it', reasons.join(' | '));
  }

  // The audio-first inversion is the reason this refusal exists. If the message stops
  // saying so, the next person reads it as a scheduling quirk and reorders the stages.
  if (reasons.some((r) => /stage 6 first/.test(r))) {
    ok('  · the estimated duration names the ordering rule', 'run stage 6 first');
  } else {
    bad('  · the estimated duration names the ordering rule', reasons.join(' | '));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. An unpriced model stops the whole script\n');
{
  const recipe = await makeRecipe();
  const before = seen.length;

  const { scriptId } = await seedScript([
    { compiled: JSON.stringify({ model: 'not-in-the-rate-card' }), promptId: recipe },
  ]);

  let threw = null;
  try {
    await submitShots(scriptId, DEPS);
  } catch (err) {
    threw = err.message;
  }

  // Priced once for the script rather than per shot, so this refuses everything. That is
  // the point: discovering on shot four that the rate is unverified leaves three billed
  // calls unaccounted for.
  if (threw && /cannot be priced/.test(threw)) ok('the submit refuses', threw.slice(0, 68) + '…');
  else bad('the submit refuses', String(threw));

  if (seen.length === before) ok('  · before any vendor call', 'rule 5, ahead of the spend');
  else bad('  · before any vendor call', `${seen.length - before} request(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. A character reference a recipe cannot carry is refused\n');
{
  const recipe = await makeRecipe({ acceptsCharacterRef: false });
  const characterId = randomUUID();
  await client.query(
    `insert into characters (id, name, driver, external_ref_id, reference_urls)
     values ($1, 'Host', 'higgsfield', 'soul-id-stub', '{}')`,
    [characterId],
  );

  const before = seen.length;
  const { scriptId } = await seedScript([{ promptId: recipe, characterId }]);
  const out = await submitShots(scriptId, DEPS);

  const reason = out.skipped?.[0]?.reason ?? '';
  if (out.submitted === 0 && /character reference/.test(reason)) {
    ok('refused rather than submitted without it', 'a stranger, billed, is the alternative');
  } else {
    bad('refused rather than submitted without it', JSON.stringify(out));
  }

  if (seen.length === before) ok('  · and the vendor was never called');
  else bad('  · and the vendor was never called', `${seen.length - before} request(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. A real submit — row first, job id after\n');
{
  const recipe = await makeRecipe();
  const jobId = `job-${randomUUID()}`;
  reply = { status: 200, body: () => ({ id: jobId, jobs: [] }) };

  const before = seen.length;
  const { scriptId, shotIds } = await seedScript([{ promptId: recipe }]);
  const out = await submitShots(scriptId, DEPS);

  if (out.ok && out.submitted === 1) ok('one shot submitted', JSON.stringify(out.skipped));
  else bad('one shot submitted', JSON.stringify(out));

  const call = seen[before];
  if (call) ok('  · the vendor was called once', call.url);
  else bad('  · the vendor was called once', `${seen.length - before} requests`);

  // The callback URL is the contract between this path and the webhook. If they disagree,
  // every generation runs, bills, and reports to nowhere.
  const sentUrl = call?.body?.webhook?.url;
  if (sentUrl === callbackUrl('https://harness.invalid')) {
    ok('  · and told to call back at the route the webhook serves', sentUrl);
  } else {
    bad('  · and told to call back at the route the webhook serves', String(sentUrl));
  }

  if (call?.body?.webhook?.secret === DEPS.webhookSecret) {
    ok('  · carrying the shared secret', 'the callback can authenticate itself');
  } else {
    bad('  · carrying the shared secret');
  }

  // ── Rule 4, measured rather than asserted ────────────────────────────────
  //
  // The SDK's `withPolling` defaults to **true**, so omitting it polls the job to
  // completion inside the submit call. The first version of the driver omitted it under a
  // comment saying that avoided polling, and this harness hung on this exact line — the
  // stub never reports a terminal status, so the poll ran until the timeout.
  //
  // A comment cannot hold this. One request to the endpoint means submit-and-return; more
  // than one means the poll is back, whatever any comment says.
  const requestsForOneSubmit = seen.length - before;
  if (requestsForOneSubmit === 1) {
    ok('  · and the SDK did not poll', 'one request per submit — rule 4');
  } else {
    bad(
      '  · and the SDK did not poll',
      `${requestsForOneSubmit} requests for one submit. withPolling defaults to true; ` +
        'omitting it is not the same as disabling it.',
    );
  }

  const { rows } = await client.query(
    `select status, external_job_id, idempotency_key, unit_cost_snapshot
       from generations where shot_id = $1`,
    [shotIds[0]],
  );
  if (rows[0]?.status === 'queued' && rows[0]?.external_job_id === jobId) {
    ok('the row carries the vendor job id', `queued, ${jobId.slice(0, 16)}…`);
  } else {
    bad('the row carries the vendor job id', JSON.stringify(rows[0]));
  }

  const { rows: shot } = await client.query(`select status from shots where id = $1`, [shotIds[0]]);
  if (shot[0]?.status === 'generating') ok('  · and the shot moved to generating');
  else bad('  · and the shot moved to generating', shot[0]?.status);

  const { rows: cost } = await client.query(
    `select entry_kind, quantity, round(cost_inr, 2) as inr from cost_ledger
      where idempotency_key = $1 || ':estimate'`,
    [rows[0].idempotency_key],
  );
  if (cost[0]?.entry_kind === 'estimate') {
    ok('  · and an estimate row was written at submit time', `₹${cost[0].inr}, rule 5`);
  } else {
    bad('  · and an estimate row was written at submit time', JSON.stringify(cost[0]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. A resubmit is refused by the key, not billed twice\n');
{
  const recipe = await makeRecipe();
  reply = { status: 200, body: () => ({ id: `job-${randomUUID()}`, jobs: [] }) };

  const { scriptId } = await seedScript([{ promptId: recipe }]);
  await submitShots(scriptId, DEPS);

  const callsAfterFirst = seen.length;
  const ledgerAfterFirst = await ledgerCount();

  const second = await submitShots(scriptId, DEPS);

  if (second.ok && second.submitted === 0) ok('the second run submits nothing', 'the key already exists');
  else bad('the second run submits nothing', JSON.stringify(second));

  if ((await ledgerCount()) === ledgerAfterFirst) ok('  · and writes no second charge', 'rule 6');
  else bad('  · and writes no second charge');

  // The upsert on the ledger is `ignoreDuplicates`, so the estimate row is idempotent —
  // but the vendor call must not repeat either, and that is a different guarantee.
  if (seen.length === callsAfterFirst) ok('  · and does not call the vendor again');
  else bad('  · and does not call the vendor again', `${seen.length - callsAfterFirst} request(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. A vendor refusal is a row, not an exception\n');
{
  const recipe = await makeRecipe();
  // 402 through the real SDK, so the taxonomy is exercised rather than asserted.
  reply = { status: 402, body: () => ({ error: 'not enough credits' }) };

  const { scriptId, shotIds } = await seedScript([{ promptId: recipe }]);

  let threw = null;
  let out = null;
  try {
    out = await submitShots(scriptId, DEPS);
  } catch (err) {
    threw = err.message;
  }

  if (!threw) ok('the submit returns rather than throwing', 'one shot must not abandon five');
  else bad('the submit returns rather than throwing', threw);

  const { rows } = await client.query(
    `select status, error_code, error_detail, external_job_id
       from generations where shot_id = $1`,
    [shotIds[0]],
  );
  if (rows[0]?.status === 'failed' && rows[0]?.error_code === 'insufficient_credits') {
    ok('  · the generation row records the taxonomy code', 'insufficient_credits');
  } else {
    bad('  · the generation row records the taxonomy code', JSON.stringify(rows[0]));
  }

  if (rows[0]?.external_job_id === null) {
    ok('  · and carries no job id', 'nothing to confirm, so nothing pretends there is');
  } else {
    bad('  · and carries no job id', rows[0]?.external_job_id);
  }

  const reason = out?.skipped?.[0]?.reason ?? '';
  if (/fail_fast/.test(reason)) {
    ok('  · and the caller is told not to retry', 'disposition carried, not guessed');
  } else {
    bad('  · and the caller is told not to retry', reason);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// Both spellings, because they travel by different routes. 402 arrives as the SDK's generic
// APIError and is classified from `statusCode`; 403 is intercepted by the SDK and arrives
// as NotEnoughCreditsError. Asserting only one leaves the other free to regress into
// `unknown`, which is `fail_fast` for the wrong reason and reads as a bug in Kiln.
console.log('\n7. 403 means out of credits here, not forbidden\n');
{
  const recipe = await makeRecipe();
  reply = { status: 403, body: () => ({ detail: 'no credits' }) };

  const { scriptId, shotIds } = await seedScript([{ promptId: recipe }]);
  await submitShots(scriptId, DEPS);

  const { rows } = await client.query(
    `select error_code from generations where shot_id = $1`,
    [shotIds[0]],
  );
  if (rows[0]?.error_code === 'insufficient_credits') {
    ok('a 403 is credits, not auth', 'the SDK maps it, and re-checking a good credential is wasted');
  } else {
    bad('a 403 is credits, not auth', JSON.stringify(rows[0]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// The pipeline lane's entry point. Until this existed, stage 3 — and through it stages 4
// and 5 — could not be reached from the product at all, because nothing in the codebase
// could approve a concept.
console.log('\n8. Approving a concept is a transition, not a field write\n');
{
  const conceptId = randomUUID();
  await client.query(
    `insert into concepts (id, channel_id, title, angle, rubric_version, status)
     values ($1, $2, 'Approval harness', 'proving the entry point', 'v1', 'draft')`,
    [conceptId, channelId],
  );

  // The enqueue fails here — there is no Trigger worker — and that must not undo the
  // approval or fail the call. A human decision recorded is worth more than a transport.
  const first = await approveConcept(db, conceptId);
  if (first.ok && first.enqueued === false) {
    ok('an approval survives a failed enqueue', 'the decision is recorded either way');
  } else {
    bad('an approval survives a failed enqueue', JSON.stringify(first));
  }

  const { rows } = await client.query(`select status from concepts where id = $1`, [conceptId]);
  if (rows[0]?.status === 'approved') ok('  · and the row moved to approved');
  else bad('  · and the row moved to approved', rows[0]?.status);

  // The compare-and-set. Two clicks must not become two scripts and two charges.
  const second = await approveConcept(db, conceptId);
  if (!second.ok && second.code === 'not_draft') {
    ok('a second approval is refused', 'where status = draft, decided by the database');
  } else {
    bad('a second approval is refused', JSON.stringify(second));
  }

  const missing = await approveConcept(db, randomUUID());
  if (!missing.ok && missing.code === 'not_found') {
    ok('  · and a missing concept is a different answer', 'a broken link is not a no-op');
  } else {
    bad('  · and a missing concept is a different answer', JSON.stringify(missing));
  }

  const killedId = randomUUID();
  await client.query(
    `insert into concepts (id, channel_id, title, angle, rubric_version, status)
     values ($1, $2, 'Killed', 'already judged', 'v1', 'killed')`,
    [killedId, channelId],
  );
  const killed = await approveConcept(db, killedId);
  if (!killed.ok && killed.code === 'not_draft') {
    ok('a killed concept cannot be approved', 'the kill is editorial evidence');
  } else {
    bad('a killed concept cannot be approved', JSON.stringify(killed));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// The reason a chain goes quiet, in one row rather than four tables.
//
// This section exists because of what the sweep found: stage 5 refuses any shot whose
// duration is still an estimate, only stage 6 sets `derived_from_vo`, and stage 6 had no
// caller — so the 03 → 04 → 05 chain was complete, green, and submitted nothing, for ever.
// Every stage passed its own harness. The emptiness was only visible end to end.
console.log('\n9. Why a script is stuck, answered in one place\n');
{
  const recipe = await makeRecipe();

  // A channel with no host voice. Stage 6 cannot run unattended, so stage 5 never gets a
  // measured duration — the exact inert state.
  const { scriptId } = await seedScript([
    { promptId: recipe, durationSource: 'authored' },
  ]);

  const { rows: noVoice } = await client.query(
    `select blocker from v_pipeline_blockers where script_id = $1`,
    [scriptId],
  );
  if (/no host voice/.test(noVoice[0]?.blocker ?? '')) {
    ok('a channel with no host voice is named as the blocker', noVoice[0].blocker);
  } else {
    bad('a channel with no host voice is named as the blocker', JSON.stringify(noVoice[0]));
  }

  // Give it a voice. The next blocker down should surface — the durations, which is what
  // stage 6 would have fixed.
  await client.query(`update channels set host_voice_id = 'voice-abc' where id = $1`, [channelId]);
  const { rows: withVoice } = await client.query(
    `select blocker from v_pipeline_blockers where script_id = $1`,
    [scriptId],
  );
  if (/durations are still estimates/.test(withVoice[0]?.blocker ?? '')) {
    ok('  · and fixing it reveals the next one', withVoice[0].blocker);
  } else {
    bad('  · and fixing it reveals the next one', JSON.stringify(withVoice[0]));
  }

  // A script with everything in place has no blocker at all. Null rather than a cheerful
  // string, so a caller can filter on it.
  const { scriptId: ready } = await seedScript([{ promptId: recipe }]);
  const { rows: clear } = await client.query(
    `select blocker from v_pipeline_blockers where script_id = $1`,
    [ready],
  );
  if (clear[0] && clear[0].blocker === null) {
    ok('  · and a ready script has none', 'null, not a message');
  } else {
    bad('  · and a ready script has none', JSON.stringify(clear[0]));
  }

  await client.query(`update channels set host_voice_id = null where id = $1`, [channelId]);
}

vendor.close();
await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nStage 5 refuses before it spends, submits once, and records what happened.\n' +
    'What is left is Gate 4: whether the real vendor accepts these parameters.\n',
);
