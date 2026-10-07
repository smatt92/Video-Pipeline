import { z } from 'zod';

/**
 * Stage 1 — YouTube as a trend source, through the YouTube Data API v3.
 *
 * In `drivers/` because the API's hostname is `www.googleapis.com`, and that name is on
 * rule 1's list. Everything above this file speaks in `TrendSignalDraft`s and never learns
 * which host produced them.
 *
 * ── Rule 5: no cost_ledger row, and why that is not an omission ──────────────
 *
 * The Data API is free within its daily quota (10 000 units per Google Cloud project by
 * default). Nothing here moves money, so there is nothing to ledger — the same position as
 * Reddit, stated where a reader auditing rule 5 will look. What it does spend is quota, and
 * quota running out is reported by name (`quotaExceeded`) rather than as an empty list:
 *   · `videos?chart=mostPopular`  — 1 unit per call (one per configured category id)
 *   · `search`                    — 100 units per call (one per configured query)
 *   · `videos?id=…`               — 1 unit, one batch for the search results' statistics
 * So the Bureau's config (2 categories, 2 queries) costs ~203 units a run, ~812 a day at
 * four runs — well inside the default quota for one channel, and worth re-reading per channel.
 *
 * ── The third call, which the endpoint list did not name ─────────────────────
 *
 * `search` returns ids and snippets but **no statistics**. Without a view count there is
 * neither volume nor velocity, and a search hit would land as a row of nulls ranked below
 * everything. One `videos?part=statistics&id=a,b,c` call (1 unit) fetches the numbers for
 * every search hit at once, so search hits are measured exactly like chart hits.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 * `YOUTUBE_DATA_API_KEY`, optional in the environment schema. It comes from Google Cloud
 * console → the project → APIs & Services → enable "YouTube Data API v3" → Credentials →
 * Create credentials → API key, restricted to that one API. Without it this source refuses
 * by naming the variable — never an empty list, which would read as a quiet day.
 */

/** Bounded per call. A slow API must not hold the run open. */
const TIMEOUT_MS = 8_000;
const DEFAULT_BASE = 'https://www.googleapis.com';
const MAX_RESULTS = 25;
/** How far back `search` looks. A week: "trending" older than that is a back catalogue. */
const SEARCH_WINDOW_MS = 7 * 86_400_000;

export interface YoutubeTrendConfig {
  readonly region_code: string;
  readonly category_ids: readonly string[];
  readonly queries: readonly string[];
}

/** The shape `src/lib/trends/` turns into a `RawSignal`. Same fields, same meanings. */
export interface YoutubeSignal {
  readonly term: string;
  readonly region: string;
  /** Views per hour since publish — a proxy for velocity, labelled as one. */
  readonly velocity: number | null;
  /** View count. Null when the API withheld it (some videos hide statistics). */
  readonly volume: number | null;
  readonly raw: Record<string, unknown>;
}

export type YoutubeFetchResult =
  | { ok: true; signals: YoutubeSignal[] }
  | { ok: false; signals: YoutubeSignal[]; detail: string };

export interface YoutubeFetchOptions {
  /**
   * Required, not defaulted to the environment. An absent key is a refusal, and a parameter
   * that silently read `process.env` would make that refusal untestable from a harness
   * whose machine happens to have one set. The task resolves it with `youtubeApiKeyFromEnv`.
   */
  readonly apiKey: string | null;
  /** A harness points this at a stub server. Production leaves it unset. */
  readonly baseUrl?: string;
  readonly now?: number;
}

/** The task's one read of the key. Trimmed; empty counts as unset. */
export function youtubeApiKeyFromEnv(raw: string | undefined = process.env.YOUTUBE_DATA_API_KEY): string | null {
  const v = raw?.trim();
  return v ? v : null;
}

export const MISSING_KEY_DETAIL =
  'refused: YOUTUBE_DATA_API_KEY is not set — create one in Google Cloud console → your project → ' +
  'APIs & Services → enable "YouTube Data API v3" → Credentials → API key (restrict it to that ' +
  'API), then set it in Vercel production; the Trigger deploy copies it to the worker (0017).';

// ── Response schemas ─────────────────────────────────────────────────────────

const Snippet = z.object({
  title: z.string(),
  publishedAt: z.string(),
  channelTitle: z.string().optional(),
  categoryId: z.string().optional(),
});

/** `viewCount` is a uint64 sent as a decimal string. */
const Statistics = z.object({
  viewCount: z.string().regex(/^\d+$/).optional(),
  likeCount: z.string().optional(),
  commentCount: z.string().optional(),
});

const VideoItem = z.object({
  id: z.string(),
  snippet: Snippet.optional(),
  statistics: Statistics.optional(),
});
const VideoList = z.object({ items: z.array(VideoItem) });

const SearchList = z.object({
  items: z.array(
    z.object({
      id: z.object({ videoId: z.string().optional() }),
      snippet: Snippet.optional(),
    }),
  ),
});

const ApiError = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

type Video = z.infer<typeof VideoItem>;

class YoutubeApiError extends Error {}

