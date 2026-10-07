import { z } from 'zod';

import type { Db } from '../db/server';

/**
 * What each source said on a channel's latest trend run (trend_runs, 0049) — the reader /trends
 * uses so a refusing source is a sentence ("Reddit: refused 403 — needs an app") rather than
 * an absence. Separate from read.ts so a harness can drive it with a database handle.
 */

const SourceRow = z.object({ source: z.string(), ok: z.boolean(), count: z.number(), detail: z.string().optional() });

export interface TrendRunView {
  id: string;
  trigger: string;
  finishedAt: string;
  inserted: number;
  updated: number;
  sources: z.infer<typeof SourceRow>[];
}

export type LatestTrendRun =
  | { ok: true; run: TrendRunView | null }
  /** The table is not there (0049 not pasted) — said, not shown as "never ran". */
  | { ok: false; reason: string };

export async function latestTrendRun(db: Db, channelId: string): Promise<LatestTrendRun> {
  const { data, error } = await db
    .from('trend_runs')
    .select('id, trigger, finished_at, inserted, updated, sources')
    .eq('channel_id', channelId)
    .order('finished_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      reason: /trend_runs|does not exist|schema cache/i.test(error.message)
        ? 'Per-run source results need migration 0049 (paste docs/bureau/hosted-migrations-7-0049.sql). Until then a source that refuses leaves no trace here.'
        : `trend_runs could not be read: ${error.message}`,
    };
  }
  if (!data) return { ok: true, run: null };
  const sources = z.array(SourceRow).safeParse(data.sources);
  return {
    ok: true,
    run: {
      id: data.id,
      trigger: data.trigger,
      finishedAt: data.finished_at,
      inserted: data.inserted,
      updated: data.updated,
      sources: sources.success ? sources.data : [{ source: 'unknown', ok: false, count: 0, detail: 'the recorded source list did not parse' }],
    },
  };
}

/** A source's name as a person reads it. */
export const SOURCE_LABEL: Record<string, string> = { reddit: 'Reddit', youtube: 'YouTube', google_trends: 'Google Trends' };
