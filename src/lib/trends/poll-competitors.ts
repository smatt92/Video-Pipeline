import type { Db } from '../db/server';
import { spend, settle } from '../publish/quota';
import { listUploads, listVideoStats } from '../publish/youtube';

import {
  BASELINE_SAMPLE,
  computeBaseline,
  isRecent,
  outlierScore,
  type Baseline,
} from './outlier';

/**
 * Stage 1b — competitor signal intake. Addendum 04 §1 and §5.
 *
 * A letter rather than a number, like `05b-ingest`: this is part of stage 1's trend intake,
 * not a stage of its own. Addendum 04 §5 is explicit that competitor channels do not
 * replace the other trend sources — they *outrank* them, because they measure what works on
 * the platform rather than what people search for.
 *
 * ── Two calls per channel, and the arithmetic that makes that matter ─────────
 *
 * `playlistItems.list` (1 unit) then `videos.list` (1 unit for up to 50 ids). Twenty
 * channels is 40 units a day out of 10,000, against 2,000 if the same work went through
 * `search.list`. The quota is shared with uploads at 1,600 each, so the difference is
 * roughly "one upload's worth of headroom" versus "most of the day".
 *
 * Every call goes through `spend()` before it is made — the mechanism stage 10 built, and
 * it already knows both prices. A poller that counted its own units separately would be a
 * second ledger for one quota.
 *
 * ── The refusals are here, so a harness can reach them ───────────────────────
 *
 * `pollChannel` takes a deps object and returns a result; the Trigger task resolves the API
 * key and hands it down. Nothing here throws, because the caller loops over channels and one
 * dead channel must not stop the others — a throw inside a loop is exactly how that happens.
 */

