import 'server-only';

import { bibleForSlug, type TrendsConfig } from '../bureau/bible';
import { listChannels } from '../channels/list';
import type { Db } from '../db/server';
import type { Json, TablesInsert } from '../db/types';
import type { YoutubeTrendConfig } from '../drivers/trends-youtube';
import {
  fetchReddit,
  fetchYoutube,
  GOOGLE_TRENDS_UNAVAILABLE,
  notImplemented,
  type RawSignal,
  type SourceResult,
} from './sources';
import { isChannelColumnMissing } from './recent';

/**
 * Stage 1 — collect trend signals.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The only stage in this pipeline that costs nothing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No billing and no `cost_ledger` row — and that is worth saying out loud because rule 5 is
 * otherwise absolute, and a reader who finds a stage with no ledger write should be able to
 * tell "free" from "forgotten". Reddit is a public read-only feed; YouTube's Data API needs
 * a key (`YOUTUBE_DATA_API_KEY`) and is free within its daily quota — it spends quota units,
 * not money, and running out is reported by name (see `src/lib/drivers/trends-youtube.ts`).
 *
 * ── Per channel (0046) ───────────────────────────────────────────────────────
 *
 * Each run is for one channel and writes `channel_id`; its sources come from that channel's
 * `channels/<slug>/trends.json`. Dedup is per channel too — two channels watching the same
 * subreddit each keep their own observation.
 *
 * ── Deduplication is on the term, per channel, per source, per day ──────────
 *
 * The schedule runs four times daily and the same post is hot all afternoon. Without dedup the
 * table fills with the same twenty-five titles six times over and stage 2's window shows
 * one subreddit's afternoon rather than a week's trends — which looks like the model having
 * poor judgement rather than the input being wrong.
 *
 * Kept as the *latest* reading rather than the first: velocity moves, and the newest
 * measurement is the one worth scoring against.
 */

export interface TrendRunPayload {
  /**
   * The channel these signals are for, written to `trend_signals.channel_id` (0046). Null
   * only for a caller that genuinely means workspace-wide — every caller in `src/` passes
   * one; the scheduled run and Run now both act per channel.
   */
  readonly channelId: string | null;
  /** Subreddits to read. From the channel's `trends.json`, never a default. */
  readonly subreddits?: readonly string[];
  /** The channel's YouTube block from `trends.json`. Null/absent = not configured. */
  readonly youtube?: YoutubeTrendConfig | null;
}

