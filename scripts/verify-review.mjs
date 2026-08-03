#!/usr/bin/env node
/**
 * Exercise the review screen's logic for real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Against a synthetic set built with ffmpeg — four real clips, normalised to the
 *   canonical intermediate by the real `normalise`, stored through the real storage driver,
 *   with real generations/assets/vo_takes rows — `readReview` assembles the timeline the
 *   screen renders.
 *
 *   A trim shortens the picture and not the voice, and the drift shows up on every
 *   *later* shot rather than only the trimmed one. This is the whole reason the module
 *   exists: it is a cut that plays perfectly and says the wrong words over the wrong
 *   images, and nothing else on the screen would catch it.
 *
 *   Caption cues are grouped from word timings across chunk seams, with each chunk's
 *   `offset_s` applied — so a cue on chunk 2 lands where chunk 2 actually plays.
 *
 *   `reorder_shots` renumbers atomically where a plain UPDATE cannot, and refuses a partial
 *   id list.
 *
 *   `reviews` rows are written by the real `recordReview`: `structure_novel` is DERIVED and
 *   not accepted from the caller, `human_edit_count` is frozen at decision time, a reshoot
 *   must name its shots and moves them, and `enforce_review_pass` refuses a publication
 *   whose review is not a pass.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES NOT PROVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Anything about the browser. Remotion Player, wavesurfer and the drag gestures are not
 *   exercised here — this runs the data and the rules, which is where the failures that
 *   matter live. The player composing the wrong frames is visible the first time anyone
 *   looks at it; a half-second drift is not.
 *
 *   Anything about a vendor. Every byte here is produced by ffmpeg.
 *
 * Usage: node scripts/verify-review.mjs <db-url>
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

// See scripts/verify-studio.mjs for why this is here: `server-only` throws outside the RSC
// graph and the modules under test carry it deliberately.
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = {
  id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [],
};

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-review.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { normalise } = require(`${BUILD}/ingest/normalise.js`);
const { captionCues, mergeTakes, moveShot, DRIFT_TOLERANCE_S } =
  require(`${BUILD}/review/timeline.js`);
const { readReview, readQueue } = require(`${BUILD}/review/read.js`);
const { recordReview, writeOrder, writeTrim } = require(`${BUILD}/review/write.js`);
const { estimateRegenerate, executeRegenerate } = require(`${BUILD}/generate/regenerate.js`);

const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

// ── Scratch database. See scripts/lib/scratch.mjs. ─────────────────────────
const scratch = await scratchDatabase(dbUrl, 'review');
const client = scratch.client;
const db = supabaseShim(client);

const work = await mkdtemp(join(tmpdir(), 'kiln-verify-review-'));
process.env.KILN_LOCAL_STORAGE_ROOT = join(work, 'bucket');
const { createLocalStorageDriver, writeStreamLocal } = require(`${BUILD}/storage/local.js`);
const driver = createLocalStorageDriver();

console.log('\nReview screen verification\n');

// ═══════════════════════════════════════════════════════════════════════════
// 0. The synthetic set — four real clips, normalised, stored, and in rows
// ═══════════════════════════════════════════════════════════════════════════

console.log('0. Building the synthetic set\n');

const SOURCES = [
  'testsrc=size=1280x720:rate=25:duration=2',
  'smptebars=size=640x480:rate=30:duration=3',
  'testsrc2=size=1080x1920:rate=24:duration=2',
  'smptehdbars=size=1920x1080:rate=30:duration=3',
];

/**
 * The voiceover, and the shots cut to it.
 *
 * Word timings are authored rather than synthesised — there is no voice vendor in this
 * path, and the thing under test is what the review screen does with timings, not how
 * timings are produced. They are deliberately regular so a drift of exactly the trim
 * length is arithmetically checkable.
 */
const VO_TEXT = 'Cities trap heat in concrete and asphalt all day and release it at night while the countryside cools fast';
const WORDS_PER_CHUNK = 11;
const allWords = VO_TEXT.split(' ');

// One word every 0.5s, two chunks, so the seam and the offset are both exercised.
const chunk0 = allWords.slice(0, WORDS_PER_CHUNK).map((w, i) => ({
  w, start: round(i * 0.5), end: round(i * 0.5 + 0.42),
}));
const chunk1 = allWords.slice(WORDS_PER_CHUNK).map((w, i) => ({
  w, start: round(i * 0.5), end: round(i * 0.5 + 0.42),
}));
const CHUNK1_OFFSET = round(WORDS_PER_CHUNK * 0.5);

