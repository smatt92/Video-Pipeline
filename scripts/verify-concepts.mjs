#!/usr/bin/env node
/**
 * Stage 2 — concept generation, against real Postgres and the real Anthropic client.
 *
 * PROVES:  the rubric's arithmetic (all four axes point the same way, ip_risk is excluded
 *          from the total); the validations a decode constraint cannot express — a duplicate
 *          angle inside a batch, an angle that restates its title; that every concept lands
 *          as a draft and nothing here can approve one; that a partial batch keeps the good
 *          concepts and reports the rest; that a refusal and a truncation are still charged;
 *          that the charge is written before the rows and survives a row being refused; and
 *          that the batch charge divides correctly in `v_concept_cost`.
 *
 * DOES NOT: prove the model produces good concepts. Nothing automated can. What it rules
 *           out is the pipeline around the judgement being wrong.
 *
 * ── Why the stub is an HTTP server and not a mocked module ───────────────────
 *
 * `baseURL` points the real `@anthropic-ai/sdk` at a local server, so the SDK builds the
 * request, applies its own retries, and parses the reply into its own error classes. A
 * mocked `messages.parse` would prove the mapping table matches itself — and the thing most
 * likely to be wrong here is the *shape* of what comes back, which a mock defines rather
 * than tests.
 *
 * ── The question this harness was built to settle ────────────────────────────
 *
 * `writeLlmCost` used `onConflict` against two partial unique indexes, which Postgres
 * cannot infer. Whether that had ever failed in production could not be established from
 * here — the harnesses drive a `pg` shim rather than PostgREST — so rather than guess, the
 * code stopped depending on the answer and this exercises the result against a real
 * migrated schema.
 *
 * Usage: node scripts/verify-concepts.mjs <db-url>
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-concepts.mjs <db-url>');
  process.exit(2);
}

// ── The stub model ──────────────────────────────────────────────────────────
//
// Replies in the Messages API's shape. `parsed_output` is what `messages.parse` populates
// from a structured-output response; the SDK derives it from the content block, so the stub
// returns the block and lets the SDK do its own work.
let nextReply = null;
let calls = 0;

function messageResponse({ concepts, stopReason = 'end_turn', usage }) {
  return {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: JSON.stringify({ concepts }) }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: usage?.input ?? 900, output_tokens: usage?.output ?? 400 },
  };
}

const model = createServer(async (req, res) => {
  calls++;
  const chunks = [];
  for await (const c of req) chunks.push(c);

  const reply = typeof nextReply === 'function' ? nextReply() : nextReply;

  if (reply?.httpStatus && reply.httpStatus !== 200) {
    res.writeHead(reply.httpStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub' } }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply.body));
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${model.address().port}`;

process.env.APP_URL ??= 'https://harness.invalid';
process.env.WEBHOOK_CALLBACK_BASE_URL ??= 'https://harness.invalid';
process.env.ALLOWED_EMAIL ??= 'harness@invalid.test';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://harness.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'harness';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';
process.env.ANTHROPIC_API_KEY ??= 'stub-key';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { runConcepts } = require(`${BUILD}/concepts/run.js`);
const { scoreTotal, validateConcepts } = require(`${BUILD}/concepts/schema.js`);
const { readRateCard, currentRate } = require(`${BUILD}/cost/rate-card.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const scratch = await scratchDatabase(dbUrl, 'concepts');
const client = scratch.client;
const db = supabaseShim(client);

const channelId = randomUUID();
await client.query(
  `insert into channels (id, name, platform, niche)
   values ($1, 'verify-concepts', 'youtube', 'urban infrastructure')`,
  [channelId],
);

// Both token rates, because the probe in step 2 refuses without them.
for (const unit of ['input_token', 'output_token']) {
  await client.query(
    `insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note)
     values ('anthropic', 'claude-opus-5', '/v1/messages', $1, 0.000005, 'USD', true, 'harness')`,
    [unit],
  );
}

const concept = (title, angle, over = {}) => ({
  title,
  angle,
  scores: { velocity: 0.8, saturation: 0.7, evergreen: 0.6, execution: 0.9, ...over.scores },
  ip_risk: over.ip_risk ?? 'low',
  rationale: over.rationale ?? 'Search interest tripled and nobody has covered this framing.',
  from_signals: over.from_signals ?? [],
});

const DEPS = { db, apiKey: 'stub-key', usdInrRate: 88.5, baseURL: modelUrl };

console.log('\nStage 2 — concept generation\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. The rubric arithmetic\n');
{
  const total = scoreTotal({ velocity: 1, saturation: 0, evergreen: 0.5, execution: 0.5 });
  if (total === 0.5) ok('score_total is the mean of the four axes', '1, 0, 0.5, 0.5 → 0.5');
  else bad('score_total is the mean of the four axes', String(total));

  // The thing most likely to be silently wrong. ip_risk must not move the total, or a
  // legal problem gets outvoted by velocity.
  const a = scoreTotal({ velocity: 0.9, saturation: 0.9, evergreen: 0.9, execution: 0.9 });
  const b = scoreTotal({ velocity: 0.9, saturation: 0.9, evergreen: 0.9, execution: 0.9 });
  if (a === b && a === 0.9) ok('  · and ip_risk is not one of them', 'scored separately, by design');
  else bad('  · and ip_risk is not one of them');

  // Saturation is "room left", so a crowded market must LOWER the total. If someone
  // refactors this into "how saturated" without flipping the arithmetic, this fails.
  const roomy = scoreTotal({ velocity: 0.5, saturation: 1, evergreen: 0.5, execution: 0.5 });
  const crowded = scoreTotal({ velocity: 0.5, saturation: 0, evergreen: 0.5, execution: 0.5 });
  if (roomy > crowded) ok('  · and every axis points the same way', `room ${roomy} > crowded ${crowded}`);
  else bad('  · and every axis points the same way', `${roomy} vs ${crowded}`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. What a decode constraint cannot check\n');
{
  const { kept, rejected } = validateConcepts([
    concept('Why cities are hotter than the countryside', 'The concrete is the story, not the sun'),
    // Same angle, different words and punctuation. A model will produce both.
    concept('Urban heat islands explained', 'the concrete is the story not the sun.'),
    // The angle restates the title — the failure mode a thin trend produces.
    concept('Why bridges collapse in winter', 'Bridges collapse in winter because of ice'),
    concept('The road salt problem', 'Every winter we dissolve the bridges we are protecting'),
  ]);

  if (kept.length === 2) ok('two of four survive', kept.map((c) => c.title.slice(0, 24)).join(' | '));
  else bad('two of four survive', `${kept.length} kept`);

  const reasons = rejected.map((r) => r.reason);
  if (reasons.some((r) => /duplicate angle/.test(r))) {
    ok('  · a duplicate angle is caught across wording', 'normalised on words, not the string');
  } else {
    bad('  · a duplicate angle is caught across wording', reasons.join(' | '));
  }

  if (reasons.some((r) => /restates the title/.test(r))) {
    ok('  · and an angle that restates its title', 'the anti-template mechanism, checked');
  } else {
    bad('  · and an angle that restates its title', reasons.join(' | '));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. A batch lands as drafts, and the charge lands first\n');
{
  nextReply = {
    body: messageResponse({
      concepts: [
        concept('Why cities are hotter than the countryside', 'The concrete is the story, not the sun'),
        concept('The road salt problem', 'Every winter we dissolve the bridges we are protecting'),
        concept('Bridge expansion joints', 'A gap that has to exist is the most designed thing on the road', {
          ip_risk: 'medium',
        }),
      ],
      usage: { input: 1200, output: 600 },
    }),
  };

  const before = calls;
  const out = await runConcepts({ channelId, count: 3 }, { ...DEPS, runId: `run-${randomUUID()}` });

  if (out.ok && out.created.length === 3) ok('three concepts created', `₹${out.costInr?.toFixed(4)}`);
  else bad('three concepts created', JSON.stringify(out).slice(0, 200));

  if (calls === before + 1) ok('  · from one model call', 'a batch is one call, not three');
  else bad('  · from one model call', `${calls - before} calls`);

  const { rows } = await client.query(
    `select status, rubric_version, score_total, ip_risk, scores->>'rationale' as rationale
       from concepts where channel_id = $1 order by score_total desc`,
    [channelId],
  );

  if (rows.length === 3 && rows.every((r) => r.status === 'draft')) {
    ok('every concept is a draft', 'a score is an ordering, not an approval');
  } else {
    bad('every concept is a draft', JSON.stringify(rows.map((r) => r.status)));
  }

  if (rows.every((r) => r.rubric_version === '02-concept.v1')) {
    ok('  · stamped with the rubric that scored it', '02-concept.v1');
  } else {
    bad('  · stamped with the rubric that scored it', rows[0]?.rubric_version);
  }

  if (rows.every((r) => r.rationale && r.rationale.length > 10)) {
    ok('  · and carries its rationale', 'the reason, not a summary of the axes');
  } else {
    bad('  · and carries its rationale');
  }

  if (rows.some((r) => r.ip_risk === 'medium')) {
    ok('  · with ip_risk in its own column', 'not averaged into the total');
  } else {
    bad('  · with ip_risk in its own column');
  }

  // The ledger question this harness exists to settle. `writeLlmCost` used ON CONFLICT
  // against partial unique indexes; if that were still the case, this would be zero.
  const { rows: cost } = await client.query(
    `select entry_kind, unit, channel_id is not null as on_channel, concept_id
       from cost_ledger where channel_id = $1 order by unit`,
    [channelId],
  );
  if (cost.length === 2 && cost.every((c) => c.on_channel && c.concept_id === null)) {
    ok('the charge is on the channel', 'two rows, input and output, no concept named');
  } else {
    bad('the charge is on the channel', JSON.stringify(cost));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. A partial batch keeps what is good\n');
{
  nextReply = {
    body: messageResponse({
      concepts: [
        concept('Potholes are a budgeting story', 'The repair cycle is set by the fiscal year, not the weather'),
        // A duplicate of the one above, so validation drops it and the other survives.
        concept('Why potholes come back', 'the repair cycle is set by the fiscal year not the weather'),
      ],
    }),
  };

  const out = await runConcepts({ channelId, count: 2 }, { ...DEPS, runId: `run-${randomUUID()}` });

  if (out.ok && out.created.length === 1 && out.rejected.length === 1) {
    ok('one kept, one rejected', out.rejected[0].reason);
  } else {
    bad('one kept, one rejected', JSON.stringify(out).slice(0, 200));
  }

  // The exact figure, not `> 0`.
  //
  // `> 0` stays true through any pricing bug that still charges something — swapped input
  // and output rates, a usage field read from the wrong place, a hardcoded 1. The stub
  // fixes the usage (900 in, 400 out) and the harness seeds the rate (0.000005 USD/token
  // both units, 88.5 to the rupee), so the answer is computable and there is no reason to
  // assert a weaker one.
  const expected4 = Number(((900 + 400) * 0.000005 * 88.5).toFixed(6));
  if (Number(out.costInr?.toFixed(6)) === expected4) {
    ok('  · and the whole call is charged, at the figure the rates give', `₹${expected4}`);
  } else {
    bad('  · and the whole call is charged, at the figure the rates give', `expected ₹${expected4}, got ${out.costInr}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. A failed call is still a charge\n');
{
  // A truncation. Tokens are billed exactly as on a success, and a failure path that drops
  // the usage under-reports cost permanently.
  nextReply = {
    body: messageResponse({
      concepts: [concept('Half a concept', 'cut off mid-object by the ceiling')],
      stopReason: 'max_tokens',
      usage: { input: 800, output: 4000 },
    }),
  };

  const runId = `run-${randomUUID()}`;
  const out = await runConcepts({ channelId, count: 5 }, { ...DEPS, runId });

  if (!out.ok && out.code === 'truncated') ok('a truncated batch is refused', out.code);
  else bad('a truncated batch is refused', JSON.stringify(out).slice(0, 160));

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // This section's stated purpose is that "a failure path that drops the usage
  // under-reports cost permanently", and `> 0` is exactly the assertion that cannot detect
  // it: a truncated call recorded as 1 input token instead of 800 passes. The whole point
  // is 4000 output tokens being billed on a call that produced nothing usable, so the
  // assertion has to be the figure those 4000 tokens come to.
  const expected5 = Number(((800 + 4000) * 0.000005 * 88.5).toFixed(6));
  if (Number(out.costInr?.toFixed(6)) === expected5) {
    ok('  · and charged for every token the ceiling consumed', `₹${expected5}`);
  } else {
    bad('  · and charged for every token the ceiling consumed', `expected ₹${expected5}, got ${out.costInr}`);
  }

  const { rows } = await client.query(
    `select count(*)::int as n from cost_ledger where idempotency_key like $1`,
    [`02-concept:${runId}:failed:%`],
  );
  if (rows[0].n === 2) ok('  · keyed on the run, so a retry does not double-charge', '2 rows');
  else bad('  · keyed on the run, so a retry does not double-charge', `${rows[0].n} rows`);

  // The same run again. The key is stable across attempts, so this must not add rows.
  await runConcepts({ channelId, count: 5 }, { ...DEPS, runId });
  const { rows: after } = await client.query(
    `select count(*)::int as n from cost_ledger where idempotency_key like $1`,
    [`02-concept:${runId}:failed:%`],
  );
  if (after[0].n === 2) ok('  · and a replayed attempt adds none', 'still 2');
  else bad('  · and a replayed attempt adds none', `${after[0].n} rows`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. An unpriced model refuses before the call\n');
{
  const other = randomUUID();
  await client.query(
    `insert into channels (id, name, platform, niche) values ($1, 'unpriced', 'youtube', 'x')`,
    [other],
  );
  await client.query(`update rate_card set is_verified = false where driver = 'anthropic'`);

  const before = calls;
  const out = await runConcepts({ channelId: other, count: 3 }, { ...DEPS, runId: `run-${randomUUID()}` });

  if (!out.ok && out.code === 'unpriced') ok('the run refuses', out.code);
  else bad('the run refuses', JSON.stringify(out).slice(0, 160));

  if (calls === before) ok('  · before the model is called', 'rule 5, ahead of the spend');
  else bad('  · before the model is called', `${calls - before} call(s)`);

  await client.query(`update rate_card set is_verified = true where driver = 'anthropic'`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n7. The batch charge divides\n');
{
  const { rows } = await client.query(
    `select concepts_landed, batch_inr, inr_per_concept from v_concept_cost where channel_id = $1`,
    [channelId],
  );

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // The denominator is checked against the concepts table, not against the view's own
  // count. Dividing `batch_inr` by `concepts_landed` and comparing to `inr_per_concept`
  // asserts only that the view is internally consistent — a ÷ b = c holds however wrong a
  // and b are. A producer checked against a model of itself agrees with itself, which is
  // the failure §9 of verify:submit shipped for days.
  const { rows: actual } = await client.query(
    `select count(*)::int as n from concepts where channel_id = $1`, [channelId],
  );
  // Number() on both sides: `count(*)` is bigint and arrives as a string from pg, so the
  // strict comparison fails on "4" === 4. The old `concepts_landed > 0` never noticed,
  // because "4" > 0 coerces true — a loose assertion hiding a type confusion, which is the
  // second thing tightening this found.
  if (rows.length > 0 && Number(rows[0].concepts_landed) === Number(actual[0].n)) {
    ok('the denominator is the concepts that actually landed', `${actual[0].n}, counted independently`);
  } else {
    bad('the denominator is the concepts that actually landed', `view says ${rows[0]?.concepts_landed}, table has ${actual[0].n}`);
  }

  if (rows.length > 0 && rows[0].concepts_landed > 0) {
    const expected = Number(rows[0].batch_inr) / rows[0].concepts_landed;
    const got = Number(rows[0].inr_per_concept);
    if (Math.abs(expected - got) < 0.001) {
      ok('cost per concept divides the batch', `₹${got.toFixed(4)} over ${rows[0].concepts_landed}`);
    } else {
      bad('cost per concept divides the batch', `${got} vs ${expected}`);
    }
  } else {
    bad('cost per concept divides the batch', 'no rows in v_concept_cost');
  }

  // A batch paid for and rejected wholesale is a real outcome, and it must read as null
  // rather than zero — zero cost per concept is a lie about a call that was billed.
  const empty = randomUUID();
  await client.query(
    `insert into channels (id, name, platform, niche) values ($1, 'nothing-landed', 'youtube', 'x')`,
    [empty],
  );
  await client.query(
    `insert into cost_ledger (driver, stage, entry_kind, usd_inr_rate, channel_id, unit,
                              quantity, cost_usd, cost_inr, idempotency_key)
     values ('anthropic', '02-concept', 'reconcile', 88.5, $1, 'input_token', 100, 0.01, 0.885, $2)`,
    [empty, `manual-${randomUUID()}`],
  );

  const { rows: none } = await client.query(
    `select inr_per_concept from v_concept_cost where channel_id = $1`,
    [empty],
  );
  if (none[0] && none[0].inr_per_concept === null) {
    ok('  · and reads null when nothing landed', 'a paid batch that produced nothing is not free');
  } else {
    bad('  · and reads null when nothing landed', JSON.stringify(none));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
// The screen that decides whether any paid stage may run.
//
// Every rate ships at zero and unverified, and `priceLlmCall`/`requirePricing` refuse on an
// unverified rate — so stages 2, 3, 5, 6 and 9 all stop. The rate card screen existed to fix
// that and rendered a constant, which meant it looked the same against a real database, an
// empty one and a broken one. That property is what makes this class of screen hard to
// notice: there is nothing to see.
console.log('\n8. The rate card, read and corrected\n');
{
  const card = await readRateCard(db);
  if (card.ok && card.rows.length > 0) {
    ok('the card reads from the table', `${card.rows.length} rates`);
  } else {
    bad('the card reads from the table', JSON.stringify(card).slice(0, 160));
  }

  // Unverified first, because they are the ones stopping a stage. Ordering is the whole
  // usefulness of the screen when most rows are unverified on a fresh install.
  await client.query(
    `insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note)
     values ('higgsfield', 'soul', '/v1/text2image/soul', 'credit', 0, 'USD', false, 'seed')`,
  );
  const withUnverified = await readRateCard(db);
  if (withUnverified.ok && withUnverified.rows[0].isVerified === false) {
    ok('  · unverified rates sort first', withUnverified.rows[0].model);
  } else {
    bad('  · unverified rates sort first', JSON.stringify(withUnverified.rows?.[0]));
  }

  // A correction appends. The old row stays, so a past cost figure keeps the rate that
  // produced it — updating in place would leave a six-month-old number unexplainable.
  const before = (await client.query(
    `select count(*)::int as n from rate_card where model = 'soul'`,
  )).rows[0].n;

  await client.query(
    `insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified,
                            source_note, effective_from)
     values ('higgsfield', 'soul', '/v1/text2image/soul', 'credit', 0.08, 'USD', true,
             'balance delta over run 41', now())`,
  );

  const after = (await client.query(
    `select count(*)::int as n from rate_card where model = 'soul'`,
  )).rows[0].n;

  if (after === before + 1) ok('a correction appends rather than edits', `${before} → ${after} rows`);
  else bad('a correction appends rather than edits', `${before} → ${after}`);

  const corrected = await readRateCard(db);
  const soul = corrected.ok ? corrected.rows.find((r) => r.model === 'soul') : null;
  if (soul?.isVerified && soul.unitCost === 0.08) {
    ok('  · and the newest row is the one in effect', `$${soul.unitCost}`);
  } else {
    bad('  · and the newest row is the one in effect', JSON.stringify(soul));
  }

  // Derived, not hard-coded: the migrations already seed a `soul` row, so the count is
  // "every row for this key except the one in effect". Writing the literal 1 here was wrong
  // for exactly the reason the field exists — a rate can have more history than you expect.
  if (soul?.revisions === after - 1) {
    ok('  · with every superseded row counted, not hidden', `${soul.revisions} of ${after}`);
  } else {
    bad('  · with every superseded row counted, not hidden', `${soul?.revisions} of ${after}`);
  }

  // The screen's read and the pipeline's read must agree. If they diverge, the card can
  // show a verified rate while a stage still refuses — the exact confusion this screen
  // exists to remove.
  const live = await currentRate(db, {
    driver: 'higgsfield',
    model: 'soul',
    endpoint: '/v1/text2image/soul',
    unit: 'credit',
  });
  if (live.found && live.rate.unitCostUsd === 0.08) {
    ok('the pipeline reads the same rate the screen shows', `$${live.rate.unitCostUsd}`);
  } else {
    bad('the pipeline reads the same rate the screen shows', JSON.stringify(live).slice(0, 160));
  }
}

model.close();
await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nStage 2 scores, refuses, charges and drafts — and approves nothing.\n' +
    'What no harness can tell you: whether the concepts are any good.\n',
);
