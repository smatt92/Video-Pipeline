import { z } from 'zod';

/**
 * Stage 1 — Hacker News top stories, through the official Firebase API.
 *
 *     https://hacker-news.firebaseio.com/v0/topstories.json   → up to 500 ids, ranked
 *     https://hacker-news.firebaseio.com/v0/item/{id}.json    → one item
 *
 * Free, no key, no account, no documented rate limit — no ledger row. There is no batch
 * endpoint, so the top N items are fetched one by one with bounded concurrency
 * (`CONCURRENCY`), each under its own timeout.
 *
 * Only stories are kept: `type: 'story'` (not job, poll, comment), not `dead`, not `deleted`,
 * with a title. An item that fails or does not parse is skipped and counted; the source
 * fails only when the id list itself cannot be read, or when not one item could be.
 */

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;
const DEFAULT_BASE = 'https://hacker-news.firebaseio.com';
/** Stories read when a channel's trend sources do not say. */
export const DEFAULT_HN_TOP_N = 30;

export interface HnOptions {
  /** A harness points this at a stub. */
  readonly baseUrl?: string;
  readonly topN?: number;
}

export interface HnStory {
  readonly id: number;
  readonly title: string;
  readonly score: number;
  /** Unix seconds. */
  readonly time: number;
  readonly raw: Record<string, unknown>;
}

export type HnResult =
  | { ok: true; stories: HnStory[]; detail?: string }
  | { ok: false; stories: HnStory[]; detail: string };

const TopIds = z.array(z.number().int().positive()).max(1000);
// `null` is what the API returns for an id that does not exist; parsed as a skip, not a failure.
const Item = z
  .object({
    id: z.number().int().positive(),
    type: z.string(),
    title: z.string().max(500).optional(),
    score: z.number().int().optional(),
    time: z.number().int().positive(),
    url: z.string().max(2000).optional(),
    by: z.string().max(100).optional(),
    descendants: z.number().int().optional(),
    dead: z.boolean().optional(),
    deleted: z.boolean().optional(),
  })
  .nullable();

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'kiln/0.1 (https://video-pipeline-seven.vercel.app/about)', accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`timed out after ${TIMEOUT_MS / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The top N stories, in rank order. */
export async function fetchHnTop(opts: HnOptions = {}): Promise<HnResult> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const topN = opts.topN ?? DEFAULT_HN_TOP_N;

  let ids: number[];
  try {
    const parsed = TopIds.safeParse(await getJson(`${base}/v0/topstories.json`));
    if (!parsed.success) return { ok: false, stories: [], detail: 'topstories: unexpected response shape — not a list of ids' };
    ids = parsed.data.slice(0, topN);
  } catch (err) {
    return { ok: false, stories: [], detail: `topstories: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (ids.length === 0) return { ok: false, stories: [], detail: 'topstories: the list answered with no ids' };

  const slots: (HnStory | null)[] = new Array(ids.length).fill(null);
  let failed = 0;
  let lastError = '';
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try {
        const parsed = Item.safeParse(await getJson(`${base}/v0/item/${ids[i]}.json`));
        if (!parsed.success) {
          failed++;
          lastError = `item ${ids[i]}: unexpected shape`;
          continue;
        }
        const it = parsed.data;
        if (!it || it.type !== 'story' || it.dead || it.deleted || !it.title || it.score === undefined) continue;
        slots[i] = {
          id: it.id,
          title: it.title,
          score: it.score,
          time: it.time,
          raw: {
            id: it.id,
            title: it.title,
            url: it.url ?? null,
            score: it.score,
            by: it.by ?? null,
            time: it.time,
            descendants: it.descendants ?? null,
            rank: i + 1,
            hn_url: `https://news.ycombinator.com/item?id=${it.id}`,
          },
        };
      } catch (err) {
        failed++;
        lastError = `item ${ids[i]}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));

  const stories = slots.filter((s): s is HnStory => s !== null);
  if (failed === ids.length) return { ok: false, stories, detail: `all ${ids.length} items failed (${lastError})` };
  return failed > 0 ? { ok: true, stories, detail: `${failed} of ${ids.length} items could not be read (${lastError})` } : { ok: true, stories };
}