export interface PollDeps {
  db: Db;
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface PollOutcome {
  trackedChannelId: string;
  ok: boolean;
  code?: string;
  detail?: string;
  videosSeen: number;
  videosScored: number;
  unitsSpent: number;
  /** What the baseline came out as, including the reasons it could not be computed. */
  baseline: Baseline | null;
  signalsWritten: number;
}

const SLUG = 'youtube';

/**
 * Poll one channel: read its uploads, price them, rescore, and emit trend signals.
 *
 * ── Order matters, and it is the reverse of the obvious one ──────────────────
 *
 * The baseline is recomputed from the *whole* sample before any single video is scored,
 * rather than each video being scored as it arrives. Scoring as you go would measure early
 * videos against a baseline built from fewer of them, so the same video would get a
 * different score depending on where in the page it appeared — and the score would drift
 * every poll without anything changing on the channel.
 */
export async function pollChannel(
  channel: { id: string; uploadsPlaylistId: string | null; title: string },
  deps: PollDeps,
): Promise<PollOutcome> {
  const { db, apiKey } = deps;
  const now = deps.now ?? (() => new Date());
  const base: PollOutcome = {
    trackedChannelId: channel.id,
    ok: false,
    videosSeen: 0,
    videosScored: 0,
    unitsSpent: 0,
    baseline: null,
    signalsWritten: 0,
  };

  if (!channel.uploadsPlaylistId) {
    // Refused rather than resolved on the fly. Looking the playlist up here would work and
    // would be the moment somebody later replaces it with a search call; the column exists
    // so the cheap path is the only one. See migration 0036.
    await recordFailure(db, channel.id, 'no_uploads_playlist',
      'This channel has no uploads_playlist_id, so there is no 1-unit path to its videos.');
    return { ...base, code: 'no_uploads_playlist', detail: 'no uploads playlist id' };
  }

  // ── 1. The uploads list ────────────────────────────────────────────────────
  const listSpend = await spend(db, SLUG, 'playlistItems.list', {
    detail: `uploads for "${channel.title}"`,
  });
  if (!listSpend.ok) {
    await recordFailure(db, channel.id, listSpend.code, listSpend.detail);
    return { ...base, code: listSpend.code, detail: listSpend.detail };
  }

  const uploads = await listUploads(
    apiKey, channel.uploadsPlaylistId, BASELINE_SAMPLE, deps.fetchImpl,
  );
  await settle(db, listSpend.usageId, uploads.ok, uploads.ok ? undefined : uploads.detail);

  if (!uploads.ok) {
    if (uploads.quotaExceeded) await observeCeiling(db, uploads.detail);
    await recordFailure(db, channel.id, uploads.code, uploads.detail);
    return { ...base, code: uploads.code, detail: uploads.detail, unitsSpent: 1 };
  }

  // ── 2. The view counts ─────────────────────────────────────────────────────
  const ids = uploads.items.map((i) => i.videoId);
  const statsSpend = await spend(db, SLUG, 'videos.list', {
    detail: `${ids.length} video stats for "${channel.title}"`,
  });
  if (!statsSpend.ok) {
    await recordFailure(db, channel.id, statsSpend.code, statsSpend.detail);
    return { ...base, code: statsSpend.code, detail: statsSpend.detail, unitsSpent: 1 };
  }

  const stats = await listVideoStats(apiKey, ids, deps.fetchImpl);
  await settle(db, statsSpend.usageId, stats.ok, stats.ok ? undefined : stats.detail);

  if (!stats.ok) {
    if (stats.quotaExceeded) await observeCeiling(db, stats.detail);
    await recordFailure(db, channel.id, stats.code, stats.detail);
    return { ...base, code: stats.code, detail: stats.detail, unitsSpent: 2 };
  }

  // ── 3. The baseline, over the whole sample, before anything is scored ──────
  const baseline = computeBaseline(uploads.items.map((i) => stats.views.get(i.videoId) ?? null));

  await db
    .from('tracked_channels')
    .update({
      baseline_median_views: baseline.ok ? baseline.medianViews : null,
      baseline_video_count: baseline.ok ? baseline.sampleSize : baseline.sampleSize,
      baseline_computed_at: now().toISOString(),
      last_polled_at: now().toISOString(),
      last_error: null,
      poll_failures: 0,
    })
    .eq('id', channel.id);

  // ── 4. The videos, upserted, then scored ───────────────────────────────────
  let scored = 0;
  let signals = 0;
  const baselineViews = baseline.ok ? baseline.medianViews : null;

  for (const item of uploads.items) {
    const views = stats.views.get(item.videoId) ?? null;
    const score = outlierScore(views, baselineViews);

    const { data: existing } = await db
      .from('competitor_videos')
      .select('id')
      .eq('external_video_id', item.videoId)
      .maybeSingle();

    const row = {
      tracked_channel_id: channel.id,
      external_video_id: item.videoId,
      title: item.title,
      published_at: item.publishedAt,
      views,
      outlier_score: score,
      // Snapshotted with the score. A bare multiple is uninterpretable later — the
      // channel's baseline moves under it, and 50× a thousand is a different finding from
      // 50× a hundred thousand.
      scored_against_views: score === null ? null : baselineViews,
      computed_at: score === null ? null : now().toISOString(),
      last_seen_at: now().toISOString(),
    };

    if (existing) {
      await db.from('competitor_videos').update(row).eq('id', existing.id);
    } else {
      await db.from('competitor_videos').insert(row);
    }
    if (score !== null) scored += 1;

    // ── 5. A trend signal, but only for a recent video that actually beat its channel ──
    //
    // Both filters matter and neither is cosmetic. Writing a signal for every upload would
    // make `trend_signals` a mirror of `competitor_videos` with a different primary key —
    // two tables for one fact — and the concept prompt would read a list where being
    // present means nothing. A signal is written when the video says something.
    if (score !== null && score > 1 && isRecent(item.publishedAt, now())) {
      await db.from('trend_signals').insert({
        source: 'outlier',
        term: item.title,
        // The score IS the velocity here, and it is a better one than the feed sources
        // give: those estimate how fast interest is rising, this measures how far a video
        // beat a known baseline. Addendum 04 §5 — it outranks them for that reason.
        velocity: score,
        volume: views,
        raw: {
          external_video_id: item.videoId,
          tracked_channel_id: channel.id,
          published_at: item.publishedAt,
          scored_against_views: baselineViews,
        },
      });
      signals += 1;
    }
  }

  return {
    trackedChannelId: channel.id,
    ok: true,
    videosSeen: uploads.items.length,
    videosScored: scored,
    unitsSpent: 2,
    baseline,
    signalsWritten: signals,
  };
}

/**
 * A failed poll is a row, not a silence.
 *
 * Consecutive rather than cumulative, for the same reason as the publish credential: a
 * running total says "this channel has failed nine times", which is true and useless; the
 * consecutive count says "this channel is broken now", which is what a screen is asking.
 */
async function recordFailure(db: Db, channelId: string, code: string, detail: string) {
  const { data } = await db
    .from('tracked_channels')
    .select('poll_failures')
    .eq('id', channelId)
    .maybeSingle();
  await db
    .from('tracked_channels')
    .update({
      last_error: `${code}: ${detail}`.slice(0, 500),
      poll_failures: Number(data?.poll_failures ?? 0) + 1,
    })
    .eq('id', channelId);
}

/**
 * A 403 quotaExceeded is the only evidence that will ever exist for the real ceiling.
 *
 * Shared with the publish path deliberately: one refusal from one endpoint tells you the
 * account's ceiling, not that endpoint's, so recording it per-caller would leave the
 * publish screen still calling the number documented after the poller had observed it.
 */
async function observeCeiling(db: Db, detail: string) {
  await db
    .from('integrations')
    .update({ quota_source: 'observed', last_error: detail.slice(0, 500) })
    .eq('slug', SLUG);
}