async function call(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' }, cache: 'no-store' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = ApiError.safeParse(body);
      const reason = parsed.success ? parsed.data.error.errors?.[0]?.reason : undefined;
      const message = parsed.success ? parsed.data.error.message : undefined;
      if (res.status === 403 && reason === 'quotaExceeded') {
        throw new YoutubeApiError(
          'HTTP 403 quotaExceeded — the Data API daily quota for this key’s Google Cloud project is spent; ' +
            'it resets at midnight Pacific time. Nothing was collected from YouTube this run.',
        );
      }
      if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
        throw new YoutubeApiError(
          `HTTP ${res.status} ${reason} — "YouTube Data API v3" is not enabled on this key’s Google Cloud project. ` +
            'Enable it under APIs & Services → Library; the key itself is fine.',
        );
      }
      if (reason === 'keyInvalid' || (res.status === 400 && /API key not valid/i.test(message ?? ''))) {
        throw new YoutubeApiError(`HTTP ${res.status} keyInvalid — YOUTUBE_DATA_API_KEY is set but Google does not accept it. Re-copy it from Credentials.`);
      }
      throw new YoutubeApiError(`HTTP ${res.status}${reason ? ` ${reason}` : ''}${message ? ` — ${message}` : ''}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Never logs or returns the URL: it carries the key. */
function endpoint(base: string, path: string, params: Record<string, string>, key: string): string {
  const q = new URLSearchParams({ ...params, key });
  return `${base}/youtube/v3/${path}?${q.toString()}`;
}

/**
 * Trending videos for one channel's configuration: the most-popular chart per category, and
 * a week's most-viewed per query. Deduplicated by video id within the run.
 */
export async function fetchYoutubeTrends(config: YoutubeTrendConfig, opts: YoutubeFetchOptions): Promise<YoutubeFetchResult> {
  if (!opts.apiKey) return { ok: false, signals: [], detail: MISSING_KEY_DETAIL };
  const key = opts.apiKey;
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const now = opts.now ?? Date.now();

  const seen = new Map<string, YoutubeSignal>();
  const add = (v: Video, via: Record<string, string>) => {
    if (!v.snippet || seen.has(v.id)) return;
    const views = v.statistics?.viewCount;
    // Number() is a decision: a view count is far below 2^53, so the double is exact.
    const volume = views === undefined ? null : Number(views);
    const published = Date.parse(v.snippet.publishedAt);
    const ageHours = Number.isFinite(published) ? Math.max(1, (now - published) / 3_600_000) : null;
    seen.set(v.id, {
      term: v.snippet.title,
      region: config.region_code,
      // A proxy, rounded for the same reason Reddit's is: fourteen decimals imply precision
      // the ratio does not have. Null when either side is unknown — never zero.
      velocity: volume === null || ageHours === null ? null : Math.round((volume / ageHours) * 100) / 100,
      volume,
      raw: { ...v, kiln_via: via },
    });
  };

  try {
    for (const category of config.category_ids) {
      const json = await call(
        endpoint(base, 'videos', {
          part: 'snippet,statistics',
          chart: 'mostPopular',
          regionCode: config.region_code,
          videoCategoryId: category,
          maxResults: String(MAX_RESULTS),
        }, key),
      );
      const parsed = VideoList.safeParse(json);
      if (!parsed.success) {
        return { ok: false, signals: [...seen.values()], detail: `mostPopular category ${category}: unexpected response shape` };
      }
      for (const v of parsed.data.items) add(v, { via: 'mostPopular', category_id: category });
    }

    const publishedAfter = new Date(now - SEARCH_WINDOW_MS).toISOString();
    const fromSearch: { id: string; query: string }[] = [];
    for (const query of config.queries) {
      const json = await call(
        endpoint(base, 'search', {
          part: 'snippet',
          type: 'video',
          order: 'viewCount',
          publishedAfter,
          q: query,
          regionCode: config.region_code,
          maxResults: String(MAX_RESULTS),
        }, key),
      );
      const parsed = SearchList.safeParse(json);
      if (!parsed.success) {
        return { ok: false, signals: [...seen.values()], detail: `search "${query}": unexpected response shape` };
      }
      for (const item of parsed.data.items) {
        const id = item.id.videoId;
        if (id && !seen.has(id) && !fromSearch.some((s) => s.id === id)) fromSearch.push({ id, query });
      }
    }

    // One statistics batch for every search hit — see the header. 50 ids is the API's cap.
    for (let i = 0; i < fromSearch.length; i += 50) {
      const batch = fromSearch.slice(i, i + 50);
      const json = await call(endpoint(base, 'videos', { part: 'snippet,statistics', id: batch.map((b) => b.id).join(',') }, key));
      const parsed = VideoList.safeParse(json);
      if (!parsed.success) {
        return { ok: false, signals: [...seen.values()], detail: 'statistics for search results: unexpected response shape' };
      }
      for (const v of parsed.data.items) {
        const query = batch.find((b) => b.id === v.id)?.query ?? '';
        add(v, { via: 'search', query });
      }
    }
  } catch (err) {
    const why = err instanceof YoutubeApiError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, signals: [...seen.values()], detail: why };
  }

  return { ok: true, signals: [...seen.values()] };
}