const channelId = randomUUID();
const conceptId = randomUUID();
const scriptId = randomUUID();

await client.query(
  `insert into channels (id, name, platform, niche) values ($1,'verify-review','youtube','verification')`,
  [channelId],
);
await client.query(
  `insert into concepts (id, channel_id, title, angle, rubric_version, status)
   values ($1,$2,'Why cities are hotter','the concrete is the story','v1','in_production')`,
  [conceptId, channelId],
);
await client.query(
  `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash, human_edit_count)
   values ($1,$2,'Why cities are hotter','[]',$3,'claude-opus-5','verify-review-hash',3)`,
  [scriptId, conceptId, VO_TEXT],
);

// Shot VO spans, by character offset into VO_TEXT. Each shot covers three words.
const spans = [];
{
  let char = 0;
  for (let s = 0; s < 4; s++) {
    const start = char;
    const wordCount = s === 3 ? allWords.length - 9 : 3;
    for (let i = 0; i < wordCount; i++) {
      char += allWords[s * 3 + i].length + 1;
    }
    spans.push({ start, end: char });
  }
}

const shotIds = [];
for (const [i, source] of SOURCES.entries()) {
  const raw = join(work, `raw-${i}.mp4`);
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', raw]);

  const out = join(work, `norm-${i}.mp4`);
  const result = await normalise(raw, out);
  if (!result.ok) {
    bad(`clip ${i} normalise`, result.error);
    continue;
  }

  const shotId = randomUUID();
  const generationId = randomUUID();
  const assetId = randomUUID();
  const key = `renders/verify/shot-${i}/video.mp4`;

  const { createReadStream } = await import('node:fs');
  await writeStreamLocal(key, createReadStream(out));

  // The derived duration: the span of the words this shot covers.
  const merged = mergeTakes([
    { chunkIdx: 0, offsetS: 0, words: chunk0 },
    { chunkIdx: 1, offsetS: CHUNK1_OFFSET, words: chunk1 },
  ]);
  const derived = spanDuration(merged, VO_TEXT, spans[i]);

  await client.query(
    `insert into shots (id, script_id, idx, duration_s, description, status, vo_char_start, vo_char_end, duration_source)
     values ($1,$2,$3,$4,$5,'ready',$6,$7,'derived_from_vo')`,
    [shotId, scriptId, i, derived, `shot ${i}`, spans[i].start, spans[i].end],
  );
  await client.query(
    `insert into generations (id, shot_id, kind, driver, model, request_payload, idempotency_key, status, confirmed_at)
     values ($1,$2,'video','verify','v','{}',$3,'succeeded',now())`,
    [generationId, shotId, `verify-review:${shotId}`],
  );
  await client.query(
    `insert into assets (id, generation_id, kind, storage_key, duration_s, normalized_at)
     values ($1,$2,'video',$3,$4,now())`,
    [assetId, generationId, key, result.output.durationS],
  );

  shotIds.push(shotId);
}

// The VO take rows, with a real audio asset so the waveform has something to load.
const voPath = join(work, 'vo.m4a');
await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'sine=frequency=220:duration=16', '-c:a', 'aac', voPath]);
const voAssetId = randomUUID();
const voGenId = randomUUID();
{
  const { createReadStream } = await import('node:fs');
  await writeStreamLocal('vo/verify/take.m4a', createReadStream(voPath));
  await client.query(
    `insert into generations (id, kind, driver, model, request_payload, idempotency_key, status)
     values ($1,'audio','verify','v','{}',$2,'succeeded')`, [voGenId, `verify-review:vo:${voGenId}`]);
  await client.query(
    `insert into assets (id, generation_id, kind, storage_key, duration_s)
     values ($1,$2,'audio','vo/verify/take.m4a',16)`, [voAssetId, voGenId]);
}
for (const [chunkIdx, words] of [chunk0, chunk1].entries()) {
  await client.query(
    `insert into vo_takes (script_id, chunk_idx, driver, model, voice_id, text_in, asset_id, word_timings, offset_s)
     values ($1,$2,'verify','v','voice','text',$3,$4,$5)`,
    [scriptId, chunkIdx, voAssetId, JSON.stringify(words), chunkIdx === 0 ? 0 : CHUNK1_OFFSET],
  );
}