export interface TrendRunDeps {
  readonly db: Db;
  /** Reddit's base URL; a harness points it at a stub. */
  readonly baseUrl?: string;
  /**
   * Required: the task resolves it with `youtubeApiKeyFromEnv()` and passes it down, so the
   * refusal for a missing key lives here, in a function a harness can reach.
   */
  readonly youtubeApiKey: string | null;
  /** The Data API's base URL; a harness points it at a stub. */
  readonly youtubeBaseUrl?: string;
  readonly now?: number;
  readonly log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export interface TrendRunResult {
  readonly ok: true;
  readonly channelId: string | null;
  readonly inserted: number;
  readonly updated: number;
  readonly sources: { source: string; ok: boolean; count: number; detail?: string }[];
  /**
   * Present only when the rows could NOT carry their channel: `trend_signals.channel_id` is
   * missing because migration 0046 has not been applied to this database, so the rows were
   * written workspace-wide. Said in the result rather than swallowed.
   */
  readonly channelColumnMissing?: string;
}

const noop = { info: () => {}, error: () => {} };

/** Signals shorter than this are not terms, they are noise. */
const MIN_TERM = 8;

const COLUMN_MISSING =
  'trend_signals.channel_id does not exist on this database (migration 0046 not applied) — ' +
  'these signals were written without a channel. Apply 0046 and the next run writes them per channel.';

export async function runTrends(
  payload: TrendRunPayload,
  deps: TrendRunDeps,
): Promise<TrendRunResult> {
  const { db } = deps;
  const log = deps.log ?? noop;
  const subreddits = payload.subreddits ?? [];
  const channelId = payload.channelId;

  const results: SourceResult[] = [];

  if (subreddits.length > 0) {
    results.push(await fetchReddit(subreddits, { baseUrl: deps.baseUrl, now: deps.now }));
  }

  const yt = payload.youtube;
  if (yt && yt.category_ids.length === 0 && yt.queries.length === 0) {
    // A block with nothing in it asks for nothing, so a missing key refuses nothing either.
    results.push({ source: 'youtube', ok: false, signals: [], detail: 'not configured: this channel’s youtube block lists no category_ids and no queries' });
  } else if (payload.youtube) {
    results.push(
      await fetchYoutube(payload.youtube, { apiKey: deps.youtubeApiKey, baseUrl: deps.youtubeBaseUrl, now: deps.now }),
    );
  } else {
    // A channel that lists no YouTube block chose not to. Reported, not omitted, so the
    // summary always names all three sources.
    results.push({ source: 'youtube', ok: false, signals: [], detail: 'not configured: this channel’s trends.json has no youtube block' });
  }

  // Named rather than omitted. See the note in sources.ts.
  results.push(notImplemented('google_trends', GOOGLE_TRENDS_UNAVAILABLE));

  let inserted = 0;
  let updated = 0;
  // Flipped the first time the database says the column is not there; from then on this run
  // writes without it. Hosted may not have 0046 yet — the bundle is pasted by hand.
  let channelColumn = true;

  const findExisting = async (signal: RawSignal) => {
    const q = () =>
      db
        .from('trend_signals')
        .select('id')
        .eq('source', signal.source)
        .eq('term', signal.term)
        .gte('captured_at', startOfDay(deps.now ?? Date.now()));
    if (channelColumn) {
      const scoped = q();
      const r = await (channelId === null ? scoped.is('channel_id', null) : scoped.eq('channel_id', channelId))
        .limit(1)
        .maybeSingle();
      if (!r.error) return r.data;
      if (!isChannelColumnMissing(r.error.message)) throw new Error(`Reading trend_signals: ${r.error.message}`);
      channelColumn = false;
    }
    const r = await q().limit(1).maybeSingle();
    if (r.error) throw new Error(`Reading trend_signals: ${r.error.message}`);
    return r.data;
  };

  for (const result of results) {
    for (const signal of result.signals) {
      if (signal.term.trim().length < MIN_TERM) continue;

      // Read-then-write rather than an upsert, because every unique index on this table
      // would have to be partial or expression-based to express "per channel, per source,
      // per term, per day" — and `ON CONFLICT` cannot infer either. The same lesson as
      // `cost_ledger`, applied before it cost anything.
      //
      // The race this leaves open is two runs in the same second writing the same term
      // twice. That is a duplicate row in a table of observations, which is noise rather
      // than a defect — unlike a duplicate charge. Concurrency 1 on the task closes it.
      const existing = await findExisting(signal);

      const base = {
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
        await db.from('trend_signals').update(base).eq('id', existing.id);
        updated++;
        continue;
      }

      const row: TablesInsert<'trend_signals'> = channelColumn ? { ...base, channel_id: channelId } : base;
      let { error } = await db.from('trend_signals').insert(row);
      if (error && channelColumn && isChannelColumnMissing(error.message)) {
        channelColumn = false;
        ({ error } = await db.from('trend_signals').insert(base));
      }
      if (error) {
        log.error('signal refused', { term: signal.term.slice(0, 60), error: error.message });
        continue;
      }
      inserted++;
    }
  }

  const summary = results.map((r) => ({
    source: r.source,
    ok: r.ok,
    count: r.signals.length,
    ...(r.detail ? { detail: r.detail } : {}),
  }));

  log.info('trend intake', { channelId, inserted, updated, sources: summary, channelColumn });

  return {
    ok: true,
    channelId,
    inserted,
    updated,
    sources: summary,
    ...(channelColumn ? {} : { channelColumnMissing: COLUMN_MISSING }),
  };
}

/** The payload for one channel, from its bible's `trends.json`. Run now and the cron share it. */
export function trendsPayloadFor(channelId: string, trends: TrendsConfig): TrendRunPayload & { channelId: string } {
  return { channelId, subreddits: [...trends.subreddits], youtube: trends.youtube ?? null };
}

export type ChannelTrendOutcome =
  | { channel: string; channelId: string; ran: true; result: TrendRunResult }
  | { channel: string; channelId: string; ran: false; skipped: string };

/**
 * The scheduled run: every active channel with a bible in this build, each from its own
 * `trends.json`, each writing rows under its own channel id. A channel without a bible is
 * skipped by name — it has no sources configured, and a default would be this file deciding
 * what the channel is about. One channel's failure does not stop the next.
 */
export async function runTrendsForAllChannels(
  deps: TrendRunDeps,
  bibleFor: (slug: string) => { trends: TrendsConfig } = bibleForSlug,
): Promise<ChannelTrendOutcome[]> {
  const out: ChannelTrendOutcome[] = [];
  for (const ch of await listChannels(deps.db)) {
    if (!ch.hasBible || !ch.slug) {
      out.push({ channel: ch.name, channelId: ch.id, ran: false, skipped: `no bible folder for slug ${ch.slug ?? '(none)'}` });
      continue;
    }
    try {
      const result = await runTrends(trendsPayloadFor(ch.id, bibleFor(ch.slug).trends), deps);
      out.push({ channel: ch.name, channelId: ch.id, ran: true, result });
    } catch (err) {
      out.push({ channel: ch.name, channelId: ch.id, ran: false, skipped: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** ISO midnight UTC for the day containing `ms`. The dedup window. */
function startOfDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export type { RawSignal };
