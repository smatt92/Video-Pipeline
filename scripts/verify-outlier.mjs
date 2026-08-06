#!/usr/bin/env node
/**
 * Addendum 04's outlier score — the arithmetic, and the views that read its silence.
 *
 * PROVES:  a baseline is null rather than zero when a channel has too few videos, when no
 *          view count could be read, and when the median is genuinely 0; unreadable view
 *          counts are excluded from the median rather than counted as zero; the trim is
 *          skipped rather than applied down to an unusable sample; a score is null and
 *          never Infinity when there is no baseline to divide by; combinations pair across
 *          the ranking rather than adjacently; and a channel contributing nothing to the
 *          leaderboard is visible in the view that exists to say so.
 *
 * ── Where the assertions come from ───────────────────────────────────────────
 *
 * §0–§2 call the pure functions and assert their RETURN VALUES. Nothing there reads a row
 * this file wrote, which is the failure mode CLAUDE.md names: `seedChannel` writes
 * `baseline_median_views`, so asserting against that column would pass whatever
 * `computeBaseline` did — including nothing.
 *
 * §4 is the one that needs a database, and it is LOAD-BEARING for a different reason: the
 * leaderboard cannot show a channel it has excluded, so no assertion about
 * `v_outlier_leaders` can reveal a missing one. The count has to come from
 * `v_tracked_channel_health`, which is a different view over a different predicate.
 *
 * Usage: node scripts/verify-outlier.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-outlier.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const {
  computeBaseline, outlierScore, combinations, isRecent,
  MIN_VIDEOS_FOR_BASELINE,
} = require(`${BUILD}/trends/outlier.js`);
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => { console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const eq = (l, actual, expected) =>
  actual === expected ? ok(l, String(actual)) : bad(l, `expected ${expected}, got ${actual}`);
const isNull = (l, v) => (v === null ? ok(l, 'null') : bad(l, `expected null, got ${JSON.stringify(v)}`));

const scratch = await scratchDatabase(dbUrl, 'outlier');
const client = scratch.client;
const q = (sql, params = []) => client.query(sql, params);

const tens = (v) => Array.from({ length: 12 }, () => v);

console.log('\nOutlier score\n');

// ═══════════════════════════════════════════════════════════════════════════════
console.log('0. A baseline is refused rather than invented\n');
{
  const few = computeBaseline([100, 200, 300]);
  eq('three videos is not a baseline', few.ok, false);
  eq('  · and the reason is the count', few.reason, 'too_few_videos');
  eq('  · which is exactly the documented minimum', MIN_VIDEOS_FOR_BASELINE, 10);

  // The assertion that matters most. Unreadable views are EXCLUDED, not zeroed: counting
  // them as 0 drags the median down and inflates every score on the channel.
  const withNulls = computeBaseline([...tens(1000), null, null, null]);
  eq('unreadable view counts do not become zeros', withNulls.ok, true);
  eq('  · so the median is the real one', withNulls.medianViews, 1000);
  // And the sample size tells a ten-video channel apart from a fourteen-video channel
  // where four reads failed — the same number with opposite meanings.
  eq('  · and the contributing count is reported', withNulls.sampleSize, 10);

  const allNull = computeBaseline([null, null, null]);
  eq('a channel whose views could not be read has no baseline', allNull.ok, false);
  eq('  · and it is NOT reported as too few videos', allNull.reason, 'no_readable_views');

  // Zero is a real reading and a fatal divisor. Its own reason, because a baseline of 0
  // would make every score infinite and pin a dead channel to the top of the ideas list.
  const zero = computeBaseline(tens(0));
  eq('a channel nobody watches has no baseline either', zero.ok, false);
  eq('  · reported apart from the others', zero.reason, 'baseline_is_zero');
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n1. The trim, and when it must not happen\n');
{
  // Exactly ten: trimming leaves eight, which is below the minimum the trim exists to make
  // meaningful. Skipped rather than refused, and the return value says which.
  const ten = computeBaseline([1, 2, 3, 4, 5, 6, 7, 8, 9, 1000]);
  eq('ten videos still produce a baseline', ten.ok, true);
  eq('  · with no trim, because trimming would leave eight', ten.trimmed, 0);
  // Median of 1..9,1000 is 5.5 — the outlier sits in the sample and the median absorbs it,
  // which is the whole reason this is a median rather than a mean.
  eq('  · and the median absorbs the outlier anyway', ten.medianViews, 5.5);

  // Twelve: trimming leaves ten, which clears the bar, so it happens.
  const twelve = computeBaseline([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99999]);
  eq('twelve videos are trimmed', twelve.trimmed, 2);
  eq('  · leaving exactly the minimum', twelve.sampleSize, 10);
  // 1..10 after trimming 0 and 99999 → median 5.5.
  eq('  · and the extreme is gone', twelve.medianViews, 5.5);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n2. A score is null, never Infinity, never 0-by-accident\n');
{
  eq('the ordinary case is a ratio', outlierScore(66000, 1000), 66);
  eq('  · rounded, not truncated', outlierScore(1500, 1000), 1.5);

  isNull('no baseline means no score', outlierScore(5000, null));
  isNull('no views means no score', outlierScore(null, 1000));
  // The one that would otherwise be Infinity and sort first for ever.
  isNull('a zero baseline means no score, not an infinite one', outlierScore(5000, 0));
  isNull('  · and a negative baseline is refused too', outlierScore(5000, -1));

  // Zero views IS a finding — the video was published and watched by nobody — so it is a
  // score of 0 rather than a null. This is the distinction the whole module is built on,
  // asserted in the direction that is easy to get backwards.
  eq('but zero views IS a score, because it is a real reading', outlierScore(0, 1000), 0);

  eq('a video from last week is recent', isRecent(new Date(Date.now() - 7 * 864e5).toISOString()), true);
  eq('one from two years ago is not', isRecent(new Date(Date.now() - 730 * 864e5).toISOString()), false);
  eq('an unparseable date is not recent', isRecent('not a date'), false);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n3. Combinations pair across the ranking, not along it\n');
{
  const ranked = ['A', 'B', 'C', 'D', 'E', 'F'];
  const pairs = combinations(ranked);
  eq('three pairs from six titles', pairs.length, 3);
  // Adjacent pairing would give A×B — two videos that both beat their channels in the same
  // week about the same trend, which produces the near-duplicate combination this exists
  // to avoid. Across the list maximises the distance between halves.
  eq('the best is paired with the worst of the set', `${pairs[0].a}×${pairs[0].b}`, 'A×F');
  eq('  · and the second with the second-last', `${pairs[1].a}×${pairs[1].b}`, 'B×E');
  if (pairs.every((p) => p.a !== p.b)) ok('  · and nothing is paired with itself');
  else bad('  · and nothing is paired with itself');

  eq('an odd count leaves the middle unpaired rather than duplicated',
     combinations(['A', 'B', 'C']).length, 1);
  eq('and the limit is honoured', combinations(ranked, 1).length, 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n4. LOAD-BEARING — the leaderboard cannot report what it excludes\n');
// Why load-bearing: v_outlier_leaders shows scored, recent videos on active channels. A
// channel with no baseline contributes NO rows, so nothing in that result set can reveal
// it — the leaderboard reads as complete however many are missing. The count therefore has
// to come from v_tracked_channel_health, a different view over a different predicate.
{
  const scored = randomUUID();
  const noBaseline = randomUUID();
  const neverPolled = randomUUID();

  await q(`insert into tracked_channels (id, external_channel_id, title, niche,
             uploads_playlist_id, baseline_median_views, baseline_video_count, baseline_computed_at, last_polled_at)
           values ($1,'UC_scored','Scored','test','UU_scored',1000,20,now(),now())`, [scored]);
  await q(`insert into tracked_channels (id, external_channel_id, title, niche,
             uploads_playlist_id, baseline_video_count, last_polled_at)
           values ($1,'UC_thin','Too thin','test','UU_thin',4,now())`, [noBaseline]);
  await q(`insert into tracked_channels (id, external_channel_id, title, niche, uploads_playlist_id)
           values ($1,'UC_new','Never polled','test','UU_new')`, [neverPolled]);

  await q(`insert into competitor_videos (tracked_channel_id, external_video_id, title,
             published_at, views, outlier_score, scored_against_views, computed_at)
           values ($1,'v_hot','A hot one', now() - interval '3 days', 66000, 66, 1000, now())`, [scored]);
  // Recent, on a scored channel, but itself unscored — must not appear as a zero.
  await q(`insert into competitor_videos (tracked_channel_id, external_video_id, title,
             published_at, views)
           values ($1,'v_unscored','Not scored yet', now() - interval '2 days', 900)`, [scored]);
  // Scored, but old. Addendum 04's 90-day rule.
  await q(`insert into competitor_videos (tracked_channel_id, external_video_id, title,
             published_at, views, outlier_score, scored_against_views, computed_at)
           values ($1,'v_old','An old winner', now() - interval '200 days', 90000, 90, 1000, now())`, [scored]);

  const { rows: leaders } = await q(`select external_video_id, outlier_score from v_outlier_leaders`);
  eq('one video leads', leaders.length, 1);
  eq('  · the recent scored one', leaders[0].external_video_id, 'v_hot');
  eq('  · at its real multiple', Number(leaders[0].outlier_score), 66);

  const { rows: health } = await q(
    `select title, blocker, videos_known, videos_scored from v_tracked_channel_health order by title`);
  eq('every tracked channel appears in the health view', health.length, 3);
  const by = Object.fromEntries(health.map((h) => [h.title, h.blocker]));
  // The three channels the leaderboard is silent about, each with a distinct reason.
  eq('a channel with too few videos says so', by['Too thin'], 'too_few_videos_for_a_baseline');
  eq('a channel never polled says that instead', by['Never polled'], 'never_polled');
  isNull('and the contributing one is not blocked', by.Scored);

  const scoredRow = health.find((h) => h.title === 'Scored');
  // Three videos known, one scored-and-recent. Both numbers, because "3 known" alone
  // hides that two contribute nothing and "1 scored" alone hides that we have three.
  eq('the health view counts what is known', Number(scoredRow.videos_known), 3);
  eq('  · apart from what is scored', Number(scoredRow.videos_scored), 2);

  // The whole point, stated as an assertion: the leaderboard is smaller than the corpus and
  // only a second view can say by how much.
  if (leaders.length < Number(scoredRow.videos_known)) {
    ok('the leaderboard is a subset, and the health view is what measures the gap');
  } else {
    bad('the leaderboard is a subset, and the health view is what measures the gap');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n5. pacing_template holds no sentences, and the guard fires\n');
{
  // Driving the guard's refusing branch here as well as in `check:pacing-columns` itself,
  // because a guard whose accepting branch is the only one anybody exercises passes on an
  // empty schema whatever the refusal does.
  const { execSync } = await import('node:child_process');
  const run = (cmd) => {
    try { execSync(cmd, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; }
  };
  eq('the schema as shipped passes',
     run(`node scripts/check-pacing-columns.mjs "${scratch.url}"`), 0);

  await q(`alter table pacing_template add column source_excerpt text`);
  eq('  · and a free text column fails the build',
     run(`node scripts/check-pacing-columns.mjs "${scratch.url}"`), 1);
  await q(`alter table pacing_template drop column source_excerpt`);

  await q(`alter table pacing_template add column raw jsonb`);
  eq('  · jsonb too, which is the shape somebody reaches for instead',
     run(`node scripts/check-pacing-columns.mjs "${scratch.url}"`), 1);
  await q(`alter table pacing_template drop column raw`);

  // And the accepting branch is not merely "no text at all" — a closed vocabulary passes,
  // which is what makes the guard usable rather than something people work around.
  await q(`alter table pacing_template add column tone text check (tone in ('calm','urgent'))`);
  eq('  · while a CHECK-constrained vocabulary passes',
     run(`node scripts/check-pacing-columns.mjs "${scratch.url}"`), 0);
  await q(`alter table pacing_template drop column tone`);
}

// ═══════════════════════════════════════════════════════════════════════════════
await scratch.release();

console.log(`\n${failures === 0 ? 'Outliers are measured, and what cannot be measured says so.' : `${failures} failure(s).`}\n`);
process.exit(failures === 0 ? 0 : 1);
