import 'server-only';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { fetchReddit, notImplemented, type RawSignal, type SourceResult } from './sources';

/**
 * Stage 1 — collect trend signals.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The only stage in this pipeline that costs nothing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No credential, no billing, no `cost_ledger` row — and that is worth saying out loud
 * because rule 5 is otherwise absolute, and a reader who finds a stage with no ledger write
 * should be able to tell "free" from "forgotten". These are public read-only feeds.
 *
 * ── Deduplication is on the term, per source, per day ────────────────────────
 *
 * Cron runs four times daily and the same post is hot all afternoon. Without dedup the
 * table fills with the same twenty-five titles six times over and stage 2's window shows
 * one subreddit's afternoon rather than a week's trends — which looks like the model having
 * poor judgement rather than the input being wrong.
 *
 * Kept as the *latest* reading rather than the first: velocity moves, and the newest
 * measurement is the one worth scoring against.
 */

export interface TrendRunPayload {
  /** Subreddits to read. Deliberately explicit — a niche is not a search query. */
  readonly subreddits?: readonly string[];
}

export interface TrendRunDeps {
  readonly db: Db;
  readonly baseUrl?: string;
  readonly now?: number;
  readonly log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export interface TrendRunResult {
  readonly ok: true;
  readonly inserted: number;
  readonly updated: number;
  readonly sources: { source: string; ok: boolean; count: number; detail?: string }[];
}

const noop = { info: () => {}, error: () => {} };

/** Signals shorter than this are not terms, they are noise. */
const MIN_TERM = 8;

export async function runTrends(
  payload: TrendRunPayload,
  deps: TrendRunDeps,
): Promise<TrendRunResult> {
  const { db } = deps;
  const log = deps.log ?? noop;
  const subreddits = payload.subreddits ?? [];

  const results: SourceResult[] = [];

  if (subreddits.length > 0) {
    results.push(await fetchReddit(subreddits, { baseUrl: deps.baseUrl, now: deps.now }));
  }

  // Named rather than omitted. See the note in sources.ts — a union that listed only the
  // implemented source would hide that the schema expects three.
  results.push(notImplemented('youtube', 'needs a Data API key, which is a setup step'));
  results.push(
    notImplemented('google_trends', 'no supported public endpoint; the unofficial one moves'),
  );

  let inserted = 0;
  let updated = 0;

  for (const result of results) {
    for (const signal of result.signals) {
      if (signal.term.trim().length < MIN_TERM) continue;

      // Read-then-write rather than an upsert, because every unique index on this table
      // would have to be partial or expression-based to express "per source, per term, per
      // day" — and `ON CONFLICT` cannot infer either. The same lesson as `cost_ledger`,
      // applied before it cost anything: the shape that works under every client is the one
      // that does not depend on inference.
      //
      // The race this leaves open is two cron runs in the same second writing the same
      // term twice. That is a duplicate row in a table of observations, which is noise
      // rather than a defect — unlike a duplicate charge, which is why the ledger gets the
      // stricter treatment.
      const { data: existing } = await db
        .from('trend_signals')
        .select('id')
        .eq('source', signal.source)
        .eq('term', signal.term)
        .gte('captured_at', startOfDay(deps.now ?? Date.now()))
        .limit(1)
        .maybeSingle();

      const row = {
        source: signal.source,
        term: signal.term,
        region: signal.region,
        velocity: signal.velocity,
        volume: signal.volume,
        raw: signal.raw as Json,
      };

      if (existing) {
        // The latest reading wins. Velocity moves through the day and the newest number is
        // the one stage 2 should score against.
        await db.from('trend_signals').update(row).eq('id', existing.id);
        updated++;
      } else {
        const { error } = await db.from('trend_signals').insert(row);
        if (error) {
          log.error('signal refused', { term: signal.term.slice(0, 60), error: error.message });
          continue;
        }
        inserted++;
      }
    }
  }

  const summary = results.map((r) => ({
    source: r.source,
    ok: r.ok,
    count: r.signals.length,
    ...(r.detail ? { detail: r.detail } : {}),
  }));

  log.info('trend intake', { inserted, updated, sources: summary });

  return { ok: true, inserted, updated, sources: summary };
}

/** ISO midnight UTC for the day containing `ms`. The dedup window. */
function startOfDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export type { RawSignal };
