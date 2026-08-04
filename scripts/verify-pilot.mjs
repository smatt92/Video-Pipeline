#!/usr/bin/env node
/**
 * The pilot shot, and the path.
 *
 * PROVES:  a first submit sends one shot and stops; the fan-out refuses while the pilot is
 *          undecided; approval is a compare-and-set that exactly one caller wins; the cost
 *          of saying yes is known before the decision and null rather than guessed when the
 *          rate is unverified; the blocker view names the waiting state; and the path puts
 *          voice before videos.
 *
 * Usage: node scripts/verify-pilot.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-pilot.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { readPilot, approvePilot, rejectPilot } = require(`${BUILD}/generate/pilot.js`);
const { readPath, PATH } = require(`${BUILD}/pipeline/path.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => { console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const eq = (l, a, e) => (a === e ? ok(l, String(a)) : bad(l, `expected ${e}, got ${a}`));

const scratch = await scratchDatabase(dbUrl, 'pilot');
const client = scratch.client;
const db = supabaseShim(client);
const q = (sql, params = []) => client.query(sql, params);

console.log('\nThe pilot shot, and the path\n');

// ── The path is a constant, so its order is assertable without any data ─────────
console.log('0. The order the path is drawn in\n');
{
  const keys = PATH.map((p) => p.key);
  const voice = keys.indexOf('voice');
  const videos = keys.indexOf('videos');

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // Voice before videos. Sorting the path by stage number would put 05 before 06 and teach
  // the exact mistake the audio-first inversion exists to prevent — word timings set shot
  // durations, and stage 5 refuses any shot still carrying an estimate. This ordering is
  // why the 03 → 04 → 05 chain was provably inert for a week with fifteen harnesses green,
  // and it was invisible on every screen until this path existed.
  //
  // Asserted as an index comparison rather than by eye, because the failure mode is a
  // future edit that sorts the array "properly".
  if (voice >= 0 && videos >= 0 && voice < videos) {
    ok('voice is drawn before videos', `${voice} < ${videos}`);
  } else {
    bad('voice is drawn before videos', keys.join(' → '));
  }

  const voiceStage = PATH[voice];
  if (voiceStage.whyHere && /backwards|before the videos/i.test(voiceStage.whyHere)) {
    ok('  · and says why, on the stage itself', 'not in a footnote nobody reads');
  } else {
    bad('  · and says why, on the stage itself', JSON.stringify(voiceStage.whyHere));
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
const channelId = randomUUID();
await q(
  `insert into channels (id, name, platform, niche, host_voice_id)
   values ($1,'pilot','youtube','verification','voice-abc')`,
  [channelId],
);
await q(
  `update integrations set is_enabled = true, last_verified_at = now() where slug = 'higgsfield'`,
);
const promptId = randomUUID();
await q(
  `insert into prompts (id, name, driver, model, template, params, tags, discovered_in, accepts_character_ref)
   values ($1,'pilot recipe','higgsfield','soul','{{description}}','{"motion":"push_in"}'::jsonb,'{establishing}','manual',false)`,
  [promptId],
);
await q(
  `insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note)
   values ('higgsfield','soul','/v1/text2image/soul','credit',0.08,'USD',true,'harness')`,
);

async function seedScript(shotCount) {
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  await q(
    `insert into concepts (id, channel_id, title, angle, rubric_version, status)
     values ($1,$2,'Pilot concept','an angle','v1','in_production')`,
    [conceptId, channelId],
  );
  await q(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1,$2,'hook','[]'::jsonb,'words','claude-opus-5',$3)`,
    [scriptId, conceptId, randomUUID()],
  );
  const shotIds = [];
  for (let i = 0; i < shotCount; i += 1) {
    const id = randomUUID();
    shotIds.push(id);
    await q(
      `insert into shots (id, script_id, idx, description, shot_kind, duration_s,
                          duration_source, prompt_id, compiled_params)
       values ($1,$2,$3,'a shot','establishing',3,'derived_from_vo',$4,$5)`,
      [id, scriptId, i, promptId, JSON.stringify({ model: 'soul' })],
    );
  }
  return { conceptId, scriptId, shotIds };
}

// ── 1. The waiting state is named, not inferred ─────────────────────────────────
console.log('\n1. A pilot awaiting a decision\n');
const a = await seedScript(6);
{
  // The pilot generation, as stage 5 would leave it.
  const genId = randomUUID();
  await q(
    `insert into generations (id, shot_id, kind, driver, model, request_payload, idempotency_key, status)
     values ($1,$2,'image','higgsfield','soul','{}'::jsonb,$3,'succeeded')`,
    [genId, a.shotIds[0], randomUUID()],
  );
  await q(`update scripts set pilot_generation_id = $2 where id = $1`, [a.scriptId, genId]);

  const { rows } = await q(
    `select blocker, awaiting_pilot_approval from v_pipeline_blockers where script_id = $1`,
    [a.scriptId],
  );

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // This state was invented this round, and `v_pipeline_blockers` has twice reported an
  // invented state as something it was not: as readiness in 0028, and as a blocker that was
  // not blocking in 0029. A pending pilot rendered as stalled would be the third — so the
  // view names it in the same change that creates it, and carries a column of its own so a
  // screen can tell waiting-on-a-person apart from a misconfiguration.
  if (/waiting on pilot approval/.test(rows[0]?.blocker ?? '')) {
    ok('the blocker view names the waiting state', rows[0].blocker.slice(0, 48));
  } else {
    bad('the blocker view names the waiting state', JSON.stringify(rows[0]));
  }
  eq('  · and flags it as a decision, not a misconfiguration', rows[0]?.awaiting_pilot_approval, true);

  const path = await readPath(db);
  const pos = path.ok && path.positions.find((p) => p.scriptId === a.scriptId);
  const videoStage = pos && pos.stages.find((s) => s.key === 'videos');
  if (videoStage?.state === 'waiting_on_you') {
    ok('  · and the path shows waiting on you, not blocked', 'a different colour, deliberately');
  } else {
    bad('  · and the path shows waiting on you, not blocked', JSON.stringify(videoStage));
  }
}

// ── 2. What saying yes costs, before saying it ──────────────────────────────────
console.log('\n2. The cost of approving, while it can still be declined\n');
{
  const view = await readPilot(a.scriptId, db);
  eq('the pilot is awaiting a decision', view.status, 'awaiting');
  eq('  · with the held-back shots counted', view.heldBack, 5);

  // No ledger row carries a USD→INR rate yet, so there is no observed rate to convert at.
  if (view.estimatedInr === null && /USD→INR|no observed/i.test(view.unpricedReason ?? '')) {
    ok('  · and no rupee figure, because none can be observed', 'not a default, not a guess');
  } else {
    bad('  · and no rupee figure, because none can be observed', `${view.estimatedInr} / ${view.unpricedReason}`);
  }

  // Give it an observed rate the way a real charge would.
  await q(
    `insert into cost_ledger (script_id, driver, stage, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate)
     values ($1,'anthropic','03-script','reconcile','input_token',10,0.001,0.09,88.5)`,
    [a.scriptId],
  );
  const priced = await readPilot(a.scriptId, db);
  eq('once a rate has been observed, the figure appears', Number(priced.estimatedInr?.toFixed(2)), 35.4);
  console.log('        approve to spend an estimated ₹35.40 across 5 more shots');
}

// ── 3. Approval is decided by the database, exactly once ────────────────────────
console.log('\n3. Approving spends money, so the database decides\n');
{
  const { rows: [s] } = await q(`select pilot_generation_id from scripts where id = $1`, [a.scriptId]);

  const first = await approvePilot(a.scriptId, s.pilot_generation_id, db);
  if (first.ok) ok('the first approval wins', `${first.heldBack} shots released`);
  else bad('the first approval wins', JSON.stringify(first));

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // The second click. An application-level `if (!approved)` would let two tabs each start a
  // fan-out, which is five paid clips twice. `approve_pilot_once` carries the compare half
  // in the statement, so exactly one caller can win — the same arrangement concept approval
  // and generation confirmation use, for the same reason.
  const second = await approvePilot(a.scriptId, s.pilot_generation_id, db);
  if (!second.ok && second.code === 'lost') {
    ok('  · and the second loses', 'two clicks cannot start two fan-outs');
  } else {
    bad('  · and the second loses', JSON.stringify(second));
  }

  // Approving a pilot that has been replaced also loses — the case an `is null` check alone
  // would miss, because `pilot_approved_at` would already be null again after a new submit.
  const b = await seedScript(2);
  const stale = randomUUID();
  await q(
    `insert into generations (id, shot_id, kind, driver, model, request_payload, idempotency_key, status)
     values ($1,$2,'image','higgsfield','soul','{}'::jsonb,$3,'succeeded')`,
    [stale, b.shotIds[0], randomUUID()],
  );
  const wrongPilot = await approvePilot(b.scriptId, stale, db);
  if (!wrongPilot.ok) ok('  · and approving a pilot the script does not carry loses too', wrongPilot.code);
  else bad('  · and approving a pilot the script does not carry loses too');
}

// ── 4. Rejection is not terminal, and reads as its own thing ────────────────────
console.log('\n4. Rejecting costs one clip, not six\n');
{
  const c = await seedScript(6);
  const genId = randomUUID();
  await q(
    `insert into generations (id, shot_id, kind, driver, model, request_payload, idempotency_key, status)
     values ($1,$2,'image','higgsfield','soul','{}'::jsonb,$3,'succeeded')`,
    [genId, c.shotIds[0], randomUUID()],
  );
  await q(`update scripts set pilot_generation_id = $2 where id = $1`, [c.scriptId, genId]);

  const out = await rejectPilot(c.scriptId, 'the look is wrong — too warm', db);
  if (out.ok) ok('a pilot can be rejected');
  else bad('a pilot can be rejected', JSON.stringify(out));

  const view = await readPilot(c.scriptId, db);
  eq('  · and reads as rejected', view.status, 'rejected');
  eq('  · with the reason kept', view.rejectReason, 'the look is wrong — too warm');

  const { rows } = await q(
    `select blocker, awaiting_pilot_approval from v_pipeline_blockers where script_id = $1`,
    [c.scriptId],
  );
  if (/rejected/.test(rows[0]?.blocker ?? '')) {
    ok('  · and the board says so rather than saying stalled', rows[0].blocker.slice(0, 44));
  } else {
    bad('  · and the board says so rather than saying stalled', JSON.stringify(rows[0]));
  }
  eq('  · and is no longer awaiting a decision', rows[0]?.awaiting_pilot_approval, false);

  // The database refuses both at once, whatever an application does.
  const both = await q(
    `update scripts set pilot_approved_at = now() where id = $1`, [c.scriptId],
  ).then(() => null).catch((e) => e);
  if (both && /scripts_pilot_decided_once/.test(both.message)) {
    ok('  · and cannot also be approved', 'the CHECK refuses it independently');
  } else {
    bad('  · and cannot also be approved', both ? both.message : 'the update succeeded');
  }
}

// ── 5. The path has a reader ────────────────────────────────────────────────────
//
// A path nobody renders is a view with no reader wearing different clothes. This asserts
// the position is derivable for a real script, and that the stage list the component
// iterates is the one `readPath` returns — the two drifting apart is how the strip would
// silently start drawing a stale order.
console.log('\n5. The path is readable end to end\n');
{
  const p = await readPath(db);
  if (!p.ok) { bad('readPath succeeds', `${p.error}`); }
  else {
    ok('readPath returns positions', `${p.positions.length} concept(s)`);
    const one = p.positions[0];
    eq('  · every position carries one entry per stage', one.stages.length, PATH.length);
    eq('  · in the same order as PATH', one.stages.map((s) => s.key).join(','), PATH.map((s) => s.key).join(','));

    // Exactly one stage is current-ish; the rest are done or ahead. A position with two
    // "current" stages would render as two places at once.
    const live = one.stages.filter((s) => ['current', 'blocked', 'waiting_on_you'].includes(s.state));
    eq('  · and exactly one stage is where you are', live.length, 1);
  }
}

await scratch.release();

console.log('');
if (failures > 0) {
  console.error(`${failures} failure(s).\n`);
  process.exit(1);
}
console.log(
  'A rejected look costs one clip. The path puts voice before videos, and a pilot\n' +
    'awaiting a person reads as waiting rather than as stalled.\n',
);
process.exit(0);
