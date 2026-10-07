import { z } from 'zod';

/**
 * Stage 1 — Wikipedia's most-viewed articles, through the Wikimedia Pageviews REST API.
 *
 *     https://wikimedia.org/api/rest_v1/metrics/pageviews/top/{lang}.wikipedia/all-access/YYYY/MM/DD
 *
 * Free, no key, no account — no ledger row. Wikimedia's API policy requires a descriptive
 * User-Agent with contact details and blocks generic ones, so every request names Kiln and an
 * address (`USER_AGENT`); a block would otherwise be indistinguishable from the API being down.
 *
 * ── Which day ────────────────────────────────────────────────────────────────
 *
 * The previous UTC day. Today's totals are not published until the day is over, so asking
 * for today is a 404 every time. A 404 for yesterday therefore means "not published yet"
 * (early in the UTC day) and is said in those words.
 *
 * ── Velocity is the change against the day before, from one more call ────────
 *
 * The same endpoint for the day before yesterday returns that day's top 1000; an article in
 * both lists gets `views(d) − views(d−1)`, in views per day. An article that was not in the
 * earlier top 1000 has no reading to subtract — its velocity is null (absent), never its
 * whole view count and never zero. If that second call fails, every velocity is null and the
 * source still succeeds: the views are measured, the change is not.
 *
 * ── Non-articles are filtered by namespace ───────────────────────────────────
 *
 * The list is pages, not articles: the main page, `Special:Search`, `Wikipedia:…`, `File:…`,
 * and a literal "-" (unattributed views) sit near the top every day. A namespace is a prefix
 * up to a colon with no underscore before it and none after it (`Special:Search`,
 * `Spezial:Suche`, `Wikipédia:Accueil_principal`), which covers every language's localised
 * names without a table per wiki. Article titles that use a colon have a space after it
 * (`Dune:_Part_Two`), so they stay. The cost is the rare title like `Re:Zero`, dropped.
 */

const TIMEOUT_MS = 8_000;
const DEFAULT_BASE = 'https://wikimedia.org';
export const WIKIPEDIA_USER_AGENT = 'kiln/0.1 (https://video-pipeline-seven.vercel.app/about; sahil.matt@gmail.com)';
/** Languages read when a channel's trend sources do not say. */
export const DEFAULT_WIKIPEDIA_LANGUAGES = ['en'] as const;
/** Articles kept per language, after non-articles are removed. */
export const DEFAULT_WIKIPEDIA_TOP_N = 50;

export interface WikipediaOptions {
  /** A harness points this at a stub. */
  readonly baseUrl?: string;
  readonly now?: number;
  readonly topN?: number;
}

export interface WikipediaArticle {
  readonly lang: string;
  /** Spaces, not underscores — the title as a person reads it. */
  readonly title: string;
  readonly views: number;
  /** views(d) − views(d−1); null when the article was not in the day before's list, or that list could not be read. */
  readonly change: number | null;
  readonly raw: Record<string, unknown>;
}

export type WikipediaResult =
  | { ok: true; articles: WikipediaArticle[]; detail?: string }
  | { ok: false; articles: WikipediaArticle[]; detail: string };

const TopResponse = z.object({
  items: z
    .array(
      z.object({
        project: z.string(),
        access: z.string().optional(),
        year: z.string(),
        month: z.string(),
        day: z.string(),
        articles: z.array(z.object({ article: z.string().min(1).max(512), views: z.number().int().nonnegative(), rank: z.number().int().positive() })).max(1000),
      }),
    )
    .min(1),
});

const NAMESPACE = /^[^_:]+:[^_]/;
const MAIN_PAGES = new Set(['Main_Page', '-', 'Undefined']);

/** True for a page that is an article. Exported for the harness. */
export function isArticle(title: string): boolean {
  if (MAIN_PAGES.has(title)) return false;
  return !NAMESPACE.test(title);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY/MM/DD` for the UTC day `daysBack` days before `now`. */
export function wikiDay(now: number, daysBack: number): string {
  const d = new Date(now - daysBack * 86_400_000);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

type Fetched = { ok: true; articles: z.infer<typeof TopResponse>['items'][number]['articles'] } | { ok: false; detail: string };

async function topFor(base: string, lang: string, day: string): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/rest_v1/metrics/pageviews/top/${encodeURIComponent(lang)}.wikipedia/all-access/${day}`, {
      signal: controller.signal,
      headers: { 'user-agent': WIKIPEDIA_USER_AGENT, 'api-user-agent': WIKIPEDIA_USER_AGENT, accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.status === 404) return { ok: false, detail: `${lang} ${day}: HTTP 404 — that day's most-viewed list is not published yet (or the language code is wrong)` };
    if (res.status === 403) return { ok: false, detail: `${lang} ${day}: refused 403 — Wikimedia blocked the request (User-Agent policy or rate limit)` };
    if (!res.ok) return { ok: false, detail: `${lang} ${day}: HTTP ${res.status} — the pageviews API did not answer` };
    const parsed = TopResponse.safeParse(await res.json());
    if (!parsed.success) return { ok: false, detail: `${lang} ${day}: unexpected response shape: ${parsed.error.issues.map((i) => i.path.join('.') || 'body').slice(0, 3).join(', ')}` };
    return { ok: true, articles: parsed.data.items[0].articles };
  } catch (err) {
    const why = err instanceof Error ? (err.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000} s` : err.message) : String(err);
    return { ok: false, detail: `${lang} ${day}: ${why}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Yesterday's most-viewed articles per language, with the change against the day before. */
export async function fetchWikipediaTop(languages: readonly string[], opts: WikipediaOptions = {}): Promise<WikipediaResult> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const now = opts.now ?? Date.now();
  const topN = opts.topN ?? DEFAULT_WIKIPEDIA_TOP_N;
  const day = wikiDay(now, 1);
  const before = wikiDay(now, 2);
  const articles: WikipediaArticle[] = [];
  const notes: string[] = [];

  for (const lang of languages) {
    const top = await topFor(base, lang, day);
    if (!top.ok) return { ok: false, articles, detail: top.detail };
    const kept = top.articles.filter((a) => isArticle(a.article)).slice(0, topN);
    if (kept.length === 0) return { ok: false, articles, detail: `${lang} ${day}: the list answered with no articles — unexpected response or an empty day` };

    const prev = await topFor(base, lang, before);
    const prevViews = new Map<string, number>();
    if (prev.ok) for (const a of prev.articles) prevViews.set(a.article, a.views);
    else notes.push(`velocity unavailable for ${lang} (${prev.detail})`);

    for (const a of kept) {
      const p = prevViews.get(a.article);
      articles.push({
        lang,
        title: a.article.replace(/_/g, ' '),
        views: a.views,
        change: p === undefined ? null : a.views - p,
        raw: {
          article: a.article,
          views: a.views,
          rank: a.rank,
          views_day_before: p ?? null,
          lang,
          date: day,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(a.article).replace(/%3A/g, ':')}`,
        },
      });
    }
  }
  return notes.length ? { ok: true, articles, detail: notes.join('; ') } : { ok: true, articles };
}
