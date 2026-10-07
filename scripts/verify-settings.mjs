#!/usr/bin/env node
/**
 * verify:settings — Settings → Generation, Assembly, Publishing and Danger zone (0049),
 * against a real Postgres. Drives the lib functions the screens call, never the pages.
 *
 * Seed the inputs, assert the outputs: every section changes a setting through the approver
 * action and then asserts what the CODE PATH that used to read the constant now produces —
 * the estimate's picture count, the voice track's offsets, the render props and the loudness
 * target handed to ffmpeg, the bundle's disclosures, the publish time a slot gets.
 *
 *   §0  LOAD-BEARING. Every foreign key into `assets`, enumerated from pg_constraint, is in
 *       ASSET_FOREIGN_KEYS — the orphan finder's list. The two sides arrive independently
 *       (the catalogue vs a hand-written list); a new FK that the list misses would let the
 *       finder call a referenced file an orphan and the worker delete it.
 *   §1  The 0049 column defaults equal TUNING_DEFAULTS (migration literals vs TS constants).
 *   §2  updateTuning: agent refused; out of range refused by Zod AND by the CHECK; a change
 *       is one authorship row with before/after.
 *   §3  Pictures: estimateEpisode prices a still shot at the channel's pictures-per-shot.
 *   §4  Voice: voiceStep lays lines out with the channel's gap and tail.
 *   §5  Assembly: assembleEpisode cuts the channel's number of pictures, sizes captions and
 *       the hook, holds the hook, and normalises to the channel's LUFS.
 *   §6  Publishing: bundleEpisode carries madeForKids and the synthetic flag from Settings;
 *       updateSlot moves v_slot_status.publish_at and refuses a zone Postgres would not know.
 *   §7  Per-series defaults and the picture style, through the bible path, read back.
 *   §8  Unstick: refuses a live run, a wrong slug, a non-approver; halts a quiet one so
 *       restartHaltedEpisode accepts it.
 *   §9  Orphans: findOrphans returns exactly the seeded orphans; the purge request needs the
 *       slug and the count; purgeOrphans keeps one that gained a reference since.
 *   §10 Before 0049: readTuning falls back to the constants and says why; writes refuse.
 *
 * Usage: node scripts/verify-settings.mjs <db-url>
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify, isDeepStrictEqual as same } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-settings.mjs <db-url>');
  process.exit(2);
}

const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const T = require(`${B}/settings/tuning.js`);
const S = require(`${B}/settings/admin.js`);
const O = require(`${B}/settings/orphans.js`);
const P = require(`${B}/bureau/episode-steps.js`);
const { estimateEpisode } = require(`${B}/bureau/estimate.js`);
const { importFolderBible } = require(`${B}/channels/bible-admin.js`);
const { getBible } = require(`${B}/bureau/bible.js`);
const { formatOf, paceOf } = require(`${B}/bureau/formats.js`);
const { restartHaltedEpisode } = require(`${B}/bureau/control.js`);
const { BUREAU_CHANNEL_ID: CH } = require(`${B}/fixtures/seed-channel.js`);
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
const APPROVER = { scope: 'approver', profileId: null, via: 'harness' };
const AGENT = { scope: 'agent', profileId: null, via: 'harness' };
const work = await mkdtemp(join(tmpdir(), 'kiln-settings-'));
const scratch = await scratchDatabase(dbUrl, 'settings');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
const authorship = async (action) => q(`select payload, exact_text, actor_scope from authorship_log where action = $1 order by occurred_at`, [action]);

// A 2-second tone: the stub "synthesiser" output, and the raw VO the assembler downloads.
const tone = join(work, 'tone.wav');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-ac', '1', '-ar', '48000', tone]);

console.log('\nSettings — generation, assembly, publishing, danger zone\n');
try {
  // ══ §0 ═══════════════════════════════════════════════════════════════════
  console.log('0. Every foreign key into assets is on the orphan finder’s list\n');
  // LOAD-BEARING: the catalogue is the independent side. If this passes vacuously (no FKs
  // found), the count check below fails — it is asserted, not assumed, that there are some.
  const fks = (await q(`select conrelid::regclass::text as t, a.attname as c
                          from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
                         where k.contype = 'f' and k.confrelid = 'assets'::regclass`)).map((r) => `${r.t}.${r.c}`).sort();
  const listed = O.ASSET_FOREIGN_KEYS.map((f) => `${f.table}.${f.column}`).sort();
  check(fks.length >= 5 && JSON.stringify(fks) === JSON.stringify(listed), 'pg_constraint and ASSET_FOREIGN_KEYS name the same columns', fks.join(', '));

  // ══ §1 ═══════════════════════════════════════════════════════════════════
  console.log('\n1. The 0049 defaults are the constants they replaced\n');
  const t0 = await T.readTuning(db, CH);
  check(t0.source === 'channel' && JSON.stringify(t0.values) === JSON.stringify({ ...T.TUNING_DEFAULTS }), 'a fresh channel reads exactly TUNING_DEFAULTS from its own row', JSON.stringify(t0.values));

  // ══ §2 ═══════════════════════════════════════════════════════════════════
  console.log('\n2. Writes: approver only, in range, one authorship row each\n');
  const agent = await S.updateTuning(db, AGENT, CH, { lineGapS: 0.3 });
  check(!agent.ok && agent.refused === 'Only the approver can change settings.', 'an agent is refused by name', agent.refused);
  const range = await S.updateTuning(db, APPROVER, CH, { captionScale: 0.5 });
  check(!range.ok && /captionScale/.test(range.refused), 'a caption scale of 0.5 is refused naming the field', range.refused);
  let checkRefused = false;
  try {
    await q(`update channel_policy set hook_s = 9 where channel_id = $1`, [CH]);
  } catch (e) {
    checkRefused = /hook_s/.test(String(e.message));
  }
  check(checkRefused, '  · and the database CHECK refuses the same kind of value written by SQL', '');
  const unknown = await S.updateTuning(db, APPROVER, CH, { gapBetweenLines: 1 });
  check(!unknown.ok, '  · an unknown key is refused rather than ignored', unknown.refused);

  // ══ §3 ═══════════════════════════════════════════════════════════════════
  console.log('\n3. Pictures: the estimate prices a still at the channel’s pictures-per-shot\n');
  const [rate] = await q(`select unit_cost from rate_card where model = 'gen4_image' and unit = 'image_720p' and is_verified`);
  const usd = Number(rate.unit_cost);
  const still = [{ route: 'still', description: 'x', duration_s: 18, characters: [], realistic: false }];
  const e1 = await estimateEpisode(db, { shots: still, voChars: 0, usdInrRate: 88, channelId: CH });
  check(e1.shots[0].inr === Math.round(usd * 88 * 3 * 100) / 100 && / × 3$/.test(e1.shots[0].basis), 'defaults: 18 s at 6 s a picture is 3 pictures', `${e1.shots[0].inr} · ${e1.shots[0].basis}`);
  const w1 = await S.updateTuning(db, APPROVER, CH, { secondsPerPicture: 3, maxPicturesPerShot: 5 });
  check(w1.ok && w1.changed.join() === 'seconds_per_picture,max_pictures_per_shot', 'the approver sets 3 s a picture, at most 5', w1.ok ? w1.message : w1.refused);
  const [a1] = await authorship('settings_update');
  check(
    a1?.actor_scope === 'approver' && same(a1.payload, { before: { seconds_per_picture: 6, max_pictures_per_shot: 4 }, after: { seconds_per_picture: 3, max_pictures_per_shot: 5 } }),
    '  · one authorship row with what it was and what it became',
    JSON.stringify(a1?.payload),
  );
  const e2 = await estimateEpisode(db, { shots: still, voChars: 0, usdInrRate: 88, channelId: CH });
  check(e2.shots[0].inr === Math.round(usd * 88 * 5 * 100) / 100 && / × 5$/.test(e2.shots[0].basis), '  · the same shot is now priced as 5 pictures (6 capped at 5)', `${e2.shots[0].inr} · ${e2.shots[0].basis}`);
  const noop = await S.updateTuning(db, APPROVER, CH, { secondsPerPicture: 3 });
  check(noop.ok && noop.changed.length === 0 && (await authorship('settings_update')).length === 1, '  · saving the same value changes nothing and logs nothing', noop.ok ? noop.message : noop.refused);

  // ── A world for §4–§6: one approved episode with a script of two lines ────
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 's@invalid.test', 88) returning id`);
  const [concept] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 't', 'a', 'v', 'in_production') returning id`, [CH]);
  const lines = [
    { idx: 0, speaker: 'pip', text: 'The Moon pulls the sea.', voStart: 0, voEnd: 23 },
    { idx: 1, speaker: 'pip', text: 'Twice a day, every day.', voStart: 24, voEnd: 47 },
  ];
  const [script] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', $2, $3, 'x', 'h') returning id`, [concept.id, JSON.stringify({ lines }), lines.map((l) => l.text).join(' ')]);
  const [brief] = await q(`insert into briefs (channel_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, fact, titles, pinned_comment, status, chosen_punchline, approved_at, created_by)
     values ($1, 'incident', 'pip', 'gravity', 'Pip misplaces the Moon again.', 'x', 'y', 'z', 'w', 'question', '["a","b","c"]', '[]', 'Pip: hi', '{"claim":"c","source_url":"https://nasa.gov"}', '[{"text":"Where did the Moon go","hook_archetype":"question"},{"text":"b","hook_archetype":"question"},{"text":"c","hook_archetype":"question"}]', 'p', 'approved', 'b', now(), 'agent') returning id`, [CH]);
  const [ep] = await q(`insert into episodes (brief_id, channel_id, script_id, status) values ($1, $2, $3, 'voicing') returning id`, [brief.id, CH, script.id]);

  // ══ §4 ═══════════════════════════════════════════════════════════════════
  console.log('\n4. Voice: lines laid out with the channel’s gap and tail\n');
  await S.updateTuning(db, APPROVER, CH, { lineGapS: 0.5, tailS: 1.25 });
  const stored = new Map();
  const putBytes = async (key, body) => {
    const chunks = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    stored.set(key, Buffer.concat(chunks));
    return Buffer.concat(chunks).length;
  };
  const voice = await P.voiceStep(db, ep.id, {
    usdInrRate: 88,
    apiKeyFor: async () => ({ ok: true, value: 'k' }),
    synth: async ({ outPath }) => {
      await copyFile(tone, outPath);
      return { ok: true, path: outPath, requestId: null, words: null, estimatedCredits: 1 };
    },
    align: async ({ text, audioPath }) => {
      const ws = text.split(/\s+/);
      void audioPath;
      return { ok: true, words: ws.map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.25 })), meanCost: 0, costRatio: 0, durationS: 2 };
    },
    putBytes,
    presign: async (k) => `stub://${k}`,
    routeFor: () => ({ ok: true, provider: 'runway', voiceId: 'Maya', integration: 'runway', model: 'eleven_v3' }),
  });
  const takes = await q(`select chunk_idx, offset_s, duration_s from vo_takes where script_id = $1 order by chunk_idx`, [script.id]);
  const gap = Math.round((Number(takes[1]?.offset_s) - Number(takes[0]?.offset_s) - Number(takes[0]?.duration_s)) * 1000) / 1000;
  const tail = voice.ok ? Math.round((voice.totalS - Number(takes[1].offset_s) - Number(takes[1].duration_s)) * 1000) / 1000 : null;
  check(voice.ok && takes.length === 2, 'the voice step ran on the stub synthesiser', voice.ok ? `${voice.totalS} s` : voice.detail);
  check(gap === 0.5, '  · the second line starts 0.5 s after the first ends (default 0.18)', `${gap} s`);
  check(tail === 1.25, '  · and the track holds 1.25 s after the last word (default 0.6)', `${tail} s`);

  // ══ §5 ═══════════════════════════════════════════════════════════════════
  console.log('\n5. Assembly: pictures, text sizes, hook and loudness from the channel\n');
  // One 18 s still shot with six stored pictures (parts 0–5), so the count drawn is decided by
  // the setting alone; one 4 s overlay shot. Durations are measured (derived_from_vo).
  const [sStill] = await q(`insert into shots (script_id, idx, description, duration_s, duration_source, render_route, status) values ($1, 0, 'tides', 18, 'derived_from_vo', 'still', 'ready') returning id`, [script.id]);
  await q(`insert into shots (script_id, idx, description, duration_s, duration_source, render_route, overlay_spec, status) values ($1, 1, 'chalk', 4, 'derived_from_vo', 'overlay', '{"camera":"push"}', 'ready')`, [script.id]);
  for (let k = 0; k < 6; k++) {
    const [g] = await q(`insert into generations (shot_id, kind, driver, model, request_payload, status, idempotency_key, completed_at) values ($1, 'image', 'runway', 'gen4_image', $2, 'succeeded', $3, now()) returning id`, [sStill.id, JSON.stringify({ part: k }), `still:${sStill.id}:${k}`]);
    await q(`insert into assets (generation_id, kind, storage_key) values ($1, 'image', $2)`, [g.id, `stills/${sStill.id}/0-${k}.png`]);
  }
  const calls = { render: [], normalise: [] };
  const asmDeps = {
    usdInrRate: 88,
    presign: async (k) => `stub://${k}`,
    putBytes,
    download: async (_url, out) => copyFile(tone, out),
    normaliseAudio: async (i, o, target) => {
      calls.normalise.push(target);
      await copyFile(i, o);
    },
    render: async (input) => {
      calls.render.push(input.props);
      await writeFile(input.outputPath, 'stub render');
      return { ok: true, frames: input.durationInFrames, serveUrl: 'stub://serve' };
    },
  };
  // Defaults first (the picture numbers were changed in §3; put them back for this pass).
  await S.updateTuning(db, APPROVER, CH, { secondsPerPicture: 6, maxPicturesPerShot: 4 });
  const asm1 = await P.assembleEpisode(db, ep.id, asmDeps, { layers: ['composite'] });
  const p1 = calls.render[0];
  const stills1 = p1?.shots.filter((s) => s.type === 'still').length;
  check(asm1.ok && stills1 === 3 && p1.textScale.caption === 0.032 && p1.textScale.hook === 0.05 && p1.hook.endS === 2 && calls.normalise[0] === -14, 'defaults: 3 pictures, caption 0.032, hook 0.05 for 2 s, −14 LUFS', JSON.stringify({ stills1, ts: p1?.textScale, hook: p1?.hook?.endS, lufs: calls.normalise[0] }));
  await S.updateTuning(db, APPROVER, CH, { secondsPerPicture: 3, maxPicturesPerShot: 5, captionScale: 0.04, hookScale: 0.07, hookS: 3.5, loudnessLufs: -16 });
  const asm2 = await P.assembleEpisode(db, ep.id, asmDeps, { layers: ['composite'] });
  const p2 = calls.render[1];
  const stills2 = p2?.shots.filter((s) => s.type === 'still');
  check(asm2.ok && stills2?.length === 5, 'tuned: the same shot is cut into 5 pictures', `${stills2?.length}`);
  check(stills2?.reduce((n, s) => n + s.frames, 0) === 540, '  · and they still fill exactly the shot’s 540 frames, so sync to the voice holds', `${stills2?.reduce((n, s) => n + s.frames, 0)}`);
  check(p2?.textScale.caption === 0.04 && p2.textScale.hook === 0.07, '  · captions and hook at the channel’s sizes', JSON.stringify(p2?.textScale));
  check(p2?.hook.endS === 3.5, '  · the hook holds 3.5 s', `${p2?.hook.endS}`);
  check(calls.normalise[1] === -16 && stored.has(`vo/${script.id}/en/track-16lufs.m4a`), '  · the VO is normalised to −16 LUFS, stored under its own key', `${calls.normalise[1]}`);

  // ══ §6 ═══════════════════════════════════════════════════════════════════
  console.log('\n6. Publishing: disclosures and the slot time\n');
  const [render] = await q(`select id from renders where script_id = $1 order by created_at desc limit 1`, [script.id]);
  const [review] = await q(`insert into reviews (render_id, reviewer_id, decision, structure_novel) values ($1, $2, 'pass', true) returning id`, [render.id, prof.id]);
  await q(`update episodes set review_id = $1, final_render_id = $2, status = 'cut_approved' where id = $3`, [review.id, render.id, ep.id]);
  await S.updateTuning(db, APPROVER, CH, { madeForKids: true, syntheticDisclosure: 'always' });
  await P.bundleEpisode(db, ep.id);
  const [pub] = await q(`select made_for_kids, altered_content_disclosed, bundle from publications where episode_id = $1`, [ep.id]);
  check(pub?.made_for_kids === true && pub.bundle.made_for_kids === true, 'madeForKids comes from Settings (it was a literal false)', JSON.stringify({ row: pub?.made_for_kids, bundle: pub?.bundle?.made_for_kids }));
  check(pub?.altered_content_disclosed === true && pub.bundle.contains_synthetic_media === true, '  · “always” sets the synthetic flag with no realistic shot in the episode', JSON.stringify({ row: pub?.altered_content_disclosed, bundle: pub?.bundle?.contains_synthetic_media }));
  check(T.syntheticFlag('auto', false) === false && T.syntheticFlag('auto', true) === true && T.syntheticFlag('always', false) === true, '  · and “auto” is the realistic-shot test, unchanged');

  const badTz = await S.updateSlot(db, APPROVER, CH, { slotTime: '19:30', timezone: 'Mars/Olympus_Mons' });
  check(!badTz.ok && /timezone/.test(badTz.refused), 'a zone Postgres would not know is refused (it would break v_slot_status)', badTz.refused);
  const badTime = await S.updateSlot(db, APPROVER, CH, { slotTime: '7pm', timezone: 'Asia/Kolkata' });
  check(!badTime.ok, '  · so is a time that is not HH:MM', badTime.refused);
  const [slot] = await q(`select id, slot_date::text as d from slots where channel_id = $1 and slot_date is not null order by slot_date limit 1`, [CH]);
  const slotOk = await S.updateSlot(db, APPROVER, CH, { slotTime: '19:30', timezone: 'Europe/London' });
  const [vs] = await q(`select publish_at from v_slot_status where id = $1`, [slot.id]);
  const [expect] = await q(`select ($1::date + time '19:30') at time zone 'Europe/London' as at`, [slot.d]);
  check(slotOk.ok && vs.publish_at.getTime() === expect.at.getTime(), `slot ${slot.id} now publishes at 19:30 London`, vs.publish_at.toISOString());

  // ══ §7 ═══════════════════════════════════════════════════════════════════
  console.log('\n7. Series defaults and the picture style, through the bible\n');
  const folderOnly = await S.updateSeriesDefaults(db, APPROVER, CH, 'incident', { visual_format: 'diagram' });
  check(!folderOnly.ok && /0048/.test(folderOnly.refused), 'with only the folder bible, the series is read-only and says why', folderOnly.refused);
  await importFolderBible(db, { channelId: CH, slug: 'bureau-of-reality', by: 'import:harness' });
  check(!(await S.updateSeriesDefaults(db, AGENT, CH, 'incident', { visual_format: 'diagram' })).ok, '  · an agent is refused');
  check(!(await S.updateSeriesDefaults(db, APPROVER, CH, 'incident', { visual_format: 'claymation' })).ok, '  · an unknown video type is refused');
  const sd = await S.updateSeriesDefaults(db, APPROVER, CH, 'incident', { visual_format: 'diagram', voice_pace: 'fast' });
  const cb = await getBible(db, CH);
  const inc = cb.seriesFor('incident');
  check(sd.ok && formatOf({ seriesFormat: inc.visual_format }).format === 'diagram' && paceOf({ seriesPace: inc.voice_pace }).tempo === 1.3, 'Incident now starts as chalk diagrams at the fast pace, read back through getBible', JSON.stringify({ f: inc.visual_format, p: inc.voice_pace }));
  check(formatOf({ seriesFormat: inc.visual_format, approvedEdits: { visual_format: 'illustrated' } }).source === 'episode', '  · and Approvals can still override it per episode');
  check((await authorship('series_update')).length === 1, '  · written to authorship by the existing series path');
  check(!(await S.updateStillStyle(db, APPROVER, CH, '   ')).ok, 'an empty picture style is refused');
  check(!(await S.updateStillStyle(db, APPROVER, CH, 'x'.repeat(401))).ok, '  · so is one over 400 characters');
  const style = 'Bold flat cartoon of the scene on cream paper, thick ink outlines, two flat colours.';
  const st = await S.updateStillStyle(db, APPROVER, CH, `  ${style}  `);
  const cb2 = await getBible(db, CH);
  check(st.ok && cb2.bible.world.still_style === style, 'a valid style is saved trimmed and read back', cb2.bible.world.still_style);
  check(S.stillPromptPreview(cb2.bible.world, '#ff0000').includes(style) && /no people/i.test(S.stillPromptPreview(cb2.bible.world, '#ff0000')), '  · the preview is the composed prompt: the style, then the no-people clause code appends');
  const [sa] = await authorship('still_style_update');
  check(sa?.exact_text === style && sa.payload.after === style, '  · authorship holds the exact text', sa?.exact_text);

  // ══ §8 ═══════════════════════════════════════════════════════════════════
  console.log('\n8. Unstick an episode\n');
  const [brief2] = await q(`insert into briefs (channel_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, fact, titles, pinned_comment, status, chosen_punchline, approved_at, created_by)
     values ($1, 'incident', 'pip', 'gravity', 'Pip stalls.', 'x', 'y', 'z', 'w', 'question', '["a","b","c"]', '[]', 'Pip: hi', '{"claim":"c","source_url":"https://nasa.gov"}', '["a","b","c"]', 'p', 'approved', 'b', now(), 'agent') returning id`, [CH]);
  const [ep2] = await q(`insert into episodes (brief_id, channel_id, status, run_id) values ($1, $2, 'assembling', 'run_dead') returning id`, [brief2.id, CH]);
  const phrase = await S.confirmPhrase(db, CH);
  const live = await S.unstickEpisode(db, APPROVER, CH, { episodeId: ep2.id, reason: 'worker died', confirm: phrase });
  check(!live.ok && /run in progress/.test(live.refused), 'an episode that wrote a moment ago is a run, and is refused', live.refused);
  await q(`update episodes set updated_at = now() - interval '2 hours' where id = $1`, [ep2.id]);
  const wrong = await S.unstickEpisode(db, APPROVER, CH, { episodeId: ep2.id, reason: 'worker died', confirm: 'bureau' });
  check(!wrong.ok && wrong.refused.includes(phrase), '  · a wrong slug is refused, naming the right one', wrong.refused);
  check(!(await S.unstickEpisode(db, AGENT, CH, { episodeId: ep2.id, reason: 'worker died', confirm: phrase })).ok, '  · an agent is refused');
  const listed2 = (await S.stuckEpisodes(db, CH)).map((e) => e.id);
  check(listed2.includes(ep2.id) && !listed2.includes(ep.id), '  · the screen lists the quiet one and not the bundled one');
  const un = await S.unstickEpisode(db, APPROVER, CH, { episodeId: ep2.id, reason: 'worker died during render', confirm: phrase });
  const [e2row] = await q(`select status, status_detail from episodes where id = $1`, [ep2.id]);
  check(un.ok && e2row.status === 'halted' && e2row.status_detail === 'unstuck from Settings: worker died during render', 'halted, with the reason', JSON.stringify(e2row));
  const [ua] = await authorship('episode_unstick');
  check(ua?.payload.before.status === 'assembling' && ua.exact_text === 'worker died during render', '  · authorship holds the status it had and the reason');
  const started = [];
  const restart = await restartHaltedEpisode(db, { id: 'harness', scope: 'approver', channelId: CH, profileId: null, name: 'h' }, { startEpisode: async (id) => (started.push(id), 'run_new') }, { episode_id: ep2.id });
  check(restart.ok && started[0] === ep2.id, '  · and Restart run accepts it — the point of halting it', JSON.stringify(restart));
  const bundled = await S.unstickEpisode(db, APPROVER, CH, { episodeId: ep.id, reason: 'no reason', confirm: phrase });
  check(!bundled.ok, 'a bundled episode cannot be unstuck', bundled.refused);
  const [counts] = await q(`select (select count(*) from episodes)::int as e, (select count(*) from briefs)::int as b`);
  check(counts.e === 2 && counts.b === 2, '  · and nothing was deleted', JSON.stringify(counts));

  // ══ §9 ═══════════════════════════════════════════════════════════════════
  console.log('\n9. Orphans: exactly the seeded ones, a purge that checks twice\n');
  const old = `now() - interval '3 days'`;
  const ins = async (kind, key, extra = '') => (await q(`insert into assets (kind, storage_key, bytes, created_at${extra ? ', generation_id' : ''}) values ($1, $2, 1000, ${old}${extra ? `, ${extra}` : ''}) returning id`, [kind, key]))[0].id;
  const orphanA = await ins('video', 'renders/dead/a.mp4');
  const orphanB = await ins('audio', 'vo/dead/b.m4a');
  const byRender = await ins('video', 'renders/live/r.mp4');
  await q(`insert into renders (script_id, variant_group_id, variant_label, format, width, height, asset_id) values ($1, gen_random_uuid(), 'x', 'shorts_9x16', 1080, 1920, $2)`, [script.id, byRender]);
  const [gen] = await q(`select id from generations limit 1`);
  const byGen = await ins('image', 'stills/live/g.png', `'${gen.id}'`);
  const byVoice = await ins('audio', 'vo/live/track.m4a');
  await q(`update episodes set voice_detail = jsonb_build_object('vo_asset_id', $1::text) where id = $2`, [byVoice, ep2.id]);
  const byBundleKey = await ins('caption', 'renders/live/captions-en.srt');
  await q(`update publications set bundle = bundle || jsonb_build_object('files', jsonb_build_object('captions_srt', 'renders/live/captions-en.srt')) where episode_id = $1`, [ep.id]);
  const music = await ins('music', 'music/bed.mp3');
  const [young] = await q(`insert into assets (kind, storage_key, bytes) values ('video', 'renders/new/y.mp4', 5) returning id`);
  const nullSize = (await q(`insert into assets (kind, storage_key, created_at) values ('image', 'x/no-size.png', ${old}) returning id`))[0].id;
  const rep = await O.findOrphans(db);
  const got = rep.orphans.map((o) => o.id).sort();
  const want = [orphanA, orphanB, nullSize].sort();
  check(JSON.stringify(got) === JSON.stringify(want), 'findOrphans returns exactly the three seeded orphans', `${got.length} found`);
  check(![byRender, byGen, byVoice, byBundleKey, music, young.id].some((id) => got.includes(id)), '  · not the ones a render, a generation, voice_detail, a bundle key, the music library or youth protects');
  check(rep.knownBytes === 2000 && rep.unknownSize === 1, '  · 2 000 bytes known, and one with no recorded size counted apart (absent ≠ zero)', `${rep.knownBytes} + ${rep.unknownSize} unknown`);
  const ids = rep.orphans.map((o) => o.id);
  check(!(await S.requestOrphanPurge(db, AGENT, CH, { confirm: phrase, count: 3, assetIds: ids })).ok, 'a purge request from an agent is refused');
  check(!(await S.requestOrphanPurge(db, APPROVER, CH, { confirm: 'nope', count: 3, assetIds: ids })).ok, '  · without the slug, refused');
  const wrongCount = await S.requestOrphanPurge(db, APPROVER, CH, { confirm: phrase, count: 2, assetIds: ids });
  check(!wrongCount.ok && /confirmed 2/.test(wrongCount.refused), '  · with the wrong count (the second confirmation), refused', wrongCount.refused);
  const req = await S.requestOrphanPurge(db, APPROVER, CH, { confirm: phrase, count: 3, assetIds: ids });
  check(req.ok && req.assetIds.length === 3 && (await authorship('orphans_purge_requested')).length === 1, 'the approver’s request passes and is recorded', req.ok ? req.message : req.refused);
  // Between the dry run and the worker, one gains a reference: the worker must keep it.
  await q(`insert into renders (script_id, variant_group_id, variant_label, format, width, height, asset_id) values ($1, gen_random_uuid(), 'late', 'shorts_9x16', 1080, 1920, $2)`, [script.id, orphanB]);
  const deletedKeys = [];
  const purge = await O.purgeOrphans(db, ids, async (k) => void deletedKeys.push(k));
  const left = (await q(`select id from assets where id = any($1::uuid[])`, [ids])).map((r) => r.id);
  check(purge.deleted.sort().join() === [orphanA, nullSize].sort().join() && purge.kept.join() === orphanB, 'the worker deletes the two still orphaned and keeps the one referenced since', JSON.stringify({ deleted: purge.deleted.length, kept: purge.kept.length }));
  check(deletedKeys.sort().join() === 'renders/dead/a.mp4,x/no-size.png' && left.join() === orphanB, '  · bytes deleted by key, then the rows; the kept row is still there');

  // ══ §11 (O5) ═══════════════════════════════════════════════════════════════
  console.log('\n11. Relevance threshold and voice overflow (0051): approver only, ranged, logged, and apart from the 0049 values\n');
  {
    const F = require(`${B}/settings/channel-flags.js`);
    const r0 = await F.readChannelFlags(db, CH);
    check(r0.source === 'channel' && r0.values.relevanceThreshold === 0.65 && r0.values.voiceOverflow === false, 'the defaults from the migration: 0.65 and off', JSON.stringify(r0.values));
    const ag = await S.updateChannelFlags(db, AGENT, CH, { voiceOverflow: true });
    check(!ag.ok && ag.refused === 'Only the approver can change settings.', '  · an agent is refused', ag.ok ? 'saved' : ag.refused);
    const out = await S.updateChannelFlags(db, APPROVER, CH, { relevanceThreshold: 1.5 });
    check(!out.ok && /relevanceThreshold/.test(out.refused), '  · 1.5 is refused by the schema', out.ok ? 'saved' : out.refused);
    let dbRefused = null;
    try { await q(`update channel_policy set relevance_threshold = 1.5 where channel_id = $1`, [CH]); } catch (e) { dbRefused = e.message; }
    check(/check constraint/.test(dbRefused ?? ''), '  · and by the CHECK for a caller that skips it', dbRefused);
    const logBefore = Number((await q(`select count(*)::int n from authorship_log where channel_id = $1 and action = 'settings_update'`, [CH]))[0].n);
    const w = await S.updateChannelFlags(db, APPROVER, CH, { voiceOverflow: true, relevanceThreshold: 0.7 });
    const row = (await q(`select voice_overflow, relevance_threshold from channel_policy where channel_id = $1`, [CH]))[0];
    const lg = (await q(`select payload from authorship_log where channel_id = $1 and action = 'settings_update' order by occurred_at desc limit 1`, [CH]))[0];
    const logAfter = Number((await q(`select count(*)::int n from authorship_log where channel_id = $1 and action = 'settings_update'`, [CH]))[0].n);
    check(w.ok && row.voice_overflow === true && row.relevance_threshold === '0.7' && logAfter === logBefore + 1 &&
      lg.payload.before.relevance_threshold === 0.65 && lg.payload.before.voice_overflow === false && lg.payload.after.relevance_threshold === 0.7 && lg.payload.after.voice_overflow === true &&
      Object.keys(lg.payload.before).length === 2 && Object.keys(lg.payload.after).length === 2,
      'the approver’s change lands and is logged with before and after', JSON.stringify({ row, payload: lg.payload }));
    const tuningStill = await T.readTuning(db, CH);
    check(tuningStill.source === 'channel', '  · the 0049 values are read as before (a separate reader)', tuningStill.source);
    // Without 0051: defaults and the reason; the tuning reader is unaffected.
    await q(`alter table channel_policy drop column relevance_threshold, drop column voice_overflow`);
    const r1 = await F.readChannelFlags(db, CH);
    const t2 = await T.readTuning(db, CH);
    check(r1.source === 'defaults' && r1.reason === F.FLAGS_NEED_0051 && r1.values.voiceOverflow === false && t2.source === 'channel',
      'before 0051 is pasted: the built-in values and the reason; every 0049 value still read from the channel', `${r1.reason} · tuning ${t2.source}`);
    const w2 = await S.updateChannelFlags(db, APPROVER, CH, { voiceOverflow: true });
    check(!w2.ok && w2.refused === F.FLAGS_NEED_0051, '  · and a write refuses with the same sentence', w2.ok ? 'saved' : w2.refused);
  }

  // ══ §10 ══════════════════════════════════════════════════════════════════
  console.log('\n10. Before 0049 is pasted: the constants, and the reason, on every screen\n');
  await q(`alter table channel_policy drop column seconds_per_picture, drop column max_pictures_per_shot, drop column line_gap_s, drop column tail_s,
             drop column loudness_target_lufs, drop column caption_scale, drop column hook_scale, drop column hook_s, drop column made_for_kids_default, drop column synthetic_disclosure`);
  const t1 = await T.readTuning(db, CH);
  check(t1.source === 'defaults' && t1.reason === T.TUNING_NEEDS_0049 && JSON.stringify(t1.values) === JSON.stringify({ ...T.TUNING_DEFAULTS }), 'readTuning returns the constants and names 0049', t1.reason);
  const w0 = await S.updateTuning(db, APPROVER, CH, { hookS: 1 });
  check(!w0.ok && w0.refused === T.TUNING_NEEDS_0049, '  · a write refuses with the same sentence', w0.ok ? 'saved' : w0.refused);
  const e3 = await estimateEpisode(db, { shots: still, voChars: 0, usdInrRate: 88, channelId: CH });
  check(/ × 3$/.test(e3.shots[0].basis), '  · and the estimate still prices 3 pictures — today’s behaviour, unchanged', e3.shots[0].basis);
} finally {
  await scratch.release();
  await rm(work, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}
console.log('\nSettings reach the code paths that used the constants; the danger zone refuses by name and deletes only what is still orphaned.\n');
