import { z } from 'zod';

import type { Db } from '../db/server';

/**
 * What each source said on a channel's latest trend run (trend_runs, 0049) — the reader /trends
 * uses so a refusing source is a sentence ("Reddit: refused 403 — needs an app") rather than
 * an absence. Separate from read.ts so a harness can drive it with a database handle.
 */

const PartFailure = z.object({ part: z.string(), kind: z.enum(['no_chart', 'error']), detail: z.string() });
const SourceRow = z.object({ source: z.string(), ok: z.boolean(), count: z.number(), detail: z.string().optional(), failures: z.array(PartFailure).optional() });
export type TrendRunSource = z.infer<typeof SourceRow>;

/**
 * The pill a source card shows. One function so the card, the harness and anything else that
 * says "partial" agree on what it means:
 *   not_configured — the source refused because this channel did not set it up (a choice or a
 *                    missing credential), said in `detail` beginning "not configured"
 *   failed         — the whole source failed (ok false)
 *   partial        — it landed signals and named at least one part that did not
 *   ok             — every part answered
 */
export type SourceStatus = 'ok' | 'partial' | 'not_configured' | 'failed';
export function sourceStatus(s: Pick<TrendRunSource, 'ok' | 'detail' | 'failures'>): SourceStatus {
  if (!s.ok) return /^not configured/i.test(s.detail ?? '') ? 'not_configured' : 'failed';
  return s.failures && s.failures.length > 0 ? 'partial' : 'ok';
}

const RelevanceNote = z.object({ scored: z.number(), unscored: z.number(), detail: z.string().nullable(), embedded: z.number(), nicheRebuilt: z.boolean() });
export type RunRelevance = z.infer<typeof RelevanceNote>;

export interface TrendRunView {
  id: string;
  trigger: string;
  finishedAt: string;
  inserted: number;
  updated: number;
  sources: z.infer<typeof SourceRow>[];
  /** What the relevance pass said (0051). Null = not recorded (before 0051, or a run before O5). */
  relevance: RunRelevance | null;
}

export type LatestTrendRun =
  | { ok: true; run: TrendRunView | null }
  /** The table is not there (0049 not pasted) — said, not shown as "never ran". */
  | { ok: false; reason: string };

export async function latestTrendRun(db: Db, channelId: string): Promise<LatestTrendRun> {
  const read = (cols: string) =>
    db.from('trend_runs').select(cols).eq('channel_id', channelId).order('finished_at', { ascending: false }).limit(1).maybeSingle() as unknown as Promise<{
      data: { id: string; trigger: string; finished_at: string; inserted: number; updated: number; sources: unknown; relevance?: unknown } | null;
      error: { message: string } | null;
    }>;
  let { data, error } = await read('id, trigger, finished_at, inserted, updated, sources, relevance');
  // trend_runs.relevance is 0051; a database without it still answers the rest.
  if (error && /relevance/.test(error.message)) ({ data, error } = await read('id, trigger, finished_at, inserted, updated, sources'));
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
      relevance: (() => {
        const r = RelevanceNote.safeParse(data.relevance);
        return r.success ? r.data : null;
      })(),
    },
  };
}

/** A source's name as a person reads it. */
export const SOURCE_LABEL: Record<string, string> = { reddit: 'Reddit', youtube: 'YouTube', google_trends: 'Google Trends', wikipedia: 'Wikipedia', hn: 'Hacker News' };
