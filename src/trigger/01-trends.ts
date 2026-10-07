import { logger, queue, schedules, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { TrendsConfigSchema } from '@/lib/bureau/bible';
import { ledgeredEmbedder } from '@/lib/bureau/embed';
import { readUsdInrRate } from '@/lib/cost/fx';
import { serverClient, type Db } from '@/lib/db/server';
import { redditCredentialsFromEnv } from '@/lib/drivers/trends-reddit';
import { youtubeApiKeyFromEnv } from '@/lib/drivers/trends-youtube';
import { runTrends, runTrendsForAllChannels, type TrendRunResult } from '@/lib/trends/run';
import { TRENDS_CRON } from '@/lib/trends/schedule';

/**
 * Stage 1 — collect trend signals. Two tasks, one lib function (`src/lib/trends/run.ts`).
 *
 * ── Callers ──────────────────────────────────────────────────────────────────
 *
 *   `01-trends`      — the Trigger schedule below (deployed with the worker), four times a
 *                      day per ARCHITECTURE §4. Every active channel with a bible, each from
 *                      its own `channels/<slug>/trends.json`, each writing its own channel_id.
 *   `01-trends-now`  — the Run now button on /trends → `runTrendsNowAction` → `startTrendsRun`,
 *                      for the active channel only.
 *
 * ── No charge, and one credential ────────────────────────────────────────────
 *
 * Collection writes no `cost_ledger` row: Reddit's and YouTube's Data APIs are free within
 * their quotas and the Google Trends feed needs nothing — see the note in `run.ts`, where a
 * reader auditing rule 5 will look. The relevance pass (0051) is the exception: embedding new
 * terms goes through `ledgeredEmbedder`, which writes its estimate row before each call, as
 * every embedding does (0015). The YouTube key and the Reddit app credentials are
 * resolved here from the environment and handed down; "not configured" is decided in the
 * lib, where `verify:trends` reaches it.
 *
 * ── Concurrency 1, and not for the usual reason ──────────────────────────────
 *
 * Every other stage limits concurrency to protect a paid account from a fan-out. This one
 * limits it because two simultaneous runs would race the read-then-write dedup and write
 * the same term twice. Both tasks share one queue, so a Run now that lands during the
 * scheduled run waits for it rather than racing it.
 */

// One named queue, declared once with `queue()` and referenced by both tasks, so the limit of
// one is shared between the schedule and Run now rather than being one each.
/**
 * The relevance embedder for a run (0051): the same ledgered embedder as the variation check —
 * a verified key, a rate-card row, one estimate row per call written before it. A missing
 * USD→INR rate or an unverified key is its refusal, and every signal keeps relevance NULL with
 * that reason on the run (relevance.ts); collection itself never depends on it.
 */
async function embedderFor(db: Db) {
  const fx = await readUsdInrRate(db);
  const rate = fx.ok ? fx.rate : null;
  return (channelId: string) => ledgeredEmbedder(db, channelId, rate, '01-relevance');
}

const trendsQueue = queue({ name: '01-trends', concurrencyLimit: 1 });

function warnOnFailedSources(channel: string, result: TrendRunResult) {
  const failed = result.sources.filter((s) => !s.ok);
  if (failed.length > 0) {
    // Warned, not thrown. One feed being down or not configured
    // is not a failed run — but a silent partial collection is how stage 2 ends up scoring a
    // week-old picture of the world without anyone noticing.
    logger.warn('some sources returned nothing', { channel, failed });
  }
  if (result.channelColumnMissing) logger.warn(result.channelColumnMissing, { channel });
  if (result.runLogMissing) logger.warn(result.runLogMissing, { channel });
}

export const trendsTask = schedules.task({
  id: '01-trends',
  // TRENDS_CRON: 00:40, 06:40, 12:40, 18:40 UTC (06:10 … 00:10 IST) — src/lib/trends/schedule.ts,
  // shared with /trends so "next collection" is computed from the same definition.
  cron: TRENDS_CRON,
  queue: trendsQueue,

  run: async () => {
    const db = serverClient();
    const outcomes = await runTrendsForAllChannels({
      db,
      embedFor: await embedderFor(db),
      youtubeApiKey: youtubeApiKeyFromEnv(),
      redditCredentials: redditCredentialsFromEnv(),
      runKind: 'schedule',
      log: logger,
    });
    for (const o of outcomes) {
      if (o.ran) warnOnFailedSources(o.channel, o.result);
      else logger.warn('channel skipped', { channel: o.channel, why: o.skipped });
    }
    return outcomes;
  },
});

const NowPayload = TrendsConfigSchema.extend({ channelId: z.uuid() });

export const trendsNowTask = schemaTask({
  id: '01-trends-now',
  schema: NowPayload,
  queue: trendsQueue,

  run: async (payload): Promise<TrendRunResult> => {
    const db = serverClient();
    const result = await runTrends(
      {
        channelId: payload.channelId,
        subreddits: payload.subreddits,
        youtube: payload.youtube ?? null,
        ...(payload.google_trends !== undefined ? { googleTrends: payload.google_trends } : {}),
        ...(payload.wikipedia !== undefined ? { wikipedia: payload.wikipedia } : {}),
        ...(payload.hn !== undefined ? { hn: payload.hn } : {}),
      },
      { db, embedFor: await embedderFor(db), youtubeApiKey: youtubeApiKeyFromEnv(), redditCredentials: redditCredentialsFromEnv(), runKind: 'now', log: logger },
    );
    warnOnFailedSources(payload.channelId, result);
    return result;
  },
});
