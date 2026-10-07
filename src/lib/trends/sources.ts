import 'server-only';

import { fetchGoogleTrending, type GoogleTrendsOptions } from '../drivers/trends-google';
import { fetchHnTop, type HnOptions } from '../drivers/trends-hn';
import { fetchRedditHot, type RedditFetchOptions } from '../drivers/trends-reddit';
import { fetchWikipediaTop, type WikipediaOptions } from '../drivers/trends-wikipedia';
import { fetchYoutubeTrends, type YoutubeFetchOptions, type YoutubeTrendConfig } from '../drivers/trends-youtube';

/**
 * Stage 1 — where trend signals come from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Every source's fetching is in a driver; this file maps each result to a RawSignal
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Reddit         drivers/trends-reddit.ts — the authenticated Data API (REDDIT_CLIENT_ID /
 *                  REDDIT_CLIENT_SECRET); unauthenticated reads are refused since 28-May-2026
 *   YouTube        drivers/trends-youtube.ts — the Data API (YOUTUBE_DATA_API_KEY)
 *   Google Trends  drivers/trends-google.ts — the public trending-searches RSS feed, no key
 *   Wikipedia      drivers/trends-wikipedia.ts — Wikimedia's pageviews "top" API, no key
 *                  (a descriptive User-Agent with contact details is its only requirement)
 *   Hacker News    drivers/trends-hn.ts — the official Firebase API, no key
 *
 * All five are free (Reddit and YouTube within their quotas) — no cost row. Wikipedia and
 * Hacker News also need no credential and no approval, which is why a science-explainer
 * channel reads them by default: Reddit's commercial use needs written approval.
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

export type TrendSource = 'youtube' | 'reddit' | 'google_trends' | 'wikipedia' | 'hn';

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

/** One part of a source (a YouTube category or query) that failed while the rest landed. */
export interface SourcePartFailure {
  readonly part: string;
  /** 'no_chart' = the category has no most-popular chart in that region — configuration, not an outage. */
  readonly kind: 'no_chart' | 'error';
  readonly detail: string;
}

export interface SourceResult {
  readonly source: TrendSource;
  /** False = the whole source failed or is not configured. True with `failures` = partial. */
  readonly ok: boolean;
  readonly signals: RawSignal[];
  readonly detail?: string;
  readonly failures?: readonly SourcePartFailure[];
}

/**
 * Reddit, through the authenticated driver (`drivers/trends-reddit.ts`) — unauthenticated
 * reads have been refused with 403 since 28-May-2026. `score / age` is a *proxy* for velocity
 * and is labelled as one: a post at 500 points in an hour is moving faster than one at 5 000
 * in a week, and the ratio is the closest thing this feed offers.
 */
export async function fetchReddit(subreddits: readonly string[], opts: RedditFetchOptions): Promise<SourceResult> {
  const now = opts.now ?? Date.now();
  const r = await fetchRedditHot(subreddits, opts);
  const signals: RawSignal[] = r.posts.map((p) => {
    const ageHours = Math.max(1, (now / 1000 - p.createdUtc) / 3600);
    return {
      source: 'reddit',
      term: p.title,
      region: null,
      // Rounded because a float with fourteen decimal places implies a precision this does not have.
      velocity: Math.round((p.score / ageHours) * 100) / 100,
      volume: p.score,
      raw: p.raw,
    };
  });
  return r.ok ? { source: 'reddit', ok: true, signals } : { source: 'reddit', ok: false, signals, detail: r.detail };
}

/**
 * YouTube, through the driver (its API host is a rule-1 name). The key is passed in, never
 * defaulted here — see `YoutubeFetchOptions.apiKey`. A missing key comes back as a refusal
 * naming `YOUTUBE_DATA_API_KEY`, not as an empty list.
 */
export async function fetchYoutube(config: YoutubeTrendConfig, opts: YoutubeFetchOptions): Promise<SourceResult> {
  const r = await fetchYoutubeTrends(config, opts);
  const signals: RawSignal[] = r.signals.map((s) => ({
    source: 'youtube',
    term: s.term,
    region: s.region,
    velocity: s.velocity,
    volume: s.volume,
    raw: s.raw,
  }));
  const failures = r.failures.length ? { failures: r.failures } : {};
  return r.ok
    ? { source: 'youtube', ok: true, signals, ...(r.detail ? { detail: r.detail } : {}), ...failures }
    : { source: 'youtube', ok: false, signals, detail: r.detail, ...failures };
}

/**
 * Google Trends "Trending now", from the public RSS feed (`drivers/trends-google.ts`). There
 * is no velocity in the feed — null, not zero. Volume is the feed's approximate traffic, a
 * lower bound ("2000+" → 2000), labelled as approximate on /trends.
 */
export async function fetchGoogleTrends(geos: readonly string[], opts: GoogleTrendsOptions = {}): Promise<SourceResult> {
  const r = await fetchGoogleTrending(geos, opts);
  const signals: RawSignal[] = r.items.map((i) => ({ source: 'google_trends', term: i.term, region: i.geo, velocity: null, volume: i.approxTraffic, raw: i.raw }));
  return r.ok ? { source: 'google_trends', ok: true, signals } : { source: 'google_trends', ok: false, signals, detail: r.detail };
}

/**
 * Wikipedia's most-viewed articles yesterday (`drivers/trends-wikipedia.ts`). Volume is the
 * day's views; velocity is the change against the day before in views per day — null when
 * the article was not in that day's list (absent, not zero). Region is null: a language is
 * not a country, and the language is in `raw.lang`.
 */
export async function fetchWikipedia(languages: readonly string[], opts: WikipediaOptions = {}): Promise<SourceResult> {
  const r = await fetchWikipediaTop(languages, opts);
  const signals: RawSignal[] = r.articles.map((a) => ({ source: 'wikipedia', term: a.title, region: null, velocity: a.change, volume: a.views, raw: a.raw }));
  return r.ok
    ? { source: 'wikipedia', ok: true, signals, ...(r.detail ? { detail: r.detail } : {}) }
    : { source: 'wikipedia', ok: false, signals, detail: r.detail };
}

/**
 * Hacker News top stories (`drivers/trends-hn.ts`). Volume is the score; velocity is score
 * per hour since posted — a proxy, like Reddit's, with the same one-hour floor so a story
 * minutes old does not read as infinitely fast. The story's URL is in `raw.url`.
 */
export async function fetchHn(opts: HnOptions & { now?: number } = {}): Promise<SourceResult> {
  const now = opts.now ?? Date.now();
  const r = await fetchHnTop(opts);
  const signals: RawSignal[] = r.stories.map((s) => {
    const ageHours = Math.max(1, (now / 1000 - s.time) / 3600);
    return { source: 'hn', term: s.title, region: null, velocity: Math.round((s.score / ageHours) * 100) / 100, volume: s.score, raw: s.raw };
  });
  return r.ok ? { source: 'hn', ok: true, signals, ...(r.detail ? { detail: r.detail } : {}) } : { source: 'hn', ok: false, signals, detail: r.detail };
}