const renderId = randomUUID();
const renderAssetId = randomUUID();
await client.query(
  `insert into assets (id, kind, storage_key, duration_s) values ($1,'video','renders/verify/cut.mp4',10)`,
  [renderAssetId],
);
await client.query(
  `insert into renders (id, script_id, variant_group_id, variant_label, format, kind, width, height, duration_s, asset_id, status)
   values ($1,$2,$3,'rough','shorts_9x16','rough_cut',1080,1920,10,$4,'ready')`,
  [renderId, scriptId, randomUUID(), renderAssetId],
);

ok('synthetic set', `${shotIds.length} clips, 2 VO chunks, 1 render`);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The timeline, from the database
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n1. The timeline, assembled by the real read path\n');

let detail;
{
  const read = await readReview(db, renderId, driver);
  if (!read.ok) {
    bad('readReview', read.detail);
    await shutdown();
  }
  detail = read.detail;

  if (detail.timeline.spans.length === 4) ok('four shots on the timeline');
  else bad('four shots on the timeline', String(detail.timeline.spans.length));

  if (detail.voice.words.length === allWords.length) {
    ok('word timings merged across both chunks', `${detail.voice.words.length} words`);
  } else {
    bad('word timings merged across both chunks', `${detail.voice.words.length} of ${allWords.length}`);
  }

  // The seam: chunk 1's first word must land at its offset, not at zero. Getting this wrong
  // puts the whole back half of the captions on top of the front half.
  const firstOfChunk1 = detail.voice.words[WORDS_PER_CHUNK];
  if (Math.abs(firstOfChunk1.start - CHUNK1_OFFSET) < 0.001) {
    ok('the chunk seam carries its offset', `word ${WORDS_PER_CHUNK} starts at ${firstOfChunk1.start}s`);
  } else {
    bad('the chunk seam carries its offset', `${firstOfChunk1.start}s, expected ${CHUNK1_OFFSET}s`);
  }

  if (detail.render.videoUrl) ok('the render presigns'); else bad('the render presigns');
  if (detail.voice.audioUrl) ok('the voiceover presigns'); else bad('the voiceover presigns');

  const drifted = detail.timeline.driftedShotIds.length;
  if (drifted === 0) {
    ok('untrimmed, nothing is flagged', `worst drift ${detail.timeline.worstDriftS}s, under ${DRIFT_TOLERANCE_S}s`);
  } else {
    bad('untrimmed, nothing is flagged', `${drifted} shots adrift`);
  }

  // The small accumulation is real and must be *reported*, not rounded away by the
  // threshold. worstDriftS counting only flagged shots was the first version, and it said
  // 0 about a cut that was a quarter-second out — which reads as perfect.
  if (detail.timeline.worstDriftS > 0) {
    ok('and the sub-threshold drift is still reported', `${detail.timeline.worstDriftS}s`);
  } else {
    bad('and the sub-threshold drift is still reported', 'worstDriftS is 0');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Captions
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n2. Caption cues\n');

{
  const cues = captionCues(detail.voice.words);
  if (cues.length > 0) ok('cues are produced', `${cues.length} cues`);
  else bad('cues are produced', 'none');

  const everyWordOnce = cues.reduce((n, c) => n + c.words.length, 0);
  if (everyWordOnce === detail.voice.words.length) {
    ok('every word appears in exactly one cue');
  } else {
    bad('every word appears in exactly one cue', `${everyWordOnce} of ${detail.voice.words.length}`);
  }

  const overlapping = cues.some((c, i) => i > 0 && c.startS < cues[i - 1].endS);
  if (!overlapping) ok('no two cues overlap');
  else bad('no two cues overlap');

  const tooLong = cues.filter((c) => c.text.length > 42);
  if (tooLong.length === 0) ok('no cue exceeds the line length');
  else bad('no cue exceeds the line length', tooLong.map((c) => c.text).join(' | '));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. The one that matters: a trim moves everything after it
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n3. A trim shortens the picture and not the voice\n');

{
  const firstShot = detail.timeline.spans[0].shot;
  const TRIM = 0.8;
  const newLength = round(firstShot.durationS - TRIM);

  const write = await writeTrim(db, firstShot.id, 0, newLength);
  if (write.ok) ok('the trim is accepted', `0–${newLength}s of ${firstShot.durationS}s`);
  else bad('the trim is accepted', write.message);

  // The baseline matters. Shot boundaries never land exactly on word starts — there is a
  // gap between one word ending and the next beginning — so an untrimmed cut already
  // carries a small accumulating offset. The claim under test is that a trim moves every
  // later shot by exactly the trim *on top of* whatever was already there, not that the
  // drift equals the trim.
  const baseline = detail.timeline.spans.map((s) => s.driftS);

  const after = await readReview(db, renderId, driver);
  if (!after.ok) {
    bad('re-read after the trim', after.detail);
  } else {
    const t = after.detail.timeline;

    if (Math.abs(t.pictureDurationS - (detail.timeline.pictureDurationS - TRIM)) < 0.01) {
      ok('the picture is shorter by exactly the trim', `${t.pictureDurationS}s`);
    } else {
      bad('the picture is shorter by exactly the trim', `${t.pictureDurationS}s`);
    }

    if (Math.abs(t.voDurationS - detail.timeline.voDurationS) < 0.001) {
      ok('the voice is unchanged', `${t.voDurationS}s`);
    } else {
      bad('the voice is unchanged', `${t.voDurationS}s`);
    }

    // The point. Shot 0 still starts at 0 and is fine; every later shot now starts 0.8s
    // early relative to its own line.
    if (t.spans[0].driftS === 0) ok('the trimmed shot itself is still in place');
    else bad('the trimmed shot itself is still in place', String(t.spans[0].driftS));

    const moved = t.spans
      .slice(1)
      .map((s, i) => round((s.driftS ?? 0) - (baseline[i + 1] ?? 0)));
    const allShifted = moved.every((d) => Math.abs(d + TRIM) < 0.01);
    if (allShifted) {
      ok('every later shot moves by exactly the trim', moved.map((d) => d.toFixed(2)).join(', '));
    } else {
      bad('every later shot moves by exactly the trim', moved.map((d) => d.toFixed(2)).join(', '));
    }

    if (t.driftedShotIds.length === moved.length) {
      ok('and all of them are flagged', `${t.driftedShotIds.length} over ${DRIFT_TOLERANCE_S}s`);
    } else {
      bad('and all of them are flagged', `${t.driftedShotIds.length} of ${moved.length}`);
    }

    console.log(
      `\n        A cut that plays perfectly: ${t.pictureDurationS}s of picture against ` +
      `${t.voDurationS}s of voice,\n        with the last three shots ${Math.abs(t.spans[3].driftS)}s ` +
      `ahead of the words they were cut to.\n`,
    );
  }

  // Put it back so later sections start from a clean timeline.
  await writeTrim(db, firstShot.id, null, null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Trim validation
// ═══════════════════════════════════════════════════════════════════════════

console.log('4. A window that could not exist is refused\n');

{
  const shot = detail.timeline.spans[1].shot;

  const cases = [
    { name: 'out before in', args: [2, 1] },
    { name: 'half a window', args: [1, null] },
    { name: 'past the end of the clip', args: [0, shot.durationS + 5] },
    { name: 'negative in point', args: [-1, 2] },
  ];

  for (const c of cases) {
    const result = await writeTrim(db, shot.id, c.args[0], c.args[1]);
    if (!result.ok) ok(`refused: ${c.name}`, result.message.slice(0, 64));
    else bad(`refused: ${c.name}`, 'it was accepted');
  }

  // And the database refuses it too, independently of the application check — which is the
  // one that matters, because the application check can be bypassed and the constraint
  // cannot.
  const direct = await client
    .query(`update shots set trim_in_s = 3, trim_out_s = 1 where id = $1`, [shot.id])
    .then(() => null)
    .catch((e) => e);
  if (direct) ok('the CHECK constraint refuses it independently', direct.message.split('\n')[0]);
  else bad('the CHECK constraint refuses it independently', 'the update succeeded');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Reorder
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n5. Reordering\n');

{
  const current = detail.timeline.spans.map((s) => s.shot);
  const reversed = [...current].reverse().map((s) => s.id);

  const result = await writeOrder(db, scriptId, reversed);
  if (result.ok) ok('the order is saved');
  else bad('the order is saved', result.message);

  const { rows } = await client.query(
    `select id, idx from shots where script_id = $1 order by idx`, [scriptId],
  );
  if (rows.map((r) => r.id).join(',') === reversed.join(',')) {
    ok('the rows are renumbered in one statement', rows.map((r) => r.idx).join(','));
  } else {
    bad('the rows are renumbered in one statement', rows.map((r) => r.idx).join(','));
  }

  const partial = await writeOrder(db, scriptId, reversed.slice(0, 2));
  if (!partial.ok && /out of date/.test(partial.message)) {
    ok('a stale list is refused rather than half-applied');
  } else {
    bad('a stale list is refused rather than half-applied', partial.message);
  }

  // The pure function the keyboard and the drag both go through.
  const moved = moveShot(current, current[0].id, 2);
  if (moved.length === current.length && moved[2] === current[0].id) {
    ok('moveShot returns the complete order');
  } else {
    bad('moveShot returns the complete order', moved.join(','));
  }

  await writeOrder(db, scriptId, current.map((s) => s.id));
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. The reviews rows, and the publish gate
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n6. Reviews, and the gate they feed\n');

const reviewerId = randomUUID();

{
  const notNamed = await recordReview(db, {
    renderId, reviewerId, decision: 'reshoot', reshootShotIds: [], notes: null,
  });
  if (!notNamed.ok) ok('a reshoot that names no shots is refused', notNamed.message.slice(0, 60));
  else bad('a reshoot that names no shots is refused');

  const nonsense = await recordReview(db, {
    renderId, reviewerId, decision: 'approve', reshootShotIds: [], notes: null,
  });
  if (!nonsense.ok) ok('a decision outside the closed set is refused');
  else bad('a decision outside the closed set is refused');

  const reshoot = await recordReview(db, {
    renderId, reviewerId, decision: 'reshoot',
    reshootShotIds: [shotIds[2]], notes: 'the third shot is the wrong building',
  });
  if (reshoot.ok) ok('a reshoot is recorded');
  else bad('a reshoot is recorded', reshoot.message);

  const { rows: moved } = await client.query(
    `select status from shots where id = $1`, [shotIds[2]],
  );
  if (moved[0].status === 'reshoot') ok('and it moves the shot it names', 'shots.status = reshoot');
  else bad('and it moves the shot it names', moved[0].status);

  // structure_novel is derived. The script's hash is unique here, so it must be true — and
  // the caller never had a way to say so.
  const { rows: rev } = await client.query(
    `select structure_novel, human_edit_count from reviews where render_id = $1 order by created_at desc limit 1`,
    [renderId],
  );
  if (rev[0].structure_novel === true) ok('structure_novel is derived, not supplied');
  else bad('structure_novel is derived, not supplied', String(rev[0].structure_novel));

  if (rev[0].human_edit_count === 3) ok('human_edit_count is frozen from the script', '3');
  else bad('human_edit_count is frozen from the script', String(rev[0].human_edit_count));
}

// A colliding structure must flip it, without anybody being asked.
{
  const twinConcept = randomUUID();
  await client.query(
    `insert into concepts (id, channel_id, title, angle, rubric_version) values ($1,$2,'twin','same shape','v1')`,
    [twinConcept, channelId],
  );
  await client.query(
    `insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1,'h','[]','v','claude-opus-5','verify-review-hash')`,
    [twinConcept],
  );

  const again = await recordReview(db, {
    renderId, reviewerId, decision: 'pass', reshootShotIds: [], notes: 'second look',
  });
  if (!again.ok) bad('a second review is recorded', again.message);

  const { rows } = await client.query(
    `select structure_novel from reviews where render_id = $1 order by created_at desc limit 1`,
    [renderId],
  );
  if (rows[0].structure_novel === false) {
    ok('a colliding structure flips it without being asked', 'another script shares the hash');
  } else {
    bad('a colliding structure flips it without being asked', String(rows[0].structure_novel));
  }
}

// The gate itself. This is the compliance control, so it gets tested rather than assumed.
{
  const { rows: reshootRow } = await client.query(
    `select id from reviews where render_id = $1 and decision = 'reshoot' limit 1`, [renderId],
  );
  const { rows: passRow } = await client.query(
    `select id from reviews where render_id = $1 and decision = 'pass' limit 1`, [renderId],
  );

  const blocked = await client
    .query(
      `insert into publications (render_id, channel_id, review_id, title, status)
       values ($1,$2,$3,'t','scheduled')`,
      [renderId, channelId, reshootRow[0].id],
    )
    .then(() => null)
    .catch((e) => e);

  if (blocked && /blocked/.test(blocked.message)) {
    ok('publishing on a reshoot review is refused by the database', blocked.message.split('\n')[0]);
  } else {
    bad('publishing on a reshoot review is refused by the database', blocked?.message ?? 'it was allowed');
  }

  const allowed = await client
    .query(
      `insert into publications (render_id, channel_id, review_id, title, status)
       values ($1,$2,$3,'t','scheduled')`,
      [renderId, channelId, passRow[0].id],
    )
    .then(() => true)
    .catch((e) => e.message);

  if (allowed === true) ok('publishing on a pass is allowed');
  else bad('publishing on a pass is allowed', String(allowed));
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Regenerate — the confirmation's content, and what it refuses
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n7. Regenerate\n');

{
  const shotId = shotIds[0];

  // Compiled first, because an uncompiled shot cannot be priced — there is no model to look
  // up — and the refusal would stop one gate earlier. That is correct behaviour and it is
  // not the behaviour under test here.
  await client.query(
    `insert into prompts (id, name, driver, model, template, params, tags, discovered_in)
     values ($1,'verify recipe','higgsfield','verify-model','{{description}}','{"motion":"push_in"}','{establishing}','manual')`,
    ['bbbbbbbb-0000-0000-0000-000000000001'],
  );
  await client.query(
    `update shots set prompt_id = $2, compiled_params = $3 where id = $1`,
    [shotId, 'bbbbbbbb-0000-0000-0000-000000000001', JSON.stringify({ model: 'verify-model', motion: 'push_in' })],
  );

  // On an untouched workspace this refuses twice over: the video integration has never
  // verified, and there is no verified credit rate. That is the dialog's whole job — no
  // rupee figure is shown, and nothing is queued.
  const refused = await estimateRegenerate(db, shotId, { usdInrRate: 88.5 });
  if (refused.ok) {
    bad('an unverified rate refuses the estimate', 'it produced a price');
  } else {
    const codes = refused.blockers.map((b) => b.code);
    ok('the estimate refuses on a fresh workspace', codes.join(', '));

    if (codes.includes('rate_unverified') || codes.includes('no_rate_card_entry')) {
      ok('  · and names the pricing as the reason', 'no rupee figure from an unverified rate');
    } else {
      bad('  · and names the pricing as the reason', codes.join(', '));
    }
  }

  const wouldWrite = await executeRegenerate(db, shotId, { usdInrRate: 88.5 });
  if (wouldWrite.ok) bad('executing is refused too', 'it queued a generation');
  else ok('executing is refused too, on the same gates', wouldWrite.blockers.map((b) => b.code).join(', '));

  const { rows: none } = await client.query(
    `select count(*)::int as n from generations where shot_id = $1 and status = 'queued'`, [shotId],
  );
  if (none[0].n === 0) ok('  · and nothing was queued');
  else bad('  · and nothing was queued', `${none[0].n} rows`);
}

// Now make it possible, and check the thing the dialog has to say out loud.
{
  const shotId = shotIds[0];

  await client.query(
    `update integrations set is_enabled = true, last_verified_at = now() where slug = 'higgsfield'`,
  );
  await client.query(
    `insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
     values ('higgsfield','verify-model',null,'credit',0.08,'USD',true,'observed credit delta in the harness','1970-01-01T00:00:00Z')`,
  );
  const estimate = await estimateRegenerate(db, shotId, { usdInrRate: 88.5 });
  if (!estimate.ok) {
    bad('a priced, verified shot estimates', estimate.blockers.map((b) => b.detail).join(' · '));
  } else {
    ok('a priced, verified shot estimates', `₹${estimate.costInr.toFixed(2)} for ${estimate.quantity} ${estimate.unit}`);

    if (Math.abs(estimate.costInr - 0.08 * 88.5) < 0.001) ok('  · the rupee figure is the rate times the rate');
    else bad('  · the rupee figure is the rate times the rate', String(estimate.costInr));

    // Asserted against the database rather than against an assumed baseline: this shot
    // already carries the synthetic set's generation, so "previous" is that one and the new
    // attempt is one past it. Hardcoding 1 here would have been an assertion about the
    // fixture, not about the code.
    const { rows: latest } = await client.query(
      `select idempotency_key, attempt from generations where shot_id = $1 order by attempt desc limit 1`,
      [shotId],
    );

    if (estimate.previousKey === latest[0].idempotency_key) {
      ok('  · it reports the shot\'s current key as previous', estimate.previousKey);
    } else {
      bad('  · it reports the shot\'s current key as previous', `${estimate.previousKey} vs ${latest[0].idempotency_key}`);
    }

    if (estimate.attempt === latest[0].attempt + 1) {
      ok('  · and the next attempt number', `${latest[0].attempt} → ${estimate.attempt}`);
    } else {
      bad('  · and the next attempt number', `${latest[0].attempt} → ${estimate.attempt}`);
    }

    const baseAttempt = estimate.attempt;

    const first = await executeRegenerate(db, shotId, { usdInrRate: 88.5 });
    if (first.ok) ok('the regeneration is queued', first.idempotencyKey);
    else bad('the regeneration is queued', first.blockers.map((b) => b.detail).join(' · '));

    // Rule 5, precisely: no money has moved, so no ledger row exists. The submit path
    // writes it at the moment the vendor is called.
    const { rows: ledger } = await client.query(
      `select count(*)::int as n from cost_ledger where generation_id = $1`, [first.generationId],
    );
    if (ledger[0].n === 0) {
      ok('  · and no cost row yet', 'a queued generation that is never submitted cost nothing');
    } else {
      bad('  · and no cost row yet', `${ledger[0].n} rows`);
    }

    // The claim the dialog makes: a second regenerate is a NEW key, therefore a new charge.
    const second = await estimateRegenerate(db, shotId, { usdInrRate: 88.5 });
    if (!second.ok) {
      bad('a second regenerate estimates', second.blockers.map((b) => b.code).join(', '));
    } else if (second.previousKey === first.idempotencyKey && second.newKey !== second.previousKey) {
      ok('a second regenerate mints a different key', `${second.previousKey} → ${second.newKey}`);
    } else {
      bad('a second regenerate mints a different key', `${second.previousKey} → ${second.newKey}`);
    }

    if (second.ok && second.attempt === baseAttempt + 1) {
      ok('  · and bumps the attempt', `${baseAttempt} → ${second.attempt}`);
    } else if (second.ok) {
      bad('  · and bumps the attempt', `${baseAttempt} → ${second.attempt}`);
    }

    // A retry of the SAME attempt must not create a second row. That is rule 6 holding
    // where regenerate deliberately does not.
    const replay = await executeRegenerateAtAttempt(shotId, first.idempotencyKey);
    if (replay === 'refused') ok('replaying the same key is refused by the unique constraint');
    else bad('replaying the same key is refused by the unique constraint', replay);
  }
}

async function executeRegenerateAtAttempt(shotId, key) {
  try {
    await client.query(
      `insert into generations (shot_id, kind, driver, model, request_payload, idempotency_key, status)
       values ($1,'image','higgsfield','verify-model','{}',$2,'queued')`,
      [shotId, key],
    );
    return 'it inserted a duplicate';
  } catch (err) {
    return /duplicate key|unique/i.test(err.message) ? 'refused' : err.message;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. The queue
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n8. The queue\n');

{
  const queue = await readQueue(db);
  if (!queue.ok) {
    bad('the queue reads', queue.detail);
  } else if (queue.rows.length === 1 && queue.rows[0].renderId === renderId) {
    ok('one render, with its current decision', `${queue.rows[0].conceptTitle} · ${queue.rows[0].decision}`);
  } else {
    bad('the queue reads', JSON.stringify(queue.rows));
  }

  // v_current_review must report the LATEST, not the first. A superseded reshoot showing as
  // current is how a passed video looks blocked forever.
  if (queue.ok && queue.rows[0]?.decision === 'pass') ok('the current decision is the latest one');
  else bad('the current decision is the latest one', queue.ok ? String(queue.rows[0]?.decision) : '');
}

await shutdown();

// ═══════════════════════════════════════════════════════════════════════════

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** Duration of the words covered by a character span. Mirrors stage 6's derivation. */
function spanDuration(words, voText, span) {
  const wordStartChar = [];
  let cursor = 0;
  for (const word of words) {
    while (cursor < voText.length && /\s/.test(voText[cursor])) cursor++;
    wordStartChar.push(cursor);
    cursor += word.w.length;
  }
  const first = wordStartChar.findIndex((c) => c >= span.start);
  const lastExclusive = wordStartChar.findIndex((c) => c >= span.end);
  const end = lastExclusive === -1 ? words.length : lastExclusive;
  const slice = words.slice(first, end);
  return round(slice[slice.length - 1].end - slice[0].start);
}

async function shutdown() {
  await scratch.release();
  await rm(work, { recursive: true, force: true });

  console.log(failures === 0 ? '\nReview screen checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}
