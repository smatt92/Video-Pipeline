#!/usr/bin/env node
/**
 * verify:engineered — the "3D explainer" video type (0052), against a STUB image vendor, a stub
 * writer/rewrite model and a stub renderer. Nothing here can spend.
 *
 *   §1 Routing (pure): key = clips on the action beats (≤ 4), full = clips on every scene beat,
 *      cutaways and diagrams are never clips, no marked beat → 3 evenly spaced, no pictures →
 *      the overlay everywhere.
 *   §2 The script: the writer's draft (Zod) → the evolution shape checked in code (each broken
 *      rule refused by name) → a brief the channel's schema accepts, one narrator line per beat.
 *   §3 Numbers sourced or hedged: unhedgedNumbers, and policy_lint flags an unhedged figure in
 *      the script or on a meter — and leaves a brief that is not a 3D explainer alone.
 *   §4 Key vs full priced on Approvals. LOAD-BEARING: the Approvals figure for "key", the
 *      planner's episodes.estimate_inr and a price the harness computes itself from the shots
 *      the planner WROTE and the rate card agree — three routes to one number.
 *   §5 Hero-object sheets: ledger estimate before each vendor call, locked automatically, a
 *      replay pays nothing. LOAD-BEARING (the accepting branch): every picture is submitted with
 *      exactly the sheet URIs the harness saw stored and the tags of that beat's objects; a beat
 *      whose object has no sheet names it, untagged, and passes no reference.
 *   §6 Picture clips: each animates THAT shot's stored picture (the key the harness saw put);
 *      the refusal "no picture to animate" and its accepting half.
 *   §7 Graphics → Remotion props: every beat's graphics on its own frames, captions of 2–4
 *      words, each beat's keyword coloured once with its role; a clip that never came back is
 *      drawn as its picture and recorded.
 *   §8 Bureau untouched: its formats price as before, the new type is offered, its policy lint
 *      does not change.
 *   §9 The channel: Built Like That made through createChannel from its folder bible; series
 *      default engineered / key / brisk; the narrator never on screen; publish targets off.
 *  §10 Before 0052: the probe says unavailable, Approvals disables the type, and the planner
 *      plans it as illustrated, recording why.
 *  §11 A REAL Remotion render (bundled, headless Chromium) of two beats of those props: it
 *      bundles (the first version did not — an `@/` import the bundler cannot resolve, which a
 *      stub renderer can never see), and the verdict pill is in the frame, read back as pixels.
 *
 * Seeds inputs (rate card from the migrations, FX, a verified integration, timings for the
 * voice); asserts what the code under test wrote and what the stub vendor received.
 *
 * Usage: node scripts/verify-engineered.mjs <db-url>
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-engineered.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { BUREAU_CHANNEL_ID: BUREAU } = require(`${B}/fixtures/seed-channel.js`);
const { mintBureauToken } = require(`${B}/bureau/tokens.js`);
const { createChannel, importFolderBible } = require(`${B}/channels/bible-admin.js`);
const { setPublishTarget } = require(`${B}/channels/add.js`);
const { getBible } = require(`${B}/bureau/bible.js`);
const P = require(`${B}/bureau/episode-steps.js`);
const F = require(`${B}/bureau/formats.js`);
const E = require(`${B}/bureau/engineered.js`);
const { unhedgedNumbers } = require(`${B}/bureau/hedge.js`);
const { policyLint } = require(`${B}/bureau/policy-lint.js`);
const { createBriefs } = require(`${B}/bureau/briefs.js`);
const { draftBriefForSlot } = require(`${B}/bureau/brief-generator.js`);
const { formatOptions } = require(`${B}/bureau/format-estimates.js`);
const { estimateEpisode } = require(`${B}/bureau/estimate.js`);
const { parseScript } = require(`${B}/bureau/script-lines.js`);
const OS = require(`${B}/bureau/object-sheets.js`);
const { chunkWords } = require(`${B}/bureau/engineered-captions.js`);
const { renderBureau } = require(`${B}/bureau/layer-render.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const check = (c, l, d = '') => {
  if (c) console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
  else {
    console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
    failures++;
  }
};
const scratch = await scratchDatabase(dbUrl, 'engineered');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
const round2 = (n) => Math.round(n * 100) / 100;
/** Key-order-free JSON (jsonb stores keys in its own order). */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/engineered-draft.json', import.meta.url), 'utf8'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
/** Every key the code put in the bucket, in order — the harness's own record of storage. */
const puts = [];
const putBytes = async (key, body) => {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  puts.push(key);
  return Buffer.concat(chunks).length;
};
const BUCKET = 'https://bucket.test/';
const resolveRef = async (ref) => {
  if (!ref.startsWith('storage:')) throw new Error(`not ours: ${ref}`);
  return `${BUCKET}${ref.slice('storage:'.length)}`;
};

/** The image vendor: records each request and how many estimate rows existed at submit. `fail` → that prompt fails. */
function vendor(fail = () => false) {
  const calls = [];
  return {
    calls,
    submit: async (i) => {
      const est = Number((await q(`select count(*)::int n from cost_ledger cl join generations g on g.id = cl.generation_id where g.status = 'submitting' and cl.entry_kind = 'estimate'`))[0].n);
      calls.push({ ...i, estimatesAtSubmit: est });
      return { ok: true, taskId: `task_${calls.length}` };
    },
    wait: async ({ taskId }) => {
      const c = calls[Number(taskId.slice(5)) - 1];
      return fail(c.prompt) ? { state: 'failed', code: 'upstream', detail: 'stub refused', retryAfterS: null, charged: null } : { state: 'succeeded', outputUrl: 'https://vendor.test/out.png', charged: { quantity: 5, unit: 'credit', usd: 0.05 } };
    },
    fetchBytes: async () => PNG,
  };
}

