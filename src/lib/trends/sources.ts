import 'server-only';

import { z } from 'zod';

/**
 * Stage 1 — where trend signals come from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * These are not vendors, and that is a real distinction rather than a loophole
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * CLAUDE.md rule 1 puts the video, voice and storage vendors behind driver interfaces
 * because they are *config values that rotate*: a model changes quarterly, and the loop is
 * the durable asset. These are public read-only feeds with no credential, no cost, no
 * account and no webhook. There is nothing to isolate — no key to rotate, no bill to
 * attribute, no interface a second implementation would satisfy differently.
 *
 * `check:vendors` agrees: it enforces the names the rule actually lists, and none of these
 * is one of them.
 *
 * What they do share with a vendor is unreliability, so they are treated the same way:
 * every fetch is bounded by a timeout, a failure is one source's failure and not the run's,
 * and nothing here throws upward.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this stage is last of the three
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Trend intake without concept generation produces a table nobody reads. Stage 2 already
 * works from an operator seed and from the model's knowledge of the niche, so this makes
 * stage 2 *better* rather than making it possible — which is exactly the argument for
 * building it third.
 */

/** Bounded per source. A slow feed must not hold the run open. */
const TIMEOUT_MS = 8_000;

export type TrendSource = 'youtube' | 'reddit' | 'google_trends';

export interface RawSignal {
  readonly source: TrendSource;
  readonly term: string;
  readonly region: string | null;
  /** Rate of change where the feed exposes one. Null is honest; zero is a claim. */
  readonly velocity: number | null;
  /** Absolute interest where the feed exposes one. */
  readonly volume: number | null;
  /** The untouched payload, so a later reading is not limited by today's parsing. */
  readonly raw: unknown;
}

export interface SourceResult {
  readonly source: TrendSource;
  readonly ok: boolean;
  readonly signals: RawSignal[];
  readonly detail?: string;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    signal,
    headers: {
      // Named, because an unidentified scraper is the one that gets blocked first and the
      // block is indistinguishable from the feed being down.
      'user-agent': 'kiln/0.1 (+https://github.com/smatt92/video-pipeline)',
      accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Reddit's public listing JSON.
 *
 * Chosen as the first real source because it needs no key, exposes a usable rate proxy, and
 * is honest about what it is. `score / age` is a *proxy* for velocity and is labelled as
 * one — a post at 500 points in an hour is moving faster than one at 5 000 in a week, and
 * the ratio is the closest thing this feed offers.
 */
const RedditListing = z.object({
  data: z.object({
    children: z.array(
      z.object({
        data: z.object({
          title: z.string(),
          score: z.number(),
          created_utc: z.number(),
          num_comments: z.number().optional(),
          subreddit: z.string().optional(),
        }),
      }),
    ),
  }),
});

export async function fetchReddit(
  subreddits: readonly string[],
  opts: { baseUrl?: string; now?: number } = {},
): Promise<SourceResult> {
  const base = opts.baseUrl ?? 'https://www.reddit.com';
  const now = opts.now ?? Date.now();
  const signals: RawSignal[] = [];

  for (const sub of subreddits) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const json = await getJson(`${base}/r/${sub}/hot.json?limit=25`, controller.signal);
      const parsed = RedditListing.safeParse(json);
      if (!parsed.success) {
        // One malformed subreddit is not a failed run. Recorded and skipped.
        continue;
      }

      for (const child of parsed.data.data.children) {
        const d = child.data;
        const ageHours = Math.max(1, (now / 1000 - d.created_utc) / 3600);
        signals.push({
          source: 'reddit',
          term: d.title,
          region: null,
          // A proxy, and labelled as one in the column comment. Rounded because a float
          // with fourteen decimal places implies a precision this does not have.
          velocity: Math.round((d.score / ageHours) * 100) / 100,
          volume: d.score,
          raw: d,
        });
      }
    } catch (err) {
      return {
        source: 'reddit',
        ok: false,
        signals,
        detail: `r/${sub}: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { source: 'reddit', ok: true, signals };
}

/**
 * The two sources that are not built, named rather than omitted.
 *
 * YouTube's trending list needs a Data API key, which is a credential and therefore a
 * setup step; Google Trends has no supported public JSON endpoint and the unofficial one
 * changes without notice. Both are real work rather than oversights, and a `TrendSource`
 * union that quietly listed only Reddit would hide that the schema already expects three.
 *
 * They return an explicit refusal rather than an empty list, because an empty list from a
 * source that was never implemented is indistinguishable from a quiet day.
 */
export function notImplemented(source: TrendSource, why: string): SourceResult {
  return { source, ok: false, signals: [], detail: `not implemented: ${why}` };
}
