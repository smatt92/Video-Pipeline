#!/usr/bin/env node
/**
 * Stage 6 — the voice chain's state, and the ledger statement that could not run.
 *
 * PROVES:  `readVoiceStatus` names where the chain stops rather than counting takes; a
 *          script with no takes reports null seconds rather than zero; `stitched_untimed`
 *          — the state that made 03 → 04 → 05 provably inert — is detected; and the
 *          `cost_ledger` write stage 6 performs succeeds against the real index, with a
 *          retry landing as a duplicate rather than an error.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Stage 6 was the only money-spending stage with no database harness. `test:timings`
 * exercises the character→word arithmetic and never touches a ledger, so the fourth
 * instance of this project's `ON CONFLICT`-against-a-partial-index defect sat in
 * `voice/run.ts` untouched: `onConflict: 'script_id,stage,entry_kind,unit'` cannot infer
 * `cost_ledger_script_stage_entry_key`, which is partial (`where script_id is not null`)
 * *and* keyed on an expression (`coalesce(stage,'')`). ElevenLabs would bill for the speech
 * and no row would land.
 *
 * DOES NOT PROVE — read this before calling stage 6 verified
 *
 * The vendor call itself. `runVoice` needs a real audio driver and a real asset upload;
 * this drives the two parts that need neither, which is the state machine and the ledger
 * statement. Section 3 is the regression test for the defect, not a run of the stage.
 *
 * Usage: node scripts/verify-voice.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-voice.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { readVoiceStatus } = require(`${BUILD}/voice/status.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => { console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const eq = (l, a, e) => (a === e ? ok(l, String(a)) : bad(l, `expected ${e}, got ${a}`));

const scratch = await scratchDatabase(dbUrl, 'voice');
const client = scratch.client;
const db = supabaseShim(client);
const q = (sql, params = []) => client.query(sql, params);

const expectOk = (r) => {
  if (!r.ok) { bad('the read succeeded', `${r.error} — ${r.hint}`); process.exit(1); }
  return r;
};

console.log('\nStage 6 — where the voice chain stops\n');

const channelId = randomUUID();
await q(
  `insert into channels (id, name, platform, niche, host_voice_id)
   values ($1,'verify-voice','youtube','verification','voice-abc')`,
  [channelId],
);

let n = 0;
async function makeScript() {
  n += 1;
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  await q(
    `insert into concepts (id, channel_id, title, angle, rubric_version)
     values ($1,$2,$3,'an angle','v1')`,
    [conceptId, channelId, `Concept ${n}`],
  );
  await q(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1,$2,'hook','[]'::jsonb,'the words that are spoken','claude-opus-5',$3)`,
    [scriptId, conceptId, `voice-${n}`],
  );
  return scriptId;
}

async function makeShots(scriptId, count, timed) {
  for (let i = 0; i < count; i += 1) {
    await q(
      `insert into shots (id, script_id, idx, description, shot_kind, duration_s, duration_source)
       values ($1,$2,$3,'a shot','establishing',3,$4)`,
      [randomUUID(), scriptId, i, i < timed ? 'derived_from_vo' : 'authored'],
    );
  }
}

async function makeTake(scriptId, { stitched = true, durationS = 4.2, chars = 120, idx = 0 } = {}) {
  await q(
    `insert into vo_takes (id, script_id, chunk_idx, driver, model, voice_id, text_in,
                           request_id, duration_s, characters_billed, cost_inr)
     values ($1,$2,$3,'elevenlabs','v3','voice-abc','some words',$4,$5,$6,$7)`,
    [randomUUID(), scriptId, idx, stitched ? `req-${randomUUID()}` : null, durationS, chars, 1.1],
  );
}

// ── 0. An empty workspace ───────────────────────────────────────────────────────
console.log('0. Nothing has been scripted yet\n');
{
  const s = expectOk(await readVoiceStatus(db));
  eq('no rows', s.rows.length, 0);
  eq('  · reported as an empty workspace, not a stuck one', s.noScripts, true);
}

// ── 1. Every state the chain can stop in ────────────────────────────────────────
console.log('\n1. Where the chain stops, as a state\n');
const scripts = {};
{
  scripts.no_shots = await makeScript();

  scripts.not_started = await makeScript();
  await makeShots(scripts.not_started, 3, 0);

  scripts.takes_unstitched = await makeScript();
  await makeShots(scripts.takes_unstitched, 3, 0);
  await makeTake(scripts.takes_unstitched, { stitched: true, idx: 0 });
  await makeTake(scripts.takes_unstitched, { stitched: false, idx: 1 });

  scripts.stitched_untimed = await makeScript();
  await makeShots(scripts.stitched_untimed, 3, 0);
  await makeTake(scripts.stitched_untimed);

  scripts.partially_timed = await makeScript();
  await makeShots(scripts.partially_timed, 3, 1);
  await makeTake(scripts.partially_timed);

  scripts.timed = await makeScript();
  await makeShots(scripts.timed, 3, 3);
  await makeTake(scripts.timed);

  const s = expectOk(await readVoiceStatus(db));
  const byId = new Map(s.rows.map((r) => [r.scriptId, r]));

  for (const [state, id] of Object.entries(scripts)) {
    const row = byId.get(id);
    if (row?.voState === state) ok(`${state}`, `${row.shotsTimed}/${row.shots} shots timed`);
    else bad(`${state}`, JSON.stringify(row));
  }

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // Every assertion above checks that a state is *labelled* right. This one is why the
  // screen exists. `stitched_untimed` is the state 03 → 04 → 05 sat in for a week with
  // fifteen harnesses green: the voice exists, no shot has a measured duration, stage 5
  // refuses every shot, and nothing anywhere raises an error — because "nothing came out"
  // is the absence of an error, not one.
  //
  // The distinction that makes it load-bearing: `stitched_untimed` and `not_started` are
  // both "no timed shots", and only one of them means money has already been spent. A
  // screen that merged them would be the reassuring one.
  const stuck = byId.get(scripts.stitched_untimed);
  const idle = byId.get(scripts.not_started);
  if (stuck?.voState === 'stitched_untimed' && idle?.voState === 'not_started') {
    ok('  · spent-and-stuck is distinguished from never-started', 'both have 0 timed shots');
  } else {
    bad('  · spent-and-stuck is distinguished from never-started', `${stuck?.voState} / ${idle?.voState}`);
  }

  const dist = Object.fromEntries(s.distribution.map((d) => [d.state, d.n]));
  eq('  · and the distribution is the artifact, not the list', dist.stitched_untimed, 1);
}

// ── 2. No measured speech is not silence ────────────────────────────────────────
console.log('\n2. Absent and zero\n');
{
  const s = expectOk(await readVoiceStatus(db));
  const none = s.rows.find((r) => r.scriptId === scripts.not_started);
  if (none.totalDurationS === null && none.charactersBilled === null) {
    ok('a script with no takes reports null seconds', 'not 0s of speech');
  } else {
    bad('a script with no takes reports null seconds', JSON.stringify(none));
  }

  const some = s.rows.find((r) => r.scriptId === scripts.timed);
  eq('  · while a script with takes reports the measurement', Number(some.totalDurationS), 4.2);

  // A take the vendor returned without a duration. `?? 0` here would hand the assembler a
  // measurement it never made, in the path where three duration bugs have already shipped.
  const unmeasured = await makeScript();
  await makeShots(unmeasured, 1, 0);
  await q(
    `insert into vo_takes (id, script_id, chunk_idx, driver, model, voice_id, text_in, request_id)
     values ($1,$2,0,'elevenlabs','v3','voice-abc','words',$3)`,
    [randomUUID(), unmeasured, `req-${randomUUID()}`],
  );
  const after = expectOk(await readVoiceStatus(db));
  const u = after.rows.find((r) => r.scriptId === unmeasured);
  if (u.totalDurationS === null && u.unmeasuredTakes === 1) {
    ok('an unmeasured take makes the total unknown', 'and says how many could not be measured');
  } else {
    bad('an unmeasured take makes the total unknown', JSON.stringify(u));
  }
}

// ── 3. The ledger statement that could not run ──────────────────────────────────
console.log('\n3. The cost write, against the real index\n');
{
  const scriptId = await makeScript();
  const { rows: [{ concept_id }] } = await q(`select concept_id from scripts where id = $1`, [scriptId]);

  const row = {
    script_id: scriptId,
    concept_id,
    driver: 'elevenlabs',
    stage: '06-voice',
    entry_kind: 'reconcile',
    unit: 'character',
    quantity: 1200,
    cost_usd: 0.036,
    cost_inr: 3.19,
    usd_inr_rate: 88.5,
  };

  // The statement the fix produces. Insert, not upsert.
  const { error: first } = await db.from('cost_ledger').insert(row);
  if (!first) ok('the insert lands', '₹3.19 for 1200 characters');
  else bad('the insert lands', first.message);

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // The defect was `upsert(..., { onConflict: 'script_id,stage,entry_kind,unit' })`, which
  // cannot infer `cost_ledger_script_stage_entry_key` — partial (`where script_id is not
  // null`) AND keyed on an expression (`coalesce(stage,'')`). It failed on every call, so
  // ElevenLabs billed and no row landed. Rule 5's headline failure.
  //
  // This asserts the shape the *upsert* would have taken still fails, so the fix cannot be
  // reverted silently by someone who finds `insert`-and-catch uglier.
  const { error: viaUpsert } = await db
    .from('cost_ledger')
    .upsert({ ...row, quantity: 1300 }, { onConflict: 'script_id,stage,entry_kind,unit', ignoreDuplicates: true });
  if (viaUpsert && /no unique or exclusion constraint/i.test(viaUpsert.message)) {
    ok('  · and the upsert this replaced still cannot run', 'partial index, expression key');
  } else {
    bad('  · and the upsert this replaced still cannot run', viaUpsert?.message ?? 'it succeeded');
  }

  // A retry of a take already charged comes back as a duplicate, which the caller swallows.
  const { error: retry } = await db.from('cost_ledger').insert(row);
  if (retry && /duplicate key|unique constraint/i.test(retry.message)) {
    ok('  · while a retry is a duplicate, not a second charge', 'the constraint doing its job');
  } else {
    bad('  · while a retry is a duplicate, not a second charge', retry?.message ?? 'it inserted twice');
  }
}

await scratch.release();

console.log('');
if (failures > 0) {
  console.error(`${failures} failure(s).\n`);
  process.exit(1);
}
console.log(
  'Stage 6 names where it stopped, distinguishes spent-and-stuck from never-started,\n' +
    'and its ledger write reaches the database. What this cannot tell you: whether the\n' +
    'voice sounds right. That needs the vendor and a pair of ears.\n',
);
process.exit(0);
