import { z } from 'zod';

/**
 * Stage 1 — Google Trends "Trending now", through its public RSS feed.
 *
 * ── What exists and what does not ────────────────────────────────────────────
 *
 * Google has no generally available Trends API: the official one announced in 2025 is an
 * alpha for allow-listed testers, and the JSON the website calls is undocumented. What IS
 * public and free is the trending-searches RSS feed, one per country:
 *
 *     https://trends.google.com/trending/rss?geo=IN
 *
 * Each <item> is one trending search: <title> (the search), <ht:approx_traffic> ("2000+",
 * "10K+"), <pubDate>, and <ht:news_item> blocks naming the articles behind it. No key, no
 * account, no cost — no ledger row, the same position as Reddit and the YouTube Data API.
 *
 * ── Unverified from where this was written ───────────────────────────────────
 *
 * The build container's egress policy refuses trends.google.com, so the element names above
 * are from the feed's published shape, not from a response read here. That is why the parse
 * is strict and loud: a feed that moved or changed shape reports "unexpected feed shape" by
 * name on /trends (trend_runs, 0049), never an empty list that reads as a quiet day.
 *
 * No XML dependency: the feed is flat and the fields needed are four, so they are read with
 * bounded patterns and then validated with Zod like every other external payload.
 */

const TIMEOUT_MS = 8_000;
const DEFAULT_BASE = 'https://trends.google.com';
/** Countries read when a channel's trend sources do not say. */
export const DEFAULT_GOOGLE_TRENDS_GEOS = ['IN', 'US'] as const;

export interface GoogleTrendsOptions {
  /** A harness points this at a stub. */
  readonly baseUrl?: string;
}

export interface GoogleTrendItem {
  readonly term: string;
  readonly geo: string;
  /** "2000+" → 2000; "10K+" → 10000. A lower bound, labelled as approximate. Null when absent. */
  readonly approxTraffic: number | null;
  readonly raw: Record<string, unknown>;
}

export type GoogleTrendsResult =
  | { ok: true; items: GoogleTrendItem[] }
  | { ok: false; items: GoogleTrendItem[]; detail: string };

const ItemSchema = z.object({
  title: z.string().min(1).max(300),
  approx_traffic: z.string().max(40).nullable(),
  pub_date: z.string().max(80).nullable(),
  news: z.array(z.object({ title: z.string().max(500), url: z.string().max(2000).nullable() })).max(10),
});

const decode = (s: string) =>
  s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : null;
}

/** "2,000+" → 2000, "10K+" → 10000, "1M+" → 1000000. */
export function parseApproxTraffic(s: string | null): number | null {
  if (!s) return null;
  const m = /^([\d,.]+)\s*([KkMm])?\+?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? (m[2].toUpperCase() === 'K' ? 1_000 : 1_000_000) : 1;
  return Math.round(n * mult);
}

/** The items of one feed body. Exported for the harness. Throws on a body that is not the feed. */
export function parseTrendingRss(xml: string, geo: string): GoogleTrendItem[] {
  if (!/<rss[\s>]/.test(xml) || !/<channel[\s>]/.test(xml)) throw new Error('unexpected feed shape: no <rss><channel>');
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((body) => {
    const news = [...body.matchAll(/<ht:news_item(?:\s[^>]*)?>([\s\S]*?)<\/ht:news_item>/g)].map((n) => ({
      title: tag(n[1], 'ht:news_item_title') ?? '',
      url: tag(n[1], 'ht:news_item_url'),
    }));
    const parsed = ItemSchema.safeParse({
      title: tag(body, 'title'),
      approx_traffic: tag(body, 'ht:approx_traffic'),
      pub_date: tag(body, 'pubDate'),
      news: news.slice(0, 10),
    });
    if (!parsed.success) throw new Error(`unexpected feed shape: ${parsed.error.issues.map((i) => i.path.join('.') || 'item').join(', ')}`);
    return { term: parsed.data.title, geo, approxTraffic: parseApproxTraffic(parsed.data.approx_traffic), raw: parsed.data };
  });
}

/** Trending searches for each country. One country failing ends the source's run with its reason. */
export async function fetchGoogleTrending(geos: readonly string[], opts: GoogleTrendsOptions = {}): Promise<GoogleTrendsResult> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const items: GoogleTrendItem[] = [];
  for (const geo of geos) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/trending/rss?geo=${encodeURIComponent(geo)}`, {
        signal: controller.signal,
        headers: { accept: 'application/rss+xml, application/xml, text/xml' },
        cache: 'no-store',
      });
      if (!res.ok) return { ok: false, items, detail: `geo ${geo}: HTTP ${res.status} — the trending feed did not answer` };
      const got = parseTrendingRss(await res.text(), geo);
      if (got.length === 0) return { ok: false, items, detail: `geo ${geo}: the feed answered with no items — unexpected feed shape or an empty day` };
      items.push(...got);
    } catch (err) {
      const why = err instanceof Error ? (err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000} s` : err.message) : String(err);
      return { ok: false, items, detail: `geo ${geo}: ${why}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, items };
}
