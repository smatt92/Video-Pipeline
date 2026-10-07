import { z } from 'zod';

import type { Db } from '../db/server';
import { readChannelFlags } from '../settings/channel-flags';

/**
 * `trends_recent` — the Bureau's read of stage 1, for the token's channel only.
 *
 * Caller: the `trends_recent` tool in `src/lib/bureau/mcp/surface.ts`, served on /api/mcp to
 * Routines and Claude connectors. Read-only and agent-scope: the Showrunner reads what the
 * channel's audience is watching before it drafts.
 *
 * ── One channel, the token's ──────────────────────────────────────────────────
 *
 * A token is minted for one channel. `channel` is accepted so a caller can say which channel
 * it believes it is asking about — and refused when that is not the token's, by id or by
 * slug, rather than silently answered for the token's channel. A model told "here are the
 * trends" for a channel it did not ask about would draft for the wrong audience.
 *
 * ── Rows without a channel are not returned ──────────────────────────────────
 *
 * `channel_id is null` rows predate 0046 and belong to no channel in particular; they are
 * not this channel's trends and are left out. The exception is a database where 0046 has not
 * been applied at all: there the read is unfiltered and the result says so (`scope`).
 */

/**
 * Postgres says `column "channel_id" … does not exist`; PostgREST says "Could not find the
 * 'channel_id' column … in the schema cache". One predicate, shared with `run.ts`, so the
 * writer and the reader cannot disagree about what "0046 not applied" looks like.
 */
export function isChannelColumnMissing(message: string | undefined): boolean {
  return !!message && /channel_id/i.test(message) && /does not exist|schema cache|could not find/i.test(message);
}

