#!/usr/bin/env node
/**
 * verify:channel-bible — the channel bible in the database (decision 0022).
 *
 *   §1 Import: the Bureau's folder imported by `importFolderBible` reads back through `getBible`
 *      from the DATABASE and equals the folder field by field; a second import changes nothing;
 *      a Voices-screen override is folded into the cast and its row removed.
 *   §2 The paste path: the SQL `bible-import.mjs --sql` generates for the hosted project, run on
 *      a fresh scratch database, gives the same field-by-field result, twice (idempotent).
 *   §3 A second channel made ENTIRELY through the approver actions — createChannel,
 *      upsertCharacter ×2, lockVoice ×2, updateSeries, updatePolicy, updateTrendSources — with
 *      zero files under channels/ for it; every refusal by name; every write in authorship_log.
 *   §4 That channel's stub brief is drafted and approved, and its script parsing (speaker map)
 *      and voice routing run against the DATABASE bible: the synthesiser is handed the presets
 *      lockVoice wrote, not anything from a folder.
 *
 * Seeds inputs; asserts what getBible, the actions and the stages returned or wrote.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-channel-bible.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { bibleForSlug, getBible } = require(`${B}/bureau/bible.js`);
const A = require(`${B}/channels/bible-admin.js`);
const { BUREAU_CHANNEL_ID } = require(`${B}/fixtures/seed-channel.js`);
const { mintBureauToken } = require(`${B}/bureau/tokens.js`);
const { createBriefs } = require(`${B}/bureau/briefs.js`);
const { approveBrief } = require(`${B}/bureau/control.js`);
const P = require(`${B}/bureau/episode-steps.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');
const { stubEmbedder } = await import('./lib/stub-embedder.mjs');

let failures = 0;
const check = (c, l, d = '') => {
  if (c) console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
  else {
    console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
    failures++;
  }
};
const APPROVER = { scope: 'approver', profileId: null, via: 'harness' };
const work = await mkdtemp(join(tmpdir(), 'kiln-bible-'));
const file = bibleForSlug('bureau-of-reality');

const s1 = await scratchDatabase(dbUrl, 'bible');
const s2 = await scratchDatabase(dbUrl, 'biblesql');
try {
  const db = supabaseShim(s1.client);
  const q = async (sql, p = []) => (await s1.client.query(sql, p)).rows;

  // ── §1 Import ─────────────────────────────────────────────────────────────
  console.log('\n1. The Bureau folder imported into the tables\n');
  const before = await getBible(db, BUREAU_CHANNEL_ID);
  check(before.source === 'file', 'before the import, getBible falls back to the folder', before.source);
  // A Voices-screen override (0046) that the import must fold into the cast.
  await q(`insert into channel_voice_overrides (channel_id, character_slug, voice_provider, voice_id) values ($1, 'marlo', 'runway', 'Bernard')`, [BUREAU_CHANNEL_ID]);
  const imp = await A.importFolderBible(db, { channelId: BUREAU_CHANNEL_ID, slug: 'bureau-of-reality', by: 'import:harness' });
  const fromDb = await getBible(db, BUREAU_CHANNEL_ID);
  check(fromDb.source === 'db' && imp.bible === 'inserted' && imp.characters === file.bible.characters.length, 'getBible now reads the database', JSON.stringify(imp));
  const diff = A.bibleDiff(file, fromDb);
  check(diff.length === 1 && /^bible\.characters\[\d\]\.voice\.preset_id: .* ≠ "Bernard"$/.test(diff[0]),
    'field by field, the database bible equals the folder — except the one voice the override folded in', diff.join(' | '));
  check(fromDb.characterBySlug('marlo')?.voice.preset_id === 'Bernard' && Number((await q('select count(*) n from channel_voice_overrides'))[0].n) === 0 && imp.foldedOverrides.join() === 'marlo',
    'the override is now the cast’s own voice, and its row is gone (one place for a voice)');
  // Undo the fold on the comparison side: with the override applied, everything else is identical.
  const folded = { ...file, bible: { ...file.bible, characters: file.bible.characters.map((c) => (c.id === 'marlo' ? { ...c, voice: { ...c.voice, preset_id: 'Bernard' } } : c)) } };
  check(A.bibleDiff(folded, fromDb).length === 0, 'LOAD-BEARING: the folder (with that voice) and the database bible agree on every field — world, publishing, cast, policy, every series, trend sources');
  check(fromDb.seriesFor('incident').beat_sheet.length === file.seriesFor('incident').beat_sheet.length && fromDb.leadsFromCalendar('pip+marlo').join() === 'pip,marlo', 'the lookups callers use answer the same');
  const imp2 = await A.importFolderBible(db, { channelId: BUREAU_CHANNEL_ID, slug: 'bureau-of-reality', by: 'import:harness' });
  const [{ version: v2 }] = await q('select version from channel_bibles where channel_id = $1', [BUREAU_CHANNEL_ID]);
  check(imp2.bible === 'kept' && imp2.characters === 0 && v2 === 1 && A.bibleDiff(folded, await getBible(db, BUREAU_CHANNEL_ID)).length === 0, 'a second import changes nothing', JSON.stringify(imp2));

  // ── §2 The paste path ───────────────────────────────────────────────────────
  console.log('\n2. The SQL generated for the hosted project\n');
  const sqlFile = join(work, 'import.sql');
  await run('node', [new URL('./bible-import.mjs', import.meta.url).pathname, '--sql', sqlFile]);
  const sql = await readFile(sqlFile, 'utf8');
  await s2.client.query(`insert into channel_voice_overrides (channel_id, character_slug, voice_provider, voice_id) values ($1, 'marlo', 'runway', 'Bernard'), ($1, 'pip', 'runway', 'NotAPreset')`, [BUREAU_CHANNEL_ID]);
  await s2.client.query(sql);
  const db2 = supabaseShim(s2.client);
  const viaSql = await getBible(db2, BUREAU_CHANNEL_ID);
  check(viaSql.source === 'db' && A.bibleDiff(folded, viaSql).length === 0, 'the pasted SQL gives the same bible, field by field (with the folded voice)', A.bibleDiff(folded, viaSql).slice(0, 3).join(' | '));
  const left = (await s2.client.query('select character_slug, voice_id from channel_voice_overrides')).rows;
  check(left.length === 1 && left[0].voice_id === 'NotAPreset', 'an override the router would refuse is NOT folded — it stays where the Voices screen shows its problem', JSON.stringify(left));
  await s2.client.query(sql);
  check(Number((await s2.client.query('select count(*) n from channel_characters')).rows[0].n) === file.bible.characters.length, 'pasting it twice changes nothing (on conflict do nothing)');
  let guard = null;
  try {
    await s2.client.query(sql.replaceAll("'bureau-of-reality'", "'no-such-slug'"));
  } catch (err) {
    guard = err.message;
  }
  check(/No channel with slug .*Nothing in this file has been applied/.test(guard ?? ''), 'a slug with no channel raises, so the paste rolls back rather than importing nothing silently', guard);

  // ── §3 A second channel, entirely through the actions ───────────────────────
  console.log('\n3. A second channel made in the app\n');
  const created = await A.createChannel(db, APPROVER, { name: 'Night Shift', slug: 'night-shift', handle: 'nightshift', niche: 'Two night-shift engineers keep the city’s machines running.', accent_hex: '#A3E635', targets: ['youtube'] });
  check(created.ok && created.cast === 1, 'createChannel: row, policy, target and a template bible in the database', JSON.stringify(created));
  const C = created.channelId;
  check(!existsSync(new URL('../channels/night-shift', import.meta.url)), 'there is no channels/night-shift/ folder — nothing on disk');
  const tmplCb = await getBible(db, C);
  check(tmplCb.source === 'db' && tmplCb.bible.characters[0].accent_hex === '#A3E635' && tmplCb.bible.world.premise.startsWith('Two night-shift'), 'it starts from the template, with its accent and niche', tmplCb.bible.characters[0].accent_hex);

  const person = (id, name, accent) => ({
    id, name, role: 'Night engineer', desk: 'gravity', on_screen: true, season_introduced: 1,
    personality: `${name} keeps the machines honest.`, speech_rules: ['Short, dry sentences.'],
    catchphrase: { text: 'Logged.', max_per_week: 1 }, accent_hex: accent,
    visual_lock: { line: 'white chalk line', props: ['torch'], head_body_ratio: '1:3', line_weight: 'medium', silhouette: 'upright' },
    voice_brief: 'Calm adult voice.', never_do: ['Never a child.'],
  });
  const badChar = await A.upsertCharacter(db, APPROVER, C, { ...person('Nora!', 'Nora', '#F472B6') });
  check(!badChar.ok && /id/.test(badChar.refused), 'a malformed character is refused by field, before any write', badChar.refused);
  const asAgent = await A.upsertCharacter(db, { ...APPROVER, scope: 'agent' }, C, person('nora', 'Nora', '#F472B6'));
  check(!asAgent.ok && /Only the approver/.test(asAgent.refused), 'an agent cannot edit the cast');
  const u1 = await A.upsertCharacter(db, APPROVER, C, person('nora', 'Nora', '#F472B6'));
  const u2 = await A.upsertCharacter(db, APPROVER, C, person('otto', 'Otto', '#60A5FA'));
  check(u1.ok && u1.created && u2.ok && u2.created, 'two characters added', `${u1.ok ? u1.message : u1.refused} / ${u2.ok ? u2.message : u2.refused}`);
  const badPreset = await A.lockVoice(db, APPROVER, C, { characterSlug: 'nora', presetId: 'Gandalf' });
  check(!badPreset.ok && /not a preset/.test(badPreset.refused), 'a preset the vendor does not offer is refused (TTS_PRESET_IDS)', badPreset.refused);
  const l1 = await A.lockVoice(db, APPROVER, C, { characterSlug: 'nora', presetId: 'Maya' });
  const l2 = await A.lockVoice(db, APPROVER, C, { characterSlug: 'otto', presetId: 'Bernard' });
  check(l1.ok && l2.ok, 'both voices locked', `${l1.ok ? l1.message : l1.refused}`);
  const tmplSeries = tmplCb.seriesFor('incident');
  const s = await A.updateSeries(db, APPROVER, C, { ...tmplSeries, name: 'Night Incident', desks: ['gravity', 'orbit'] });
  const badSeries = await A.updateSeries(db, APPROVER, C, { ...tmplSeries, id: 'not_a_series' });
  check(s.ok && !badSeries.ok, 'a series is saved; an id outside the series enum is refused', badSeries.ok ? '' : badSeries.refused.slice(0, 80));
  const pol = await A.updatePolicy(db, APPROVER, C, { caps: { per_short_cap_inr: 120, stills_enabled: true } });
  const badCaps = await A.updatePolicy(db, APPROVER, C, { caps: { per_short_cap_inr: -1 } });
  const [caps] = await q('select per_short_cap_inr, stills_enabled from channel_policy where channel_id = $1', [C]);
  check(pol.ok && !badCaps.ok && Number(caps.per_short_cap_inr) === 120 && caps.stills_enabled === true, 'caps saved to channel_policy; a negative cap refused', JSON.stringify(caps));
  const tr = await A.updateTrendSources(db, APPROVER, C, { subreddits: ['engineering'], youtube: null });
  check(tr.ok && (await getBible(db, C)).trends.subreddits.join() === 'engineering', 'trend sources saved and read back');
  const cb = await getBible(db, C);
  const [{ version }] = await q('select version from channel_bibles where channel_id = $1', [C]);
  const logged = (await q('select action from authorship_log where channel_id = $1 order by occurred_at', [C])).map((r) => r.action);
  check(cb.characterSlugs.join() === 'host,nora,otto' && cb.characterBySlug('otto').voice.preset_id === 'Bernard' && version >= 7,
    'the bible reads back with three characters and the locked voices; version bumped per write', `${cb.characterSlugs.join()} v${version}`);
  check(['channel_create', 'character_create', 'character_create', 'voice_lock', 'voice_lock', 'series_update', 'caps_update', 'trend_sources_update'].every((a) => logged.includes(a)),
    'every write is in authorship_log', logged.join(','));
  const mirror = (await q('select slug, voice_id from characters where channel_id = $1 order by slug', [C])).map((r) => `${r.slug}=${r.voice_id}`);
  check(mirror.join() === 'host=null,nora=runway:Maya,otto=runway:Bernard', 'the runtime mirror (characters) carries the routed voices — no deploy', mirror.join());

  // ── §4 A brief for it, approved, scripted and voiced from the database bible ─
  console.log('\n4. Its brief, script and voice routing — from the database\n');
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 's@invalid.test', 88) returning id`);
  const agent = await mintBureauToken(db, { name: 'Routine', scope: 'agent', channelId: C, profileId: null });
  const approver = await mintBureauToken(db, { name: 'Sahil', scope: 'approver', channelId: C, profileId: prof.id });
  const SCRIPT = 'Nora: The night bus stopped because the Moon took the tides.\nOtto: Tides do not drive buses.\nNora: Then why is it floating?\nOtto: Logged.';
  const brief = {
    series: 'incident', lead_character: 'nora', supporting_characters: ['otto'], desk: 'gravity',
    premise: 'Nora blames the Moon for a late night bus and Otto files the paperwork.', premise_type: tmplSeries.premise_types[0],
    structure_variant: tmplSeries.structure_variants[0].id, ending_type: tmplSeries.ending_types[0], music_bed: tmplSeries.music_bed_pool[0], hook_archetype: 'story_open',
    punchlines: ['The bus is now tidal.', 'Logged.', 'The Moon has a bus pass.'], beat_sheet: [{ beat_id: 'cold_open', summary: 'A bus at a stop.' }], script_text: SCRIPT,
    shot_list: [{ beat_id: 'cold_open', route: 'overlay', description: 'A bus stop at night', duration_s: 4 }],
    fact: { claim: "The Moon's gravity is the main cause of Earth's ocean tides.", source_url: 'https://oceanservice.noaa.gov/facts/moon-tides.html' },
    titles: [{ text: 'The tidal bus', hook_archetype: 'story_open' }, { text: 'Why is the bus floating?', hook_archetype: 'question' }, { text: 'Two tides a day', hook_archetype: 'number_claim' }],
    pinned_comment: 'Which machine next?',
  };
  const out = await createBriefs([brief, { ...brief, lead_character: 'pip' }], { db, token: { id: agent.id, name: 'Routine', scope: 'agent', channelId: C, profileId: null }, embed: stubEmbedder });
  check(out[0].ok && !out[1].ok && /lead_character/.test(out[1].error), 'the brief validates against the DATABASE cast: nora is accepted, the Bureau’s pip is refused', JSON.stringify(out.map((o) => (o.ok ? 'ok' : o.error.slice(0, 60)))));
  const started = [];
  const appr = await approveBrief(db, { id: approver.id, name: 'Sahil', scope: 'approver', channelId: C, profileId: prof.id }, { startEpisode: async (id) => { started.push(id); return 'run_x'; }, completeWaitToken: async () => {}, notify: async () => {} }, { brief_id: out[0].brief_id, punchline: 'B' });
  const ep = appr.episode_id;
  check(!!ep && started[0] === ep, 'approved; the episode run is started');
  const sc = await P.prepareScript(db, ep, { apiKey: null, usdInrRate: 88 });
  const [srow] = await q('select beats from scripts where id = $1', [sc.scriptId]);
  check(srow.beats.lines.map((l) => l.speaker).join() === 'nora,otto,nora,otto', 'the script’s speaker map comes from the database cast', srow.beats.lines.map((l) => l.speaker).join());
  await P.planShots(db, ep, { usdInrRate: 88, actedBeatAvailable: false });
  const spoken = [];
  const v = await P.voiceStep(db, ep, {
    usdInrRate: 88,
    apiKeyFor: async () => ({ ok: true, value: 'k' }),
    synth: async ({ route, text, outPath }) => {
      spoken.push(`${route.voiceId}`);
      await run('espeak-ng', ['-v', 'en-gb+m3', '-s', '150', '-w', outPath, text]);
      return { ok: true, path: outPath, requestId: 'tts', words: null, estimatedCredits: 1 };
    },
    align: async () => ({ ok: false, code: 'skipped', detail: 'not under test here' }),
    putBytes: async (_k, body) => { let n = 0; for await (const c of body) n += c.length; return n; },
    presign: async () => 'http://127.0.0.1:1/never',
  });
  check(v.ok && spoken.join() === 'Maya,Bernard,Maya,Bernard', 'LOAD-BEARING: the voice stage speaks each line in the preset lockVoice wrote — read from the database, no folder, no deploy', v.ok ? spoken.join() : `${v.code}: ${v.detail}`);
} catch (err) {
  check(false, 'harness threw', err.stack);
} finally {
  await s1.release();
  await s2.release();
  await rm(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED\n` : '\nThe channel bible lives in the database.\n');
process.exit(failures ? 1 : 0);
