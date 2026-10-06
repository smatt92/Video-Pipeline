import { z } from 'zod';

import { httpJson } from '../drivers/http';

/**
 * YouTube Analytics (v2 reports) and Data API comment threads, for the Bureau metrics loop.
 *
 * ** NEVER CALLED from this environment ** (egress); shapes from the public reference, Zod-
 * parsed. The Analytics API needs the `yt-analytics.readonly` scope on the refresh token
 * (Settings → Integrations → YouTube; re-consent if the token was minted upload-only) and has
 * its own quota, separate from the Data API's 10,000 units — so only comment reads go through
 * the unit ledger (`commentThreads.list`, 1 unit).
 *
 * "Viewed vs swiped away" is not a report metric as of writing; it arrives by Studio CSV
 * import (src/lib/bureau/studio-csv.ts). Every metric the report does not return is null.
 */

const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const DATA_API = 'https://www.googleapis.com/youtube/v3';

export const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
export const SHORTS_METRICS = ['views', 'engagedViews', 'averageViewPercentage', 'subscribersGained'] as const;

const Report = z.object({
  columnHeaders: z.array(z.object({ name: z.string() })),
  rows: z.array(z.array(z.union([z.number(), z.string()]))).optional(),
});

export interface ShortsMetrics {
  views: number | null;
  engagedViews: number | null;
  averageViewPercentage: number | null;
  subscribersGained: number | null;
}

export async function shortsMetrics(input: {
  accessToken: string;
  videoId: string;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; metrics: ShortsMetrics; raw: unknown } | { ok: false; code: string; detail: string }> {
  const q = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: input.startDate,
    endDate: input.endDate,
    metrics: SHORTS_METRICS.join(','),
    filters: `video==${input.videoId}`,
  });
  const r = await httpJson(`${ANALYTICS}?${q}`, { headers: { authorization: `Bearer ${input.accessToken}` }, fetchImpl: input.fetchImpl, timeoutMs: 20_000 });
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  const p = Report.safeParse(r.json);
  if (!p.success) return { ok: false, code: 'upstream', detail: 'the report did not match the documented shape' };
  const row = p.data.rows?.[0];
  const at = (name: string) => {
    const i = p.data.columnHeaders.findIndex((h) => h.name === name);
    if (i < 0 || !row) return null;
    const v = Number(row[i]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    ok: true,
    metrics: { views: at('views'), engagedViews: at('engagedViews'), averageViewPercentage: at('averageViewPercentage'), subscribersGained: at('subscribersGained') },
    raw: r.json,
  };
}

const Threads = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        totalReplyCount: z.number().optional(),
        isPublic: z.boolean().optional(),
        topLevelComment: z.object({
          id: z.string(),
          snippet: z.object({
            textOriginal: z.string(),
            authorDisplayName: z.string().optional(),
            likeCount: z.number().optional(),
            publishedAt: z.string().optional(),
          }),
        }),
      }),
    }),
  ),
});

export interface FetchedComment {
  externalId: string;
  author: string | null;
  body: string;
  likes: number | null;
  replies: number | null;
  publishedAt: string | null;
  isPublic: boolean;
}

export async function commentThreads(input: {
  accessToken: string;
  videoId: string;
  pageToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; comments: FetchedComment[]; next: string | null } | { ok: false; code: string; detail: string }> {
  const q = new URLSearchParams({ part: 'snippet', videoId: input.videoId, maxResults: '100', order: 'time', textFormat: 'plainText' });
  if (input.pageToken) q.set('pageToken', input.pageToken);
  const r = await httpJson(`${DATA_API}/commentThreads?${q}`, { headers: { authorization: `Bearer ${input.accessToken}` }, fetchImpl: input.fetchImpl, timeoutMs: 20_000 });
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  const p = Threads.safeParse(r.json);
  if (!p.success) return { ok: false, code: 'upstream', detail: 'commentThreads did not match the documented shape' };
  return {
    ok: true,
    next: p.data.nextPageToken ?? null,
    comments: p.data.items.map((t) => ({
      externalId: t.snippet.topLevelComment.id,
      author: t.snippet.topLevelComment.snippet.authorDisplayName ?? null,
      body: t.snippet.topLevelComment.snippet.textOriginal,
      likes: t.snippet.topLevelComment.snippet.likeCount ?? null,
      replies: t.snippet.totalReplyCount ?? null,
      publishedAt: t.snippet.topLevelComment.snippet.publishedAt ?? null,
      // Threads returned by the API are public by construction; the flag is kept explicit.
      isPublic: t.snippet.isPublic ?? true,
    })),
  };
}

/** "https://youtube.com/shorts/ID", "https://youtu.be/ID", "watch?v=ID" or a bare id → id. */
export function youtubeVideoId(urlOrId: string): string | null {
  const s = urlOrId.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const m = /(?:shorts\/|youtu\.be\/|[?&]v=|embed\/)([A-Za-z0-9_-]{11})/.exec(s);
  return m ? m[1] : null;
}
