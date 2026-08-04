#!/usr/bin/env node
/**
 * Cost per video, against a real database.
 *
 * PROVES:  an unpriced ledger row makes a video's cost null rather than small; an estimate
 *          and its reconcile are one charge and not two; an outstanding estimate is
 *          reported as committed and never as settled; spend that belongs to no video is
 *          visible rather than dropped; the per-video rows and the unattributed rows are
 *          exhaustive over cost_ledger; and two hook variants of one script are one video,
 *          not two.
 *
 * The exhaustiveness assertion is the one that matters most and the one no per-column check
 * could give. Rule 5 makes cost-per-video the headline metric, and the way a headline
 * metric goes wrong is not by being computed incorrectly — it is by being computed over a
 * set somebody quietly narrowed with a where clause. Asserting that every ledger row lands
 * in exactly one of the two views means a narrowing shows up as a failure here rather than
 * as a flatteringly low number on a dashboard nobody can audit.
 *
 * Usage: node scripts/verify-costs.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-costs.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { readVideoCosts } = require(`${BUILD}/cost/video.js`);
const { readCostByStage, CHARGING_STAGES } = require(`${BUILD}/cost/by-stage.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => { console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const eq = (l, actual, expected) =>
  actual === expected ? ok(l, String(actual)) : bad(l, `expected ${expected}, got ${actual}`);

const scratch = await scratchDatabase(dbUrl, 'costs');
const client = scratch.client;
const db = supabaseShim(client);

const q = (sql, params = []) => client.query(sql, params);

/** Three outcomes, never two: a broken read must not be readable as an empty ledger. */
const expectOk = (r) => {
  if (!r.ok) { bad('the read succeeded', `${r.error} — ${r.hint}`); process.exit(1); }
  return r;
};

console.log('\nCost per video\n');

// ── An empty ledger ─────────────────────────────────────────────────────────────
console.log('0. Nothing has cost anything yet\n');
{
  const s = await expectOk(await readVideoCosts(db));
  eq('no per-video rows', s.rows.length, 0);
  eq('the ledger is reported empty, which is not the same as free', s.ledgerEmpty, true);
  if (s.costPerVideoInr === null) ok('cost per video is null, not ₹0', 'no video has finished');
  else bad('cost per video is null, not ₹0', String(s.costPerVideoInr));
  eq('the denominator is stated as zero', s.countable, 0);
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
const channelId = randomUUID();
await q(
  `insert into channels (id, name, platform, handle, niche)
   values ($1,'Kiln test','youtube','@kiln','test')`,
  [channelId],
);

/** A concept + script pair. */
async function makeVideo(title) {
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  await q(
    `insert into concepts (id, channel_id, title, angle, rubric_version)
     values ($1,$2,$3,'an angle','v1')`,
    [conceptId, channelId, title],
  );
  await q(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1,$2,'hook','[]'::jsonb,'some words','claude-opus-5',$3)`,
    [scriptId, conceptId, randomUUID()],
  );
  return { conceptId, scriptId };
}

async function makeRender(scriptId, status = 'ready') {
  const id = randomUUID();
  await q(
    `insert into renders (id, script_id, variant_group_id, variant_label, format, width, height, status)
     values ($1,$2,$3,'hook-a','shorts_9x16',1080,1920,$4)`,
    [id, scriptId, randomUUID(), status],
  );
  return id;
}

async function makeGeneration(scriptId, kind = 'video') {
  const shotId = randomUUID();
  const genId = randomUUID();
  await q(
    `insert into shots (id, script_id, idx, description, shot_kind, duration_s)
     values ($1,$2,0,'a shot','establishing',3)`,
    [shotId, scriptId],
  );
  await q(
    `insert into generations (id, shot_id, kind, driver, model, request_payload, idempotency_key)
     values ($1,$2,$3,'testdriver','testmodel','{}'::jsonb,$4)`,
    [genId, shotId, kind, randomUUID()],
  );
  return genId;
}

const ledger = (cols) => {
  const keys = Object.keys(cols);
  return q(
    `insert into cost_ledger (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => cols[k]),
  );
};