export const TrendsRecentArgs = z
  .object({
    channel: z.string().min(1).max(80).optional().describe('Slug or id of the channel you mean. Must be this token’s channel.'),
    days: z.number().int().min(1).max(30).default(7),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type TrendsRecentArgs = z.infer<typeof TrendsRecentArgs>;

export interface RecentSignal {
  source: string;
  term: string;
  /** Source-normalised proxy (Reddit: score/hour since posting; YouTube: views/hour since publish). Null = unknown. */
  velocity: number | null;
  volume: number | null;
  captured_at: string;
  url: string | null;
  /** Cosine with the channel's niche (0051). Null = not scored — never read it as 0. */
  relevance: number | null;
}

export type TrendsRecentResult =
  | {
      ok: true;
      channel_id: string;
      /** 'channel' = filtered to the token's channel; 'workspace' = 0046 absent, so unfiltered (see `scope_note`). */
      scope: 'channel' | 'workspace';
      scope_note?: string;
      days: number;
      count: number;
      velocity_note: string;
      relevance_note: string;
      signals: RecentSignal[];
    }
  | { ok: false; refused: true; summary: string };

const RedditRaw = z.object({ permalink: z.string().regex(/^\/r\//) });
const YoutubeRaw = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{6,20}$/) });
const WikipediaRaw = z.object({ url: z.string().regex(/^https:\/\/[a-z-]+\.wikipedia\.org\/wiki\//) });
const HnRaw = z.object({ url: z.string().regex(/^https?:\/\//).nullable(), hn_url: z.string().regex(/^https:\/\/news\.ycombinator\.com\//) });

/** A signal's link from its raw payload, where the source gives one. Shared with /trends. */
export function signalUrl(source: string, raw: unknown): string | null {
  if (source === 'reddit') {
    const r = RedditRaw.safeParse(raw);
    return r.success ? `https://www.reddit.com${r.data.permalink}` : null;
  }
  if (source === 'youtube') {
    const r = YoutubeRaw.safeParse(raw);
    return r.success ? `https://www.youtube.com/watch?v=${r.data.id}` : null;
  }
  if (source === 'wikipedia') {
    const r = WikipediaRaw.safeParse(raw);
    return r.success ? r.data.url : null;
  }
  if (source === 'hn') {
    // The story's own link where it has one; an Ask HN has none, so its discussion page.
    const r = HnRaw.safeParse(raw);
    return r.success ? (r.data.url ?? r.data.hn_url) : null;
  }
  return null;
}

/**
 * `numeric` crosses the wire as a string. `Number()` here is a decision: velocity is a small
 * decimal and volume a view/score count, both far inside 2^53.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface Row {
  source: string;
  term: string;
  velocity: unknown;
  volume: unknown;
  captured_at: string;
  raw: unknown;
  relevance?: unknown;
}

const toSignal = (r: Row): RecentSignal => ({
  source: r.source,
  term: r.term,
  velocity: num(r.velocity),
  volume: num(r.volume),
  captured_at: r.captured_at,
  url: signalUrl(r.source, r.raw),
  relevance: num(r.relevance),
});

export async function trendsRecent(db: Db, tokenChannelId: string, args: TrendsRecentArgs, now: number = Date.now()): Promise<TrendsRecentResult> {
  if (args.channel !== undefined && args.channel !== tokenChannelId) {
    const { data: mine } = await db.from('channels').select('slug').eq('id', tokenChannelId).maybeSingle();
    if (!mine?.slug || args.channel !== mine.slug) {
      return {
        ok: false,
        refused: true,
        summary: `trends_recent answers for this token’s channel only (${mine?.slug ?? tokenChannelId}); "${args.channel}" is not it. Use a token minted for that channel.`,
      };
    }
  }

  const since = new Date(now - args.days * 86_400_000).toISOString();
  let cols = 'source, term, velocity, volume, captured_at, raw, relevance';
  let scope: 'channel' | 'workspace' = 'channel';
  // Applied only while the column exists. Without 0046 there is no per-channel fact to filter
  // on — every row is workspace-wide — so the read falls back to unfiltered and says so.
  const scoped = <Q extends { eq(c: 'channel_id', v: string): Q }>(q: Q): Q => (scope === 'channel' ? q.eq('channel_id', tokenChannelId) : q);

  // Two reads rather than `order(velocity, nullsFirst: false)`: the rows with a velocity
  // first, highest first, then — only if there is room — the rows without one, newest first.
  // Nulls last is the ordering asked for; doing it in two steps means it cannot depend on a
  // client honouring a nulls option.
  const rankedQ = () =>
    scoped(db.from('trend_signals').select(cols))
      .gte('captured_at', since)
      .not('velocity', 'is', null)
      .order('velocity', { ascending: false })
      .limit(args.limit);
  let ranked = await rankedQ();
  if (ranked.error && /relevance/.test(ranked.error.message) && /does not exist|schema cache|could not find/i.test(ranked.error.message)) {
    cols = 'source, term, velocity, volume, captured_at, raw';
    ranked = await rankedQ();
  }
  if (ranked.error && isChannelColumnMissing(ranked.error.message)) {
    scope = 'workspace';
    ranked = await rankedQ();
  }
  if (ranked.error) return { ok: false, refused: true, summary: `Reading trend_signals failed: ${ranked.error.message}` };

  // The channel's relevant signals first (0051): at or above its threshold, most relevant
  // first, so a model drafting for a science channel sees the science before the celebrity
  // news however fast the latter is moving. Then the velocity ranking below, minus those.
  const relevantRows: Row[] = [];
  let threshold: number | null = null;
  if (scope === 'channel' && cols.includes('relevance')) {
    threshold = (await readChannelFlags(db, tokenChannelId)).values.relevanceThreshold;
    const rel = await db
      .from('trend_signals')
      .select(cols)
      .eq('channel_id', tokenChannelId)
      .gte('captured_at', since)
      .gte('relevance', threshold)
      .order('relevance', { ascending: false })
      .limit(args.limit);
    if (rel.error) return { ok: false, refused: true, summary: `Reading trend_signals failed: ${rel.error.message}` };
    relevantRows.push(...((rel.data ?? []) as unknown as Row[]));
  }
  const key = (r: Row) => `${r.source}\u0000${r.term}\u0000${r.captured_at}`;
  const seen = new Set(relevantRows.map(key));
  const rows: Row[] = [...relevantRows, ...((ranked.data ?? []) as unknown as Row[]).filter((r) => !seen.has(key(r)))].slice(0, args.limit);
  if (rows.length < args.limit) {
    const unranked = await scoped(db.from('trend_signals').select(cols))
      .gte('captured_at', since)
      .is('velocity', null)
      .order('captured_at', { ascending: false })
      .limit(args.limit);
    if (unranked.error) return { ok: false, refused: true, summary: `Reading trend_signals failed: ${unranked.error.message}` };
    rows.push(...((unranked.data ?? []) as unknown as Row[]).filter((r) => !seen.has(key(r))).slice(0, args.limit - rows.length));
  }

  const signals = rows.map(toSignal);
  return {
    ok: true,
    channel_id: tokenChannelId,
    scope,
    ...(scope === 'workspace'
      ? {
          scope_note:
            'migration 0046 not applied: trend_signals has no channel_id, so these are every signal in the workspace, not this channel’s alone. Apply 0046 and the next intake writes per channel.',
        }
      : {}),
    days: args.days,
    count: signals.length,
    velocity_note: 'velocity is a proxy, not a measurement: Reddit = score per hour since posting; YouTube = views per hour since publish. null = the source gave none, not zero.',
    relevance_note:
      threshold === null
        ? 'relevance is not available on this database (migration 0051), so signals are ranked by velocity alone.'
        : `relevance is cosine similarity to this channel's niche (premise, series, calendar topics); signals at or above ${threshold} come first, most relevant first, then the rest by velocity. null = not scored, never 0.`,
    signals,
  };
}