/** The model: the brief writer returns the fixture (decode shape); the picture rewrite uses exactly the tags it is given. */
const decoded = (d) => ({
  ...d,
  beats: d.beats.map((b) => ({
    ...b,
    graphics: {
      badge: b.graphics.badge ?? null,
      verdict: b.graphics.verdict ? { pass: b.graphics.verdict.pass, text: b.graphics.verdict.text, sub: b.graphics.verdict.sub ?? null } : null,
      callouts: (b.graphics.callouts ?? []).map((c) => ({ label: c.label, x: c.x ?? null, y: c.y ?? null })),
      meters: (b.graphics.meters ?? []).map((m) => ({ label: m.label, from: m.from ?? null, to: m.to ?? null, value: m.value ?? null, unit: m.unit })),
      keyword: b.graphics.keyword ?? null,
    },
  })),
});
let writerOutput = decoded(FIXTURE);
const llmCalls = [];
const llmClient = {
  messages: {
    parse: async (body) => {
      const user = String(body.messages[0].content);
      const system = String(body.system ?? '');
      llmCalls.push({ system, user });
      if (/3D explainers/.test(system)) return { usage: { input_tokens: 1500, output_tokens: 3000 }, stop_reason: 'end_turn', parsed_output: writerOutput };
      const tags = [...user.matchAll(/^- @([A-Za-z0-9_]+) \(/gm)].map((m) => `@${m[1]}`);
      const pic = /BEAT PICTURE: (.*)/.exec(user)?.[1] ?? 'a rail yard';
      const scene = `${tags.length ? `${tags.join(' and ')} in a clean studio rail yard. ` : ''}${pic}`.slice(0, 590);
      return { usage: { input_tokens: 400, output_tokens: 60 }, stop_reason: 'end_turn', parsed_output: { scene } };
    },
  },
};

console.log('\n3D explainer — routing, the script, sheets, clips, graphics and the channel\n');
try {
  // ── The world: inputs ─────────────────────────────────────────────────────
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'sahil@invalid.test', 88) returning id`);
  await q(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('runway', 'video', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);
  await q(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('anthropic', 'llm', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);
  await importFolderBible(db, { channelId: BUREAU, slug: 'bureau-of-reality', by: 'verify:engineered' });
  const actor = { scope: 'approver', profileId: prof.id, via: 'verify:engineered' };
  const RATE = Object.fromEntries((await q(`select model, unit, unit_cost from rate_card where driver = 'runway' and is_verified and model in ('gen4_image','gen4_turbo','eleven_v3')`)).map((r) => [`${r.model}/${r.unit}`, Number(r.unit_cost)]));
  const PIC_INR = RATE['gen4_image/image_720p'] * 88;
  const CLIP_S_INR = RATE['gen4_turbo/second'] * 88;
  const VOICE_C_INR = RATE['eleven_v3/character'] * 88;
  check(Math.abs(PIC_INR - 4.4) < 1e-9 && Math.abs(CLIP_S_INR - 4.4) < 1e-9 && Math.abs(VOICE_C_INR - 0.0176) < 1e-12, 'the rate card the prices rest on: ₹4.40 a picture, ₹4.40 a clip-second, ₹0.0176 a character (read from the rows)', JSON.stringify(RATE));
  const [recipe] = await q(`select driver, model, is_active, params from prompts where name = 'engineered-picture-clip-gen4-turbo'`);
  check(recipe?.is_active === false && recipe.model === 'gen4_turbo' && recipe.params.route === 'picture_clip', '0052 seeds the picture-clip recipe RETIRED, naming its route — a migration switches no spend on', JSON.stringify(recipe));
  // Retired: the motion levels price no clip. Asserted before the bundle's activation below.
  const noRecipe = await estimateEpisode(db, { shots: [{ route: 'picture_clip', description: 'x', duration_s: 2.5, characters: [], realistic: false }], voChars: 0, usdInrRate: 88, channelId: BUREAU });
  check(noRecipe.total_inr === null && /no active recipe for picture_clip/.test(noRecipe.unpriced.join()), 'retired: a picture clip is unpriced, "no active recipe" — the cap fitter will plan it as its picture', noRecipe.unpriced.join());
  // What bundle 10b does, as the same statement (docs/bureau/hosted-10b-built-like-that.sql).
  await q(`update prompts set is_active = true, retired_at = null, retired_reason = null where name = 'engineered-picture-clip-gen4-turbo' and version = 1`);

  // ═══ §9 first: the channel the rest runs on ═══
  console.log('9. Built Like That, made through createChannel from its folder bible\n');
  const made = await createChannel(db, actor, { name: 'Built Like That', slug: 'built-like-that', handle: '@BuiltLikeThat', instagram_handle: '@BuiltLikeThat', niche: 'How everyday engineering works and why it is built that way', targets: ['youtube', 'instagram'], template: 'built-like-that' });
  check(made.ok, 'createChannel from the built-like-that template', made.ok ? made.message : made.refused);
  const CH = made.channelId;
  for (const platform of ['youtube', 'instagram']) await setPublishTarget(db, CH, { platform, enabled: false, handle: '@BuiltLikeThat' });
  const targets = await q('select platform, enabled, handle, external_id from channel_publish_targets where channel_id = $1 order by platform', [CH]);
  check(targets.length === 2 && targets.every((t) => t.enabled === false && t.external_id === null && t.handle === '@BuiltLikeThat'), 'publish targets: both recorded, both OFF, no account id — Sahil adds the accounts', JSON.stringify(targets));
  await q('update channel_policy set overlay_min_share = 0.25 where channel_id = $1', [CH]);
  const cb = await getBible(db, CH);
  const evo = cb.seriesFor('evolution');
  const ins = cb.seriesFor('inside');
  check(cb.source === 'db' && evo.visual_format === 'engineered' && evo.motion === 'key' && evo.voice_pace === 'brisk' && ins.visual_format === 'engineered' && ins.motion === 'key', 'the bible reads back from the database: both series default to the 3D explainer, key motion, brisk', JSON.stringify({ src: cb.source, evo: [evo.visual_format, evo.motion, evo.voice_pace], ins: [ins.visual_format, ins.motion] }));
  const narr = cb.bible.characters;
  check(narr.length === 1 && narr[0].id === 'narrator' && narr[0].on_screen === false && narr[0].voice.preset_id !== null, 'one cast member: the narrator, never on screen, with a voice preset', JSON.stringify(narr.map((c) => [c.id, c.on_screen, c.voice.preset_id])));
  const [pol] = await q('select per_short_cap_inr, daily_cap_inr, monthly_cap_inr, stills_enabled, overlay_min_share from channel_policy where channel_id = $1', [CH]);
  check(Number(pol.per_short_cap_inr) === 150 && Number(pol.daily_cap_inr) === 600 && Number(pol.monthly_cap_inr) === 15000 && pol.stills_enabled, 'caps like the Bureau’s (₹150 / ₹600 / ₹15,000), pictures on', JSON.stringify(pol));
  check(cb.trends.youtube?.queries.length >= 2 && cb.trends.wikipedia !== null && cb.trends.hn !== null && cb.trends.subreddits.length === 0, 'trend sources: YouTube science/tech queries, Wikipedia and Hacker News on; Reddit off', JSON.stringify(cb.trends.youtube?.queries));
  const minted = await mintBureauToken(db, { name: 'Sahil', scope: 'approver', channelId: CH, profileId: prof.id });
  const approver = { id: minted.id, name: 'Sahil', scope: 'approver', channelId: CH, profileId: prof.id };

  // ═══ §1 Routing ═══
  console.log('\n1. Routing (pure): key, full, cutaways, fallbacks\n');
  const brief0 = E.engineeredBrief(E.EngineeredDraftSchema.parse(FIXTURE), { narrator: { slug: 'narrator', name: 'Narrator' }, series: { id: 'evolution' } });
  const shots0 = brief0.shot_list;
  const actionIdx = FIXTURE.beats.map((b, i) => (b.action && b.view === 'scene' ? i : -1)).filter((i) => i >= 0);
  const sceneIdx = FIXTURE.beats.map((b, i) => (b.view === 'scene' ? i : -1)).filter((i) => i >= 0);
  const key = F.routesForFormat(shots0, 'engineered', true, 'key').shots;
  const keyClips = key.map((s, i) => (s.route === 'picture_clip' ? i : -1)).filter((i) => i >= 0);
  check(actionIdx.length === 5 && keyClips.length === F.KEY_MAX_CLIPS && keyClips.every((i) => actionIdx.includes(i)) && keyClips.includes(0) && keyClips.includes(13), 'key: four clips, all on action beats (five are marked), the first and last included', JSON.stringify({ actionIdx, keyClips }));
  check(key.every((s, i) => keyClips.includes(i) || s.route === 'still'), 'key: every other beat is a picture');
  const full = F.routesForFormat(shots0, 'engineered', true, 'full').shots;
  const fullClips = full.map((s, i) => (s.route === 'picture_clip' ? i : -1)).filter((i) => i >= 0);
  check(JSON.stringify(fullClips) === JSON.stringify(sceneIdx) && FIXTURE.beats.every((b, i) => (b.view === 'scene') === fullClips.includes(i)), 'full: a clip on every scene beat; the cutaways and the diagram stay pictures', `${fullClips.length} of ${shots0.length}`);
  const unmarked = F.routesForFormat(shots0.map((s) => ({ ...s, action: undefined })), 'engineered', true, 'key');
  check(unmarked.shots.filter((s) => s.route === 'picture_clip').length === F.KEY_FALLBACK_CLIPS && unmarked.swaps.some((x) => /evenly spaced/.test(x.reason)), 'a brief with no action beats: three clips, evenly spaced, and the reason says so', JSON.stringify(unmarked.swaps.filter((x) => x.to === 'picture_clip').map((x) => x.idx)));
  const noPics = F.routesForFormat(shots0, 'engineered', false, 'full').shots;
  check(noPics.every((s) => s.route === 'overlay'), 'no pictures available: every beat is the overlay — nothing to animate either');
  check(JSON.stringify(F.evenlySpaced(5, 4)) === '[0,1,3,4]' && JSON.stringify(F.evenlySpaced(10, 3)) === '[0,5,9]' && JSON.stringify(F.evenlySpaced(2, 5)) === '[0,1]', 'evenlySpaced is deterministic and inclusive of both ends', JSON.stringify([F.evenlySpaced(5, 4), F.evenlySpaced(10, 3)]));
  const illus = F.routesForFormat(shots0, 'illustrated', true).shots;
  check(illus.every((s) => s.route === 'still'), 'the same shots in another format route exactly as before (illustrated: pictures)');
  check(F.motionOf({ approvedEdits: { motion: 'full' }, seriesMotion: 'key' }).motion === 'full' && F.motionOf({ seriesMotion: 'full' }).source === 'series' && F.motionOf({ approvedEdits: { motion: 'bogus' } }).motion === 'key', 'motion: the episode’s pick, else the series’, else key; a bad stored value is ignored');

  // ═══ §2 The script ═══
  console.log('\n2. The script: draft → shape → brief\n');
  const [slot] = await q(`insert into slots (id, channel_id, kind, slot_date, series, series_name, lead, topic, hook, topic_status) values ('B91', $1, 'bank', null, 'evolution', 'Every Attempt Failed', 'narrator', 'Train couplers', 'You used to have to stand between the wagons.', 'bank') returning id`, [CH]);
  const drafted = await draftBriefForSlot(db, slot.id, { db, apiKey: 'test-llm-key', usdInrRate: 88, channelId: CH, client: llmClient });
  check(drafted.ok, 'the writer’s draft becomes a brief through the channel schema', drafted.ok ? '' : drafted.error);
  const writerCall = llmCalls.find((c) => /3D explainers/.test(c.system));
  check(writerCall && /TOPIC B91: "Train couplers"/.test(writerCall.user) && /evolution_chronological/.test(writerCall.user) && /HEDGE every number/.test(writerCall.system), 'the writer was asked under 23-engineered.v1 with the slot’s topic and the series’ variants', writerCall?.user.slice(0, 80));
  const db2 = drafted.ok ? drafted.brief : null;
  const lines = db2 ? db2.script_text.split('\n') : [];
  check(db2 && lines.length === FIXTURE.beats.length && lines.every((l) => l.startsWith('Narrator: ')) && db2.shot_list.length === FIXTURE.beats.length, 'one narrator line and one shot per beat', `${lines.length} lines, ${db2?.shot_list.length} shots`);
  check(db2 && lines.at(-1) === `Narrator: ${FIXTURE.loop_endings[0]}` && JSON.stringify(db2.punchlines) === JSON.stringify(FIXTURE.loop_endings), 'the last line is the first loop ending; the three endings are the punchlines');
  check(db2 && canon(db2.shot_list[4].graphics) === canon(FIXTURE.beats[4].graphics) && db2.shot_list[9].view === 'cutaway' && db2.shot_list[0].action === true && canon(db2.hero_objects) === canon(FIXTURE.hero_objects), 'each shot carries its beat’s graphics, view and action; the hero objects ride along');
  const bad = (mut) => E.evolutionProblems(mut(structuredClone(E.EngineeredDraftSchema.parse(FIXTURE))));
  check(bad((d) => d).length === 0, 'the fixture has the shape (no problems)', JSON.stringify(bad((d) => d)));
  check(bad((d) => ((d.beats[8].graphics.verdict.pass = false), d)).some((p) => /last attempt \(3\) must end on a pass/.test(p)), 'refused: the last attempt fails');
  check(bad((d) => ((d.beats[4].graphics.verdict.pass = true), d)).some((p) => /attempt 1 must fail/.test(p)), 'refused: an earlier attempt passes');
  check(bad((d) => ((d.beats[5].graphics.badge.n = 3), d)).some((p) => /count 1, 2, 3/.test(p)), 'refused: badges that do not count up');
  check(bad((d) => (d.beats.forEach((b) => delete b.graphics.meters), d)).some((p) => /meter/.test(p)), 'refused: no meter');
  check(bad((d) => ((d.beats[0].kind = 'question'), d)).some((p) => /hook/.test(p)), 'refused: no hook first');
  check(bad((d) => ((d.beats[3].objects = ['Gizmo']), d)).some((p) => /"Gizmo", which is not a hero object/.test(p)), 'refused: a picture names an object that is not a hero object');
  check(bad((d) => ((d.beats[2].graphics.verdict = { pass: true, text: 'OK' }), d)).some((p) => /only attempts do/.test(p)), 'refused: a verdict outside an attempt');
  writerOutput = decoded({ ...FIXTURE, beats: FIXTURE.beats.map((b, i) => (i === 8 ? { ...b, graphics: { ...b.graphics, verdict: { ...b.graphics.verdict, pass: false } } } : b)) });
  const refusedDraft = await draftBriefForSlot(db, slot.id, { db, apiKey: 'test-llm-key', usdInrRate: 88, channelId: CH, client: llmClient });
  check(!refusedDraft.ok && /evolution shape/.test(refusedDraft.error) && /must end on a pass/.test(refusedDraft.error), 'a writer draft that breaks the shape is refused by the brief writer, by name', refusedDraft.ok ? 'accepted' : refusedDraft.error.slice(0, 100));
  writerOutput = decoded(FIXTURE);
  check(!E.EngineeredDraftSchema.safeParse({ ...FIXTURE, hero_objects: [{ tag: '9bad tag', name: 'x', look: 'a test object, white' }] }).success, 'Zod refuses a hero-object tag the image model cannot take');

  // ═══ §3 Hedge ═══
  console.log('\n3. Numbers must be sourced or hedged\n');
  check(JSON.stringify(unhedgedNumbers('It holds 350 tonnes of pull.')) === '["350 tonnes"]', 'unhedged: "350 tonnes"');
  check(unhedgedNumbers('It holds roughly 350 tonnes, ≈ 11,000 lb, about 40% more.').length === 0, 'hedged: roughly / ≈ / about');
  check(unhedgedNumbers('Attempt 2 of 3 tries, in 1893.', ['The 1893 Act.']).length === 0, 'counts, years and the sourced fact’s own figure are not claims to hedge');
  check(JSON.stringify(unhedgedNumbers('It stops in 3 s at 12 mph.')) === '["3 s","12 mph"]', 'a small number WITH a unit is a measurement', JSON.stringify(unhedgedNumbers('It stops in 3 s at 12 mph.')));
  const cbB = await getBible(db, BUREAU);
  const lintIn = (b) => ({ ...b, fact: b.fact });
  const clean = policyLint(lintIn(db2), cb);
  check(!clean.violations.some((v) => v.rule === 'unhedged_number'), 'the fixture brief passes the hedge check', JSON.stringify(clean.violations));
  const unhedgedScript = { ...db2, script_text: db2.script_text.replace('roughly 350 tonnes', '350 tonnes') };
  const l1 = policyLint(lintIn(unhedgedScript), cb);
  check(l1.status === 'fail' && l1.violations.some((v) => v.rule === 'unhedged_number' && /350 tonnes/.test(v.detail)), 'an unhedged figure in the script fails policy_lint, naming it', JSON.stringify(l1.violations.map((v) => v.detail)));
  const unhedgedMeter = { ...db2, shot_list: db2.shot_list.map((s, i) => (i === 11 ? { ...s, graphics: { ...s.graphics, meters: [{ ...s.graphics.meters[0], unit: '350 tonnes' }] } } : s)) };
  const l2 = policyLint(lintIn(unhedgedMeter), cb);
  check(l2.violations.some((v) => v.rule === 'unhedged_number'), 'an unhedged figure on a METER fails it too (what the viewer reads)', JSON.stringify(l2.violations.map((v) => v.detail)));
  const bureauScript = 'Pip: The Moon pulls 350 tonnes of sea a second.\nMarlo: Filed.';
  const lb = policyLint({ script_text: bureauScript, fact: { claim: 'The Moon raises tides.', source_url: 'https://oceanservice.noaa.gov/x' } }, cbB);
  check(!lb.violations.some((v) => v.rule === 'unhedged_number'), 'a brief that is not a 3D explainer is not hedge-checked (the Bureau’s lint is unchanged)', JSON.stringify(lb.violations.map((v) => v.rule)));

  // Into the database through the normal path (no embedder → refused variation, flagged; that is fine here).
  const created = await createBriefs([{ ...db2 }], { db, token: approver });
  check(created[0].ok, 'createBriefs stores the engineered brief', JSON.stringify(created[0]));
  const briefId = created[0].brief_id;
  const [stored] = await q('select hero_objects, shot_list, policy from briefs where id = $1', [briefId]);
  check(stored.hero_objects.length === 2 && stored.shot_list[0].graphics.keyword.word === 'between' && stored.policy.status !== 'fail', 'hero_objects and per-shot graphics are on the row; the policy lint did not fail it', stored.policy.status);

  // ═══ §4 Pricing ═══
  console.log('\n4. Key vs full, priced on Approvals — and the planner agrees\n');
  const briefForUi = { series: 'evolution', shot_list: stored.shot_list, script_text: db2.script_text, lead_character: 'narrator', hero_objects: stored.hero_objects };
  const opts = await formatOptions(db, CH, briefForUi);
  const eng = opts.options.find((o) => o.format === 'engineered');
  const mKey = opts.motions.find((m) => m.motion === 'key');
  const mFull = opts.motions.find((m) => m.motion === 'full');
  check(opts.seriesDefault === 'engineered' && opts.seriesMotion === 'key' && eng?.disabled === null && eng?.label === '3D explainer' && /attempt by attempt/.test(eng.blurb), 'Approvals offers "3D explainer", the series default, enabled', JSON.stringify({ d: opts.seriesDefault, m: opts.seriesMotion, eng }));
  check(mKey && mFull && mKey.inr !== null && mFull.inr !== null && eng.inr === mKey.inr, 'both motions are priced; the format’s figure is the series default’s (key)', `key ₹${mKey?.inr} · full ₹${mFull?.inr}`);
  check(mKey.wanted === 4 && mFull.wanted === sceneIdx.length && mKey.clips <= mKey.wanted && mFull.clips <= mFull.wanted, 'clips asked for: key 4, full one per scene beat', JSON.stringify({ key: [mKey.wanted, mKey.clips], full: [mFull.wanted, mFull.clips] }));
  check(mFull.inr >= mKey.inr, 'full costs at least what key does');
  // At the Bureau's ₹150 cap the plan cannot afford every clip: the note says how many and why.
  check(mKey.clips < mKey.wanted ? /planned as pictures: over the ₹150 per-Short cap/.test(mKey.note ?? '') : mKey.note === null, 'when the cap takes clips away, the note says how many and why', mKey.note ?? '(none)');

  // The planner, on an approved copy of this brief.
  // Approvals prices the brief's script, whose last line is the first loop ending; the planner
  // voices the ending the approver chose. Choosing the first keeps the voice the same length, so
  // the price comparison below compares routing and nothing else. (A different ending changes
  // the voice cost by its characters — found by the first run of this section: ₹0.36 apart.)
  let chosen = FIXTURE.loop_endings[0];
  async function approvedEpisode(label, edits) {
    const [b] = await q(
      `insert into briefs (channel_id, slot_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, shot_list, fact, titles, pinned_comment, status, created_by, approved_edits, approved_at, chosen_punchline, hero_objects)
       select channel_id, null, series, lead_character, desk, $2 || premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, shot_list, fact, titles, pinned_comment, 'approved', 'agent', $3, now(), $4, hero_objects from briefs where id = $1 returning id`,
      [briefId, `${label}: `, JSON.stringify(edits), chosen],
    );
    const [ep] = await q(`insert into episodes (brief_id, channel_id, status) values ($1, $2, 'queued') returning id`, [b.id, CH]);
    return { briefId: b.id, episodeId: ep.id };
  }
  const k = await approvedEpisode('key', { visual_format: 'engineered', motion: 'key' });
  const ps = await P.prepareScript(db, k.episodeId, { apiKey: null, usdInrRate: 88 });
  check(!ps.polished && /keeps its beat lines/.test(ps.reason ?? ''), 'the script is not polished — each line carries its own graphics', ps.reason);
  const [kScript] = await q('select s.vo_text, s.beats from episodes e join scripts s on s.id = e.script_id where e.id = $1', [k.episodeId]);
  check(kScript.beats.lines.length === FIXTURE.beats.length && kScript.beats.lines.at(-1).text === chosen, 'the script keeps one line per beat, ending on the chosen loop line', kScript.beats.lines.at(-1).text);
  await P.planShots(db, k.episodeId, { usdInrRate: 88, actedBeatAvailable: false });
  const kShots = await q('select s.idx, s.render_route, s.duration_s, s.graphics, s.realistic, s.vo_char_start, s.vo_char_end, s.beat_id, s.id from shots s join episodes e on e.script_id = s.script_id where e.id = $1 order by s.idx', [k.episodeId]);
  const [kEp] = await q('select estimate_inr, qc from episodes where id = $1', [k.episodeId]);
  check(kShots.length === FIXTURE.beats.length && kShots.every((s, i) => s.vo_char_start === kScript.beats.lines[i].voStart && s.vo_char_end === kScript.beats.lines[i].voEnd), 'shot i is bound to line i exactly', `${kShots.length} shots`);
  check(kShots.every((s, i) => canon(s.graphics) === (Object.keys(FIXTURE.beats[i].graphics).length ? canon(FIXTURE.beats[i].graphics) : 'null')), 'each shot row carries its beat’s graphics (null where the beat has none)');
  check(kShots.every((s) => s.realistic === true), 'every 3D picture counts as realistic for the synthetic-media disclosure');
  check(kEp.qc.plan.format.format === 'engineered' && kEp.qc.plan.motion.motion === 'key' && kEp.qc.plan.hero_objects.join() === 'Coupler,Wagon', 'the plan records the format, the motion and the hero objects', JSON.stringify(kEp.qc.plan.motion));
  // The price, computed HERE from the routes the planner wrote and the rate card rows (independent of estimate.ts).
  const billed = (d) => Math.min(10, Math.max(2, Math.ceil(d)));
  const handPrice = (shots, voChars, sheets) =>
    round2(
      shots.reduce((n, s) => n + (s.render_route === 'still' ? PIC_INR : s.render_route === 'picture_clip' ? PIC_INR + billed(Number(s.duration_s)) * CLIP_S_INR * 1.5 : 0), 0) + voChars * VOICE_C_INR + sheets * PIC_INR,
    );
  const kHand = handPrice(kShots, kScript.vo_text.length, 2);
  const kClips = kShots.filter((s) => s.render_route === 'picture_clip').length;
  check(Math.abs(Number(kEp.estimate_inr) - kHand) < 0.1 && Math.abs(mKey.inr - kHand) < 0.1 && mKey.inr === Number(kEp.estimate_inr) && kClips === mKey.clips,
    'LOAD-BEARING: Approvals’ key price, the planner’s estimate_inr and the harness’s own sum over the planner’s shots agree — and so do the clip counts',
    `Approvals ₹${mKey.inr} · planner ₹${kEp.estimate_inr} · hand ₹${kHand} · clips ${mKey.clips}/${kClips}`);
  const f = await approvedEpisode('full', { visual_format: 'engineered', motion: 'full' });
  await P.prepareScript(db, f.episodeId, { apiKey: null, usdInrRate: 88 });
  await P.planShots(db, f.episodeId, { usdInrRate: 88, actedBeatAvailable: false });
  const fShots = await q('select s.render_route, s.duration_s from shots s join episodes e on e.script_id = s.script_id where e.id = $1 order by s.idx', [f.episodeId]);
  const [fEp] = await q('select estimate_inr from episodes where id = $1', [f.episodeId]);
  const fHand = handPrice(fShots, kScript.vo_text.length, 2);
  check(Math.abs(Number(fEp.estimate_inr) - fHand) < 0.1 && Math.abs(mFull.inr - fHand) < 0.1 && mFull.inr === Number(fEp.estimate_inr) && fShots.filter((s) => s.render_route === 'picture_clip').length === mFull.clips, 'full: the same three-way agreement', `Approvals ₹${mFull.inr} · planner ₹${fEp.estimate_inr} · hand ₹${fHand}`);
  // With room in the cap, the motion levels are what they say.
  await q('update channel_policy set per_short_cap_inr = 1000 where channel_id = $1', [CH]);
  const roomy = await formatOptions(db, CH, briefForUi);
  const rKey = roomy.motions.find((m) => m.motion === 'key');
  const rFull = roomy.motions.find((m) => m.motion === 'full');
  check(rKey.clips === 4 && rKey.note === null, 'with room in the cap: key plans its four clips', JSON.stringify(rKey));
  check(rFull.clips >= 8 && rFull.clips > rKey.clips, 'and full plans most scene beats as clips (the 25% drawn-share floor of this channel decides the rest)', `${rFull.clips} of ${rFull.wanted}`);
  console.log(`  ·     PRICES (45 s episode, 14 beats, rate card ₹88/USD): cap ₹150 → key ₹${mKey.inr} (${mKey.clips} clips), full ₹${mFull.inr} (${mFull.clips}); cap ₹1000 → key ₹${rKey.inr} (${rKey.clips}), full ₹${rFull.inr} (${rFull.clips})`);
  await q('update channel_policy set per_short_cap_inr = 150 where channel_id = $1', [CH]);

  // ═══ §5 Hero-object sheets ═══
  console.log('\n5. Hero-object sheets, and every picture referencing them\n');
  const vs = vendor();
  const sheetDeps = { usdInrRate: 88, apiKey: async () => ({ ok: true, value: 'test-key' }), submit: vs.submit, wait: vs.wait, fetchBytes: vs.fetchBytes, putBytes };
  const putsBefore = puts.length;
  const sh = await P.objectSheetsStep(db, k.episodeId, sheetDeps);
  check(sh.made === 2 && sh.missing.length === 0 && vs.calls.length === 2, 'two sheets made, one per hero object', JSON.stringify(sh));
  check(vs.calls.every((c) => c.estimatesAtSubmit === 1), 'LOAD-BEARING (rule 5): each sheet’s estimate existed when the vendor was called', JSON.stringify(vs.calls.map((c) => c.estimatesAtSubmit)));
  check(vs.calls[0].prompt.includes(FIXTURE.hero_objects[0].look.replace(/\.$/, '')) && vs.calls[0].prompt.includes('knuckle coupler') && !/@Coupler/.test(vs.calls[0].prompt) && /Avoid: .*people/.test(vs.calls[0].prompt) && vs.calls[0].prompt.length <= 1000, 'the sheet prompt is the object’s name and look, the format look and the negatives — no tag', vs.calls[0].prompt.slice(0, 140));
  const sheetKeys = puts.slice(putsBefore);
  check(sheetKeys.length === 2 && sheetKeys.every((x) => new RegExp(`^objects/${k.episodeId}/(Coupler|Wagon)-0-[0-9a-f]{8}\\.png$`).test(x)), 'the bytes went to the bucket under objects/<episode>/', sheetKeys.join(' '));
  const ledger = await q(`select entry_kind, stage, channel_id, cost_inr from cost_ledger where idempotency_key like $1 order by entry_kind`, [`objsheet:${k.episodeId}:%`]);
  check(ledger.length === 4 && ledger.every((r) => r.stage === '05-object-sheet' && r.channel_id === CH) && ledger.filter((r) => r.entry_kind === 'estimate').every((r) => Math.abs(Number(r.cost_inr) - PIC_INR) < 1e-9), 'an estimate (₹4.40) and a measured reconcile per sheet, on the channel, stage 05-object-sheet');
  const locked = await OS.lockedObjects(db, k.episodeId);
  check(locked.length === 2 && locked.every((o) => sheetKeys.includes(o.storage_key)), 'both locked automatically, each to the key the harness saw stored', JSON.stringify(locked.map((o) => [o.tag, o.storage_key.slice(-14)])));
  const again = await P.objectSheetsStep(db, k.episodeId, { ...sheetDeps, submit: async () => { throw new Error('must not resubmit'); } });
  check(again.reused === 2 && again.made === 0, 'a replay pays nothing', JSON.stringify(again));
  const ill = await approvedEpisode('illustrated', { visual_format: 'illustrated' });
  const notEng = await P.objectSheetsStep(db, ill.episodeId, sheetDeps);
  check(typeof notEng.skipped === 'string' && vs.calls.length === 2, 'another format: skipped, no call', JSON.stringify(notEng));

  // Pictures. Untimed is fine for pictures (one per shot); the clip shots get theirs too.
  const vp = vendor();
  const stillDeps = { usdInrRate: 88, llmKey: 'test-llm-key', llmClient, apiKey: async () => ({ ok: true, value: 'test-key' }), submit: vp.submit, wait: vp.wait, fetchBytes: vp.fetchBytes, putBytes, resolveRef };
  const picsBefore = puts.length;
  const st = await P.generateStills(db, k.episodeId, stillDeps);
  check(st.made === FIXTURE.beats.length && st.fellBack.length === 0, 'a picture for every beat — the clip beats included (their first frame)', JSON.stringify({ made: st.made, fell: st.fellBack }));
  const sheetUri = Object.fromEntries(locked.map((o) => [o.tag, `${BUCKET}${o.storage_key}`]));
  const refsOk = vp.calls.every((c, i) => {
    const want = FIXTURE.beats[i].objects;
    const got = (c.references ?? []).map((r) => `${r.tag}=${r.uri}`).sort().join();
    return got === want.map((t) => `${t}=${sheetUri[t]}`).sort().join() && want.every((t) => c.prompt.includes(`@${t}`));
  });
  check(refsOk, 'LOAD-BEARING (the accepting branch): every picture carries exactly its beat’s object sheets — URIs from the keys the harness saw stored — and names each by its @Tag', JSON.stringify(vp.calls.slice(0, 2).map((c) => c.references)));
  const cut = vp.calls[9].prompt;
  const scene = vp.calls[0].prompt;
  check(cut.includes(E.ENGINEERED_LOOK.cutaway) && !cut.includes(E.ENGINEERED_LOOK.scene) && scene.includes(E.ENGINEERED_LOOK.scene) && vp.calls[12].prompt.includes(E.ENGINEERED_LOOK.diagram), 'the look follows the beat’s view: scene, cutaway (glass housing, orange part), diagram');
  check(vp.calls.every((c) => c.prompt.includes(E.ENGINEERED_LOOK.negative) && c.prompt.length <= 1000 && !/photorealism, 3D plastic/.test(c.prompt)), 'every picture carries the format’s negatives (no text) and never the cartoon channel negatives');
  const refs = (await q(`select g.request_payload->>'prompt_ref' r from generations g join shots s on s.id = g.shot_id where s.script_id = (select script_id from episodes where id = $1) and g.kind = 'image'`, [k.episodeId])).map((r) => r.r);
  check(refs.length === FIXTURE.beats.length && refs.every((r) => r === '21-still.v6'), 'drawn under 21-still.v6', [...new Set(refs)].join());
  const picKeys = puts.slice(picsBefore);

  // The refusal's other half: an object whose sheet never came back is named, untagged, unreferenced.
  chosen = FIXTURE.loop_endings[1];
  const m = await approvedEpisode('missing', { visual_format: 'engineered', motion: 'key' });
  await P.prepareScript(db, m.episodeId, { apiKey: null, usdInrRate: 88 });
  const [mScript] = await q('select s.beats from episodes e join scripts s on s.id = e.script_id where e.id = $1', [m.episodeId]);
  check(mScript.beats.lines.length === FIXTURE.beats.length && mScript.beats.lines.at(-1).text === FIXTURE.loop_endings[1], 'another chosen ending REPLACES the last line — appended, it would shift every graphic off its words', mScript.beats.lines.at(-1).text);
  await P.planShots(db, m.episodeId, { usdInrRate: 88, actedBeatAvailable: false });
  const vf = vendor((p) => /freight wagon/.test(p) && !/@/.test(p));
  const mSheets = await P.objectSheetsStep(db, m.episodeId, { ...sheetDeps, submit: vf.submit, wait: vf.wait });
  const [mEp] = await q('select qc from episodes where id = $1', [m.episodeId]);
  check(mSheets.made === 1 && mSheets.missing.length === 1 && mSheets.missing[0].tag === 'Wagon' && mEp.qc.plan.objects_missing[0].tag === 'Wagon', 'a sheet that fails is recorded as missing, by tag, with the reason', JSON.stringify(mSheets.missing));
  const vm = vendor();
  await P.generateStills(db, m.episodeId, { ...stillDeps, submit: vm.submit, wait: vm.wait });
  const wagonOnly = vm.calls[1];
  check(!(wagonOnly.references ?? []).length && !/@Wagon/.test(wagonOnly.prompt) && /freight wagon/.test(wagonOnly.prompt), 'its pictures pass no reference and say "freight wagon" instead of a dangling @Wagon', wagonOnly.prompt.slice(0, 120));
  check(vm.calls[7].references?.length === 1 && vm.calls[7].references[0].tag === 'Coupler' && !/@Wagon/.test(vm.calls[7].prompt), 'a picture with both objects keeps the one that has a sheet', JSON.stringify(vm.calls[7].references));

  // ═══ §6 Picture clips ═══
  console.log('\n6. Picture clips animate their own picture\n');
  const kScriptId = (await q('select script_id from episodes where id = $1', [k.episodeId]))[0].script_id;
  await q(`update shots set duration_source = 'derived_from_vo' where script_id = $1`, [kScriptId]);
  const enq = await P.enqueueGeneration(db, k.episodeId, { usdInrRate: 88 });
  const jobs = await q(`select j.shot_id, j.render_route, j.provider, j.model, j.params, j.estimate_inr, j.duration_s, j.idempotency_key, s.idx from gen_jobs j join shots s on s.id = j.shot_id where j.episode_id = $1 order by s.idx`, [k.episodeId]);
  check(enq.queued === kClips && enq.refused.length === 0 && jobs.length === kClips && jobs.every((j) => j.render_route === 'picture_clip' && j.provider === 'runway' && j.model === 'gen4_turbo'), 'one job per picture clip, on the picture-clip recipe', JSON.stringify(enq));
  const keyOf = async (shotId) => (await q(`select a.storage_key from generations g join assets a on a.generation_id = g.id where g.shot_id = $1 and g.kind = 'image' and g.status = 'succeeded'`, [shotId]))[0]?.storage_key;
  let animatesOwn = jobs.length > 0;
  for (const j of jobs) {
    const k2 = await keyOf(j.shot_id);
    if (!(picKeys.includes(k2) && j.params.reference_frame === `storage:${k2}` && j.params.image_url === undefined)) animatesOwn = false;
  }
  check(animatesOwn, 'LOAD-BEARING: each clip’s first frame is THAT shot’s stored picture (a key the harness saw put), stored as a key — never a URL', JSON.stringify(jobs.map((j) => j.params.reference_frame?.slice(-20))));
  check(jobs.every((j) => Math.abs(Number(j.estimate_inr) - round2(billed(Number(j.duration_s)) * CLIP_S_INR)) < 1e-9 && j.params.duration_s === billed(Number(j.duration_s))), 'each estimate is ONE clip call at the billed length (the picture is already paid)', JSON.stringify(jobs.map((j) => [j.params.duration_s, j.estimate_inr])));
  check(jobs.every((j) => !/@[A-Z]/.test(j.params.prompt) && j.params.negative_prompt === undefined && /Animate this exact 3D render/.test(j.params.prompt)), 'clip prompts name objects by name (a video model knows no tags) and carry no channel style or negative', jobs[0]?.params.prompt.slice(0, 120));
  // The refusal: a clip shot whose picture is gone.
  const m2Script = (await q('select script_id from episodes where id = $1', [m.episodeId]))[0].script_id;
  await q(`update shots set duration_source = 'derived_from_vo' where script_id = $1`, [m2Script]);
  const [lostShot] = await q(`select id, idx from shots where script_id = $1 and render_route = 'picture_clip' order by idx limit 1`, [m2Script]);
  await q(`update generations set status = 'failed' where shot_id = $1 and kind = 'image'`, [lostShot.id]);
  const enq2 = await P.enqueueGeneration(db, m.episodeId, { usdInrRate: 88 });
  const lostJobs = await q('select count(*)::int n from gen_jobs where shot_id = $1', [lostShot.id]);
  check(enq2.refused.some((r) => r === `shot ${lostShot.idx}: no picture to animate`) && lostJobs[0].n === 0, 'refused: a clip shot with no picture — no job, nothing ledgered', JSON.stringify(enq2.refused));

  // ═══ §7 Graphics → Remotion props ═══
  console.log('\n7. Graphics and keyword captions reach the composition\n');
  // The voice's timings, seeded: one take per line, words evenly over 2.4 s each.
  let at = 0;
  const durs = [];
  for (const [i, l] of kScript.beats.lines.entries()) {
    const ws = l.text.split(/\s+/);
    const dur = 2.4;
    const step = dur / ws.length;
    const [take] = await q(`insert into assets (kind, storage_key) values ('audio', $1) returning id`, [`vo/k/line-${l.idx}.m4a`]);
    await q(`insert into vo_takes (script_id, chunk_idx, language, driver, model, voice_id, text_in, word_timings, offset_s, duration_s, asset_id) values ($1, $2, 'en', 'runway', 'eleven_v3', 'James', $3, $4, $5, $6, $7)`, [kScriptId, l.idx, l.text, JSON.stringify(ws.map((w, j) => ({ w, start: round2(j * step), end: round2((j + 1) * step - 0.02) }))), at, dur, take.id]);
    await q(`update shots set duration_s = $2, duration_source = 'derived_from_vo' where script_id = $1 and idx = $3`, [kScriptId, dur, i]);
    durs.push(dur);
    at += dur;
  }
  const [voA] = await q(`insert into assets (kind, storage_key) values ('audio', 'vo/k/track.m4a') returning id`);
  await q(`update episodes set voice_detail = $2 where id = $1`, [k.episodeId, JSON.stringify({ vo_asset_id: voA.id })]);
  // A clip that came back for the first clip shot; none for the others (they fall back to their picture).
  const firstClip = jobs[0];
  const [g1] = await q(`insert into generations (shot_id, kind, driver, model, attempt, status, idempotency_key, origin, completed_at, request_payload) values ($1, 'video', 'runway', 'gen4_turbo', 0, 'succeeded', 'test-clip-1', 'pipeline', now(), '{}') returning id`, [firstClip.shot_id]);
  await q(`insert into assets (kind, storage_key, generation_id, normalized_at) values ('video', 'clips/one.mp4', $1, now())`, [g1.id]);
  let captured = null;
  const asm = await P.assembleEpisode(db, k.episodeId, {
    usdInrRate: 88,
    presign: async (key) => `${BUCKET}${key}`,
    putBytes,
    download: async (_u, out) => writeFile(out, Buffer.alloc(16)),
    normaliseAudio: async (i, o) => copyFile(i, o),
    render: async (i) => {
      captured ??= i;
      await writeFile(i.outputPath, Buffer.alloc(32));
      return { ok: true, frames: i.durationInFrames, serveUrl: 'stub' };
    },
  }, { layers: ['composite'] });
  check(asm.ok && captured, 'the composite is assembled', asm.ok ? `${asm.frames} frames` : `${asm.code}: ${asm.detail}`);
  const props = captured.props;
  const frames = P.shotFrames(durs);
  const starts = frames.map((_, i) => frames.slice(0, i).reduce((n, x) => n + x, 0));
  const withG = FIXTURE.beats.map((b, i) => ({ i, g: b.graphics })).filter((x) => Object.keys(x.g).length);
  check(props.captionStyle === 'engineered' && props.graphics.length === withG.length && props.graphics.every((x, j) => x.from === starts[withG[j].i] && x.frames === frames[withG[j].i] && canon(x.g) === canon(withG[j].g)), 'every beat’s graphics sit on exactly that beat’s frames, as the brief wrote them', `${props.graphics.length} graphic windows`);
  const badges = props.graphics.filter((x) => x.g.badge).map((x) => x.g.badge.n).join();
  const verdicts = props.graphics.filter((x) => x.g.verdict).map((x) => (x.g.verdict.pass ? '✓' : '✗')).join('');
  check(badges === '1,2,3' && verdicts === '✗✗✓', 'badges ①②③ and verdicts ✗ ✗ ✓ in order', `${badges} · ${verdicts}`);
  check(props.cues.length > 0 && props.cues.every((c) => c.words.length >= 1 && c.words.length <= 4) && props.cues.filter((c) => c.words.length === 1).length <= 2, 'captions are 2–4 words at a time (a lone word only where a pause forces it)', `${props.cues.length} cues; sizes ${[...new Set(props.cues.map((c) => c.words.length))].join(',')}`);
  const colored = props.cues.filter((c) => c.keyword);
  const wantKw = FIXTURE.beats.map((b, i) => ({ i, kw: b.graphics.keyword })).filter((x) => x.kw);
  const kwOk = wantKw.every(({ i, kw }) => {
    const hits = colored.filter((c) => c.startS >= starts[i] / 30 - 1e-6 && c.startS < (starts[i] + frames[i]) / 30);
    return hits.length === 1 && hits[0].keyword.role === kw.role && hits[0].words[hits[0].keyword.index].w.toLowerCase().replace(/[^a-z']/g, '').startsWith(kw.word.toLowerCase());
  });
  check(kwOk && colored.length === wantKw.length, 'each beat’s keyword is coloured exactly once, in its own beat, with its role', JSON.stringify(colored.map((c) => [c.text, c.startS, c.keyword])) + ' want ' + JSON.stringify(wantKw.map((x) => [x.i, starts[x.i] / 30, x.kw.word])));
  const clipShots = props.shots.filter((s) => s.type === 'clip');
  check(clipShots.length === 1 && clipShots[0].url === `${BUCKET}clips/one.mp4`, 'the clip that came back is drawn as the clip');
  const [kQc] = await q('select qc from episodes where id = $1', [k.episodeId]);
  const fellToStill = kQc.qc.plan.swaps.filter((x) => x.from === 'picture_clip' && x.to === 'still' && /did not come back/.test(x.reason));
  check(fellToStill.length === kClips - 1 && props.shots.filter((s) => s.type === 'still').length === FIXTURE.beats.length - 1 && !props.shots.some((s) => s.type === 'overlay'), 'clips that never came back are drawn as THEIR pictures, recorded for Cuts — never the overlay', `${fellToStill.length} recorded`);
  check(JSON.stringify(chunkWords([{ w: 'A', start: 0, end: 0.2 }, { w: 'B,', start: 0.2, end: 0.4 }, { w: 'C', start: 0.4, end: 0.6 }, { w: 'D', start: 0.6, end: 0.8 }, { w: 'E', start: 0.8, end: 1 }]).map((c) => c.map((w) => w.w).join(' '))) === '["A B,","C D E"]', 'chunks break after a clause once they have two words, and fold a lone tail in');

  // ═══ §11 A real render of two beats ═══
  console.log('\n11. A real Remotion render: the badge beat and the verdict beat\n');
  const shell = process.env.REMOTION_BROWSER_EXECUTABLE || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
  const work = await mkdtemp(join(tmpdir(), 'kiln-eng-'));
  try {
    // A plain light-grey picture stands in for the 3D still (the model's pixels are not the subject here).
    const png = join(work, 'grey.png');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xD8DCE2:s=360x640', '-frames:v', '1', png]);
    const dataUri = `data:image/png;base64,${(await readFile(png)).toString('base64')}`;
    const W = 540, H = 960, S = W / 1080;
    const i3 = 3, i4 = 4;
    const f3 = frames[i3], f4 = frames[i4];
    const slice = {
      layer: 'composite',
      shots: [f3, f4].map((fr) => ({ type: 'still', url: dataUri, camera: 'static', accent: '#FFD23F', seed: 1, frames: fr })),
      audioUrl: null,
      musicUrl: null,
      cues: props.cues.filter((c) => c.startS >= starts[i3] / 30 && c.startS < (starts[i4] + f4) / 30).map((c) => ({ ...c, startS: c.startS - starts[i3] / 30, endS: c.endS - starts[i3] / 30 })),
      hook: null,
      safeBox: { x: props.safeBox.x * S, y: props.safeBox.y * S, width: props.safeBox.width * S, height: props.safeBox.height * S },
      textScale: props.textScale,
      captionStyle: 'engineered',
      graphics: props.graphics.filter((x) => x.from === starts[i3] || x.from === starts[i4]).map((x) => ({ ...x, from: x.from - starts[i3] })),
    };
    const out = join(work, 'slice.mp4');
    const r = await renderBureau({ props: slice, width: W, height: H, fps: 30, durationInFrames: f3 + f4, outputPath: out, browserExecutable: shell });
    check(r.ok, 'two beats render through the real bundle and headless Chromium', r.ok ? `${r.frames} frames` : `${r.code}: ${r.detail}`);
    if (r.ok) {
      // The verdict beat, 1 s in: read the pixels where the pill's left end sits, inside the safe box.
      const raw = join(work, 'f.rgb');
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', ((f3 + 30) / 30).toFixed(3), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
      const px = await readFile(raw);
      const at = (x, y) => { const o = (Math.round(y) * W + Math.round(x)) * 3; return [px[o], px[o + 1], px[o + 2]]; };
      const pill = at(slice.safeBox.x + 14, slice.safeBox.y + 22);
      const bg = at(W / 2, H * 0.45);
      check(pill[0] > 200 && pill[1] < 140 && pill[2] < 120, 'the ✗ verdict pill is drawn red-orange at the top-left of the safe box (pixels read from the frame)', `pill rgb ${pill.join(',')}`);
      check(Math.abs(bg[0] - 0xd8) < 20 && Math.abs(bg[2] - 0xe2) < 20, 'and the picture shows where nothing is drawn over it', `bg rgb ${bg.join(',')}`);
      const rail = at(W - 4, slice.safeBox.y + 22);
      check(Math.abs(rail[0] - 0xd8) < 25, 'nothing is drawn in the right rail, outside the safe box', `rail rgb ${rail.join(',')}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  // ═══ §8 Bureau untouched ═══
  console.log('\n8. The Bureau: the new type offered, nothing else changed\n');
  const BSHOTS = [
    { beat_id: 'cold_open', route: 'overlay', description: 'Empty sky where the Moon was', duration_s: 4, characters: [] },
    { beat_id: 'stakes', route: 'character_beat', description: 'Marlo files the Moon as missing', duration_s: 4, characters: ['pip'] },
  ];
  const BSCRIPT = 'Pip: Where did the Moon go?!\nMarlo: Filed under missing.';
  const bo = await formatOptions(db, BUREAU, { series: 'incident', shot_list: BSHOTS, script_text: BSCRIPT, lead_character: 'pip' });
  const bil = bo.options.find((o) => o.format === 'illustrated');
  const bvo = parseScript(BSCRIPT, cbB);
  const bExpect = await estimateEpisode(db, { shots: F.routesForFormat(BSHOTS, 'illustrated', true).shots, voChars: bvo.voText.length, usdInrRate: 88, channelId: BUREAU });
  check(bo.seriesDefault === 'illustrated' && bil.inr === bExpect.total_inr, 'the Bureau’s default and its illustrated price are what they were (the old routing, the old estimator)', `₹${bil.inr}`);
  const be = bo.options.find((o) => o.format === 'engineered');
  check(be && be.disabled === null && /no hero objects/.test(be.note ?? '') && bo.motions.length === 2, 'the 3D explainer is offered to the Bureau too — a template, not a channel feature — and says it has no hero objects', be?.note);
  check(bo.options.map((o) => o.format).join() === 'illustrated,diagram,cinematic,characters,engineered', 'the five video types, in order', bo.options.map((o) => o.format).join());

  // ═══ §10 Before 0052 ═══
  console.log('\n10. Before the bundle is pasted\n');
  await q('alter table shots drop column graphics');
  const pre = await E.engineeredAvailability(db);
  check(!pre.available && /paste bundle 10/.test(pre.reason), 'the probe says unavailable, naming the bundle', pre.reason);
  const preOpts = await formatOptions(db, CH, briefForUi);
  check(preOpts.options.find((o) => o.format === 'engineered').disabled === pre.reason, 'Approvals disables the type with that reason');
  const p0 = await approvedEpisode('pre', { visual_format: 'engineered', motion: 'key' });
  await P.prepareScript(db, p0.episodeId, { apiKey: null, usdInrRate: 88 });
  await P.planShots(db, p0.episodeId, { usdInrRate: 88, actedBeatAvailable: false });
  const [p0Ep] = await q('select qc from episodes where id = $1', [p0.episodeId]);
  const p0Routes = (await q('select render_route from shots s join episodes e on e.script_id = s.script_id where e.id = $1', [p0.episodeId])).map((r) => r.render_route);
  check(p0Ep.qc.plan.format.format === 'illustrated' && p0Ep.qc.plan.format.requested === 'engineered' && p0Routes.every((r) => r === 'still'), 'the planner plans it as illustrated, records that the 3D explainer was asked for and why, and no shot is a picture clip', JSON.stringify(p0Ep.qc.plan.format));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await scratch.release();
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll engineered checks passed.\n');
process.exit(failures ? 1 : 0);