// ── 1. A finished, fully priced video ───────────────────────────────────────────
console.log('\n1. One finished video, every call priced\n');
const a = await makeVideo('Priced end to end');
{
  await makeRender(a.scriptId);
  await ledger({ script_id: a.scriptId, driver: 'anthropic', quantity: 1000, unit: 'input_token',
                 cost_usd: 0.01, cost_inr: 0.84, entry_kind: 'reconcile' });
  await ledger({ script_id: a.scriptId, driver: 'anthropic', quantity: 500, unit: 'output_token',
                 cost_usd: 0.03, cost_inr: 2.17, entry_kind: 'reconcile' });
  const gen = await makeGeneration(a.scriptId);
  await ledger({ generation_id: gen, driver: 'testdriver', quantity: 1, unit: 'clip',
                 cost_usd: 0.5, cost_inr: 42, entry_kind: 'reconcile' });

  const s = await expectOk(await readVideoCosts(db));
  eq('one per-video row', s.rows.length, 1);
  const row = s.rows[0];
  eq('  · incurred cost is the sum of the reconciled rows', Number(row.measuredInr ?? 0) + Number(row.estimatedInr ?? 0), 45.01);
  eq('  · it counts towards the denominator', row.denominatorState, 'countable_estimated');
  eq('the denominator is 1', s.countable, 1);
  eq('cost per video equals the one video', Number(s.costPerVideoInr), 45.01);

  const components = Object.keys(row.componentInr).sort().join(',');
  eq('  · broken out by component rather than one opaque total', components, 'llm,video');

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // §0 asserts `ledgerEmpty` is true on an empty ledger. That assertion passed for as long
  // as it has existed and proved nothing: the `pg` shim ignored
  // `select('id', { count: 'exact', head: true })` and returned `count: undefined`, which
  // `count ?? 0` turned into a confident zero — so `ledgerEmpty` was true whatever the
  // ledger held. Only the converse can tell the difference, and only after the shim was
  // taught to count.
  //
  // The same two-instrument failure as the `pg_proc` one: the shim could not observe the
  // thing and reported it as a value rather than as an error.
  eq('  · and no longer empty once rows exist', s.ledgerEmpty, false);
}

// ── 2. An estimate and its reconcile are one charge ─────────────────────────────
console.log('\n2. An estimate superseded by its reconcile\n');
const b = await makeVideo('Estimate then reconcile');
{
  await makeRender(b.scriptId);
  const gen = await makeGeneration(b.scriptId);
  await ledger({ generation_id: gen, driver: 'testdriver', quantity: 1, unit: 'clip',
                 cost_usd: 0.5, cost_inr: 40, entry_kind: 'estimate' });
  await ledger({ generation_id: gen, driver: 'testdriver', quantity: 1, unit: 'clip',
                 cost_usd: 0.55, cost_inr: 44, entry_kind: 'reconcile' });

  const s = await expectOk(await readVideoCosts(db));
  const row = s.rows.find((r) => r.scriptId === b.scriptId);
  eq('the reconcile is the incurred figure', Number(row.estimatedInr ?? 0) + Number(row.measuredInr ?? 0), 44);
  if (row.committedInr === null || Number(row.committedInr) === 0) {
    ok('the estimate is no longer outstanding', 'adding the two would bill this clip twice');
  } else bad('the estimate is no longer outstanding', String(row.committedInr));
  eq('  · but both rows are still counted as ledger rows', row.ledgerRows, 2);
}

// ── 3. An outstanding estimate is committed, not settled ────────────────────────
console.log('\n3. A submit whose result has not come back\n');
const c = await makeVideo('Mid flight');
{
  const gen = await makeGeneration(c.scriptId);
  await ledger({ generation_id: gen, driver: 'testdriver', quantity: 1, unit: 'clip',
                 cost_usd: 0.5, cost_inr: 40, entry_kind: 'estimate' });

  const s = await expectOk(await readVideoCosts(db));
  const row = s.rows.find((r) => r.scriptId === c.scriptId);
  eq('committed spend is reported', Number(row.committedInr), 40);
  if ((row.measuredInr ?? 0) === 0 && (row.estimatedInr ?? 0) === 0) {
    ok('  · and is not counted as incurred', 'the vendor may still refuse it for free');
  } else bad('  · and is not counted as incurred', `${row.measuredInr} / ${row.estimatedInr}`);
  eq('  · nothing rendered, so it is not a video yet', row.denominatorState, 'not_rendered');
  eq("the denominator is unchanged by a video that has not rendered", s.countable, 2);
  eq('  · with the exclusion named', s.excluded.notRendered, 1);
}

// ── 4. An unpriced row is unknown, not free ─────────────────────────────────────
console.log('\n4. A call nobody has a verified rate for\n');
const d = await makeVideo('Unpriced call');
{
  await makeRender(d.scriptId);
  const gen = await makeGeneration(d.scriptId);
  await ledger({ generation_id: gen, driver: 'unrated', quantity: 1, unit: 'clip',
                 cost_usd: 0, cost_inr: null, entry_kind: 'reconcile' });

  const s = await expectOk(await readVideoCosts(db));
  const row = s.rows.find((r) => r.scriptId === d.scriptId);
  if (row.estimatedInr === null && row.measuredInr === null) {
    ok('the video cost is null', 'an unknown cost is not a small one');
  } else bad('the video cost is null', `${row.measuredInr} / ${row.estimatedInr}`);
  eq('  · with the unpriced row counted', row.unpricedIncurredRows, 1);
  eq('  · and excluded from the average by name', row.denominatorState, 'unpriced');
  eq('the denominator did not silently grow', s.countable, 2);
  eq('  · the exclusion is reported', s.excluded.unpriced, 1);
  if (s.estimatedTotalInr === null && s.measuredTotalInr === null) {
    ok('the site-wide total goes null too', 'a sum with an unknown member is unknown');
  } else bad('the site-wide total goes null too', String(s.estimatedTotalInr));
}

