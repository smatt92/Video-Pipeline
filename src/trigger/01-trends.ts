import { logger, queue, schedules, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { TrendsConfigSchema } from '@/lib/bureau/bible';
import { serverClient } from '@/lib/db/server';
import { youtubeApiKeyFromEnv } from '@/lib/drivers/trends-youtube';
import { runTrends, runTrendsForAllChannels, type TrendRunResult } from '@/lib/trends/run';

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
 * No `cost_ledger` write, deliberately: Reddit is a public feed and the YouTube Data API is
 * free within its daily quota — see the note in `run.ts`, where a reader auditing rule 5
 * will look. The YouTube key is resolved here from the environment and handed down; the
 * refusal when it is absent lives in the lib, where `verify:trends` reaches it.
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
const trendsQueue = queue({ name: '01-trends', concurrencyLimit: 1 });

function warnOnFailedSources(channel: string, result: TrendRunResult) {
  const failed = result.sources.filter((s) => !s.ok);
  if (failed.length > 0) {
    // Warned, not thrown. Google Trends is deliberately unimplemented and one feed being down
    // is not a failed run — but a silent partial collection is how stage 2 ends up scoring a
    // week-old picture of the world without anyone noticing.
    logger.warn('some sources returned nothing', { channel, failed });
  }
  if (result.channelColumnMissing) logger.warn(result.channelColumnMissing, { channel });
}

export const trendsTask = schedules.task({
  id: '01-trends',
  // 00:40, 06:40, 12:40 and 18:40 UTC = 06:10, 12:10, 18:10 and 00:10 IST. Written in UTC:
  // Trigger.dev's deploy rejected the zone name 'Asia/Kolkata' ("Invalid IANA timezone"),
  // and India has no daylight saving, so UTC+05:30 is exact all year. Minute 40 rather than
  // :00 so this does not queue behind every other job scheduled on the hour, and so the
  // 06:10 IST run has landed before 19-draft-briefs (06:45 IST) drafts against it.
  cron: '40 0,6,12,18 * * *',
  queue: trendsQueue,

  run: async () => {
    const outcomes = await runTrendsForAllChannels({ db: serverClient(), youtubeApiKey: youtubeApiKeyFromEnv(), log: logger });
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
    const result = await runTrends(
      { channelId: payload.channelId, subreddits: payload.subreddits, youtube: payload.youtube ?? null },
      { db: serverClient(), youtubeApiKey: youtubeApiKeyFromEnv(), log: logger },
    );
    warnOnFailedSources(payload.channelId, result);
    return result;
  },
});
