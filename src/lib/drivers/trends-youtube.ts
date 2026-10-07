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

/**
 * One call of the run that failed while the others went on (O5). `part` names it the way a
 * person reads it — "category 27", "query “physics explained”" — and `kind` separates a chart
 * that does not exist for that category in that region (a configuration fact, said once on
 * /trends) from any other error.
 */
export interface YoutubePartFailure {
  readonly part: string;
  readonly kind: 'no_chart' | 'error';
  readonly detail: string;
}

/**
 * `ok: true` with `failures` is a PARTIAL result: some categories or queries failed and the
 * rest landed. `ok: false` is the whole source — the key, the project or the quota, which no
 * other call this run would get past either, or every part failing.
 */
export type YoutubeFetchResult =
  | { ok: true; signals: YoutubeSignal[]; failures: YoutubePartFailure[]; detail?: string }
  | { ok: false; signals: YoutubeSignal[]; failures: YoutubePartFailure[]; detail: string };

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

/**
 * `fatal` = no other call this run can succeed either (quota spent, key refused, API not
 * enabled), so the run stops. Anything else is one category's or one query's failure.
 * `status`/`reason` are kept so the chart-not-found case can be told apart.
 */
class YoutubeApiError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean = false,
    readonly status: number | null = null,
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/**
 * A `mostPopular` chart that does not exist for this category in this region.
 *
 * Google documents `videoChartNotFound` (400, "The requested video chart is not supported or
 * is not available") for this case on videos.list. What the hosted run actually received for
 * category 27 (Education) in IN, 07-Oct 14:25 and 14:31 UTC, was `404 notFound — Requested
 * entity was not found.` — undocumented for this endpoint, but the same fact: there is no
 * chart to return. Both are matched; nothing else on a chart call is read as "no chart".
 * Google publishes no list of which categories have a chart in which region, so the only
 * instrument is the call itself, and its answer is recorded per category on every run.
 */
function isNoChart(err: YoutubeApiError): boolean {
  return (err.status === 404 && (err.reason === 'notFound' || err.reason === null)) || err.reason === 'videoChartNotFound';
}

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
            'it resets at midnight Pacific time. Nothing more was collected from YouTube this run.',
          true,
          res.status,
          reason,
        );
      }
      if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED') {
        throw new YoutubeApiError(
          `HTTP ${res.status} ${reason} — "YouTube Data API v3" is not enabled on this key’s Google Cloud project. ` +
            'Enable it under APIs & Services → Library; the key itself is fine.',
          true,
          res.status,
          reason,
        );
      }
      if (reason === 'keyInvalid' || (res.status === 400 && /API key not valid/i.test(message ?? ''))) {
        throw new YoutubeApiError(`HTTP ${res.status} keyInvalid — YOUTUBE_DATA_API_KEY is set but Google does not accept it. Re-copy it from Credentials.`, true, res.status, reason ?? 'keyInvalid');
      }
      throw new YoutubeApiError(`HTTP ${res.status}${reason ? ` ${reason}` : ''}${message ? ` — ${message}` : ''}`, false, res.status, reason ?? null);
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
 *
 * ── One failing category is that category's failure, not the source's (O5) ──
 *
 * Until 07-Oct the first error ended the run: category 27 answered 404 in IN, so the two
 * queries after it were never asked and the whole source read "failed" with category 28's 25
 * videos still landing under it. Now each category and each query is its own attempt, its
 * failure is recorded by name in `failures`, and the rest go on. Only an error no later call
 * could get past either (quota, key, API not enabled) stops the run.
 */
export async function fetchYoutubeTrends(config: YoutubeTrendConfig, opts: YoutubeFetchOptions): Promise<YoutubeFetchResult> {
  if (!opts.apiKey) return { ok: false, signals: [], failures: [], detail: MISSING_KEY_DETAIL };
  const key = opts.apiKey;
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const now = opts.now ?? Date.now();

  const seen = new Map<string, YoutubeSignal>();
  const failures: YoutubePartFailure[] = [];
  let attempted = 0;
  let succeeded = 0;
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

  /** One part: its call, its parse, its failure. Throws only what must stop the run. */
  const attempt = async (part: string, chart: boolean, f: () => Promise<boolean>) => {
    attempted++;
    try {
      if (await f()) succeeded++;
      else failures.push({ part, kind: 'error', detail: 'unexpected response shape' });
    } catch (err) {
      if (err instanceof YoutubeApiError && err.fatal) throw err;
      if (err instanceof YoutubeApiError && chart && isNoChart(err)) {
        failures.push({
          part,
          kind: 'no_chart',
          detail: `no most-popular chart for this category in ${config.region_code} (${err.message}) — Google does not publish which categories have one; keep it as a query instead, or remove it`,
        });
        return;
      }
      failures.push({ part, kind: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const summarise = (): string | undefined =>
    failures.length ? failures.map((f) => `${f.part}: ${f.detail}`).join('; ') : undefined;

  try {
    for (const category of config.category_ids) {
      await attempt(`category ${category}`, true, async () => {
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
        if (!parsed.success) return false;
        for (const v of parsed.data.items) add(v, { via: 'mostPopular', category_id: category });
        return true;
      });
    }

    const publishedAfter = new Date(now - SEARCH_WINDOW_MS).toISOString();
    const fromSearch: { id: string; query: string }[] = [];
    for (const query of config.queries) {
      await attempt(`query “${query}”`, false, async () => {
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
        if (!parsed.success) return false;
        for (const item of parsed.data.items) {
          const id = item.id.videoId;
          if (id && !seen.has(id) && !fromSearch.some((s) => s.id === id)) fromSearch.push({ id, query });
        }
        return true;
      });
    }

    // One statistics batch for every search hit — see the header. 50 ids is the API's cap.
    // Not counted as a part of its own: it measures the queries' hits, and its failure is
    // recorded so those hits are known to be missing rather than silently absent.
    for (let i = 0; i < fromSearch.length; i += 50) {
      const batch = fromSearch.slice(i, i + 50);
      try {
        const json = await call(endpoint(base, 'videos', { part: 'snippet,statistics', id: batch.map((b) => b.id).join(',') }, key));
        const parsed = VideoList.safeParse(json);
        if (!parsed.success) {
          failures.push({ part: 'statistics for search results', kind: 'error', detail: 'unexpected response shape' });
          continue;
        }
        for (const v of parsed.data.items) {
          const query = batch.find((b) => b.id === v.id)?.query ?? '';
          add(v, { via: 'search', query });
        }
      } catch (err) {
        if (err instanceof YoutubeApiError && err.fatal) throw err;
        failures.push({ part: 'statistics for search results', kind: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, signals: [...seen.values()], failures, detail: why };
  }

  // Every part failed → the source failed; some did → partial, with each failure by name.
  if (attempted > 0 && succeeded === 0) {
    return { ok: false, signals: [...seen.values()], failures, detail: summarise() ?? 'every call failed' };
  }
  const detail = summarise();
  return { ok: true, signals: [...seen.values()], failures, ...(detail ? { detail } : {}) };
}