// ── 5. Spend that belongs to no video ───────────────────────────────────────────
console.log('\n5. Money spent on nothing that became a video\n');
{
  const sessionId = randomUUID();
  await q(
    `insert into studio_sessions (id, model, spend_cap_inr) values ($1,'claude-opus-5',500)`,
    [sessionId],
  );
  await ledger({ studio_session_id: sessionId, driver: 'anthropic', quantity: 900,
                 unit: 'input_token', cost_usd: 0.02, cost_inr: 1.7, entry_kind: 'reconcile' });
  await ledger({ channel_id: channelId, driver: 'anthropic', quantity: 2000,
                 unit: 'input_token', cost_usd: 0.04, cost_inr: 3.4, entry_kind: 'reconcile' });

  const s = await expectOk(await readVideoCosts(db));
  const kinds = s.unattributed.map((u) => u.component).sort();
  eq('both land in the unattributed view', kinds.join(','), 'channel,studio');
  eq('  · totalling what was spent', Number(s.unattributedTotalInr), 5.1);
  if (!s.rows.some((r) => r.ledgerRows > 3)) {
    ok('  · and none of it is attributed to a video', 'a session that made nothing is not a video cost');
  } else bad('  · and none of it is attributed to a video');
}

// ── 5b. A Studio session that did make something ────────────────────────────────
//
// The other half of §5, and the half 0026 got wrong. `studio_sessions.script_id` is
// materialised on first generation and is the ONLY place that link exists — the ledger row
// cannot carry both studio_session_id and script_id, because the
// (script_id, stage, entry_kind, unit) unique index would collide on the session's second
// turn and swallow it as a retry. So a session that produced a video had its entire spend
// filed under "belongs to no video" for ever.
console.log('\n5b. A Studio session that materialised a script\n');
{
  const e = await makeVideo('Made in the Studio');
  await makeRender(e.scriptId);
  const sessionId = randomUUID();
  await q(
    `insert into studio_sessions (id, model, spend_cap_inr, script_id)
     values ($1,'claude-opus-5',500,$2)`,
    [sessionId, e.scriptId],
  );
  await ledger({ studio_session_id: sessionId, driver: 'anthropic', quantity: 1200,
                 unit: 'input_token', cost_usd: 0.03, cost_inr: 2.5, entry_kind: 'reconcile' });
  await ledger({ studio_session_id: sessionId, driver: 'anthropic', quantity: 400,
                 unit: 'output_token', cost_usd: 0.06, cost_inr: 5.5, entry_kind: 'reconcile' });

  const s = await expectOk(await readVideoCosts(db));
  const row = s.rows.find((r) => r.scriptId === e.scriptId);
  if (!row) bad('the session’s spend lands on its video');
  else {
    eq('the session’s spend lands on its video', Number(row.measuredInr ?? 0) + Number(row.estimatedInr ?? 0), 8);
    eq('  · filed as studio, not as llm', Object.keys(row.componentInr).join(','), 'studio');
    eq('  · and it counts towards the average', row.denominatorState, 'countable_estimated');
  }

  const stillUnattributed = s.unattributed
    .filter((u) => u.component === 'studio')
    .reduce((a, u) => a + u.rowsN, 0);
  eq('  · the unmaterialised session’s row stays unattributed', stillUnattributed, 1);
}

// ── 5c. Cost by stage, and the stages that have never run ───────────────────────
//
// This section seeds its own stage-carrying rows, so it proves the VIEW'S ARITHMETIC and
// nothing about whether production writes a stage. The first draft of it asserted that
// `05-generate` spend was attributed — against a harness whose ledger rows are all written
// by a local `ledger()` helper that sets no stage at all. It failed, and it was right to:
// I had written the vacuous-precondition bug one round after adding the rule for it.
//
// The claim about production lives in `verify:submit` §4, where a real `submitShots` call
// writes the row. Two assertions that look alike; only one of them can be wrong about the
// world.
console.log('\n5c. Spend per stage, with a denominator\n');
{
  const f = await makeVideo('Staged spend');
  await ledger({ script_id: f.scriptId, stage: '03-script', driver: 'anthropic', quantity: 900,
                 unit: 'input_token', cost_usd: 0.01, cost_inr: 1.5, entry_kind: 'reconcile' });
  await ledger({ script_id: f.scriptId, stage: '03-script', driver: 'anthropic', quantity: 300,
                 unit: 'output_token', cost_usd: 0.02, cost_inr: 2.5, entry_kind: 'reconcile' });

  const s = await expectOk(await readCostByStage(db));

  // LOAD-BEARING. Every other assertion here is a property of rows that exist; this is the
  // only one about rows that do NOT. A stage with no ledger row must come back hasRun:false
  // with null figures, because rendering ₹0 for it claims the stage is free rather than
  // unbuilt — and on this workspace that is most of them.
  const neverRun = s.rows.filter((r) => !r.hasRun);
  if (neverRun.length > 0 && neverRun.every((r) => r.settledInr === null && r.inrPerScript === null)) {
    ok('a stage that never ran reports null, not ₹0', `${neverRun.length} of ${s.rows.length}`);
  } else {
    bad('a stage that never ran reports null, not ₹0', JSON.stringify(neverRun.slice(0, 2)));
  }

  eq('every charging stage appears, run or not', s.rows.length >= CHARGING_STAGES.length, true);

  const llm = s.rows.find((r) => r.stage === '03-script');
  if (llm && llm.hasRun) {
    eq('  · a stage that ran carries its settled total', Number(llm.settledInr), 4);
    eq('  · with the script count as its denominator', llm.scripts, 1);
    eq('  · and a per-script figure derived from it', Number(llm.inrPerScript), 4);
  } else {
    bad('  · a stage that ran carries its settled total', JSON.stringify(llm));
  }

  // Unpriced poisons the stage total rather than shrinking it.
  await ledger({ script_id: f.scriptId, stage: '03-script', driver: 'anthropic', quantity: 1,
                 unit: 'thinking_token', cost_usd: 0, cost_inr: null, entry_kind: 'reconcile' });
  const after = await expectOk(await readCostByStage(db));
  const poisoned = after.rows.find((r) => r.stage === '03-script');
  if (poisoned.settledInr === null && poisoned.inrPerScript === null) {
    ok('one unpriced row makes the stage total unknown', 'not smaller');
  } else {
    bad('one unpriced row makes the stage total unknown', JSON.stringify(poisoned));
  }
  eq('  · and says how many rows it could not price', poisoned.unpricedRows, 1);
}

// ── 6. Exhaustiveness ───────────────────────────────────────────────────────────
console.log('\n6. The two views are exhaustive over the ledger\n');
{
  const s = await expectOk(await readVideoCosts(db));
  const { rows: [{ n }] } = await q(`select count(*)::int as n from cost_ledger`);
  const attributed = s.rows.reduce((acc, r) => acc + r.ledgerRows, 0);
  const unattributed = s.unattributed.reduce((acc, u) => acc + u.rowsN, 0);
  eq('every ledger row lands in exactly one of the two', attributed + unattributed, n);
  if (attributed + unattributed === n) {
    console.log('        a narrowed denominator would show up here, not on the dashboard');
  }
}

// ── 7. Two hook variants are one video ──────────────────────────────────────────
console.log('\n7. Two renders of one script\n');
{
  await makeRender(a.scriptId);
  const s = await expectOk(await readVideoCosts(db));
  const row = s.rows.find((r) => r.scriptId === a.scriptId);
  eq('still one row', s.rows.filter((r) => r.scriptId === a.scriptId).length, 1);
  eq('  · with two renders counted', row.renders, 2);
  eq('  · and the drafting cost not doubled', Number(row.measuredInr ?? 0) + Number(row.estimatedInr ?? 0), 45.01);
}

// ── 8. Broken is not empty ──────────────────────────────────────────────────────
//
// Last, because it destroys the view. On this screen the comfortable misreading of a blank
// page is "nothing has cost anything", so the broken case has to be distinguishable
// without anybody suspecting it first.
console.log('\n8. A failed read does not render as a free pipeline\n');
{
  await q('drop view v_video_cost');
  const r = await readVideoCosts(db);
  if (r.ok === false) ok('the read reports failure', r.error.slice(0, 60));
  else bad('the read reports failure', 'it returned rows');
  if (r.ok === false && /0026|migration/i.test(r.hint)) {
    ok('  · and names the missing migration rather than blaming the data');
  } else bad('  · and names the missing migration rather than blaming the data', r.ok ? '' : r.hint);
}

await scratch.release();

console.log('');
if (failures > 0) {
  console.error(`${failures} failure(s).\n`);
  process.exit(1);
}
console.log('Cost per video is a set of rows with a stated denominator, and the ledger balances.\n');
process.exit(0);
