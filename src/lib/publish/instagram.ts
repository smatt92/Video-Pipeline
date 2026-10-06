import { z } from 'zod';

import { httpJson } from '../drivers/http';

/**
 * Instagram Reels through the Graph API: container → poll until FINISHED → media_publish.
 *
 * ── Built, and switched off ──────────────────────────────────────────────────
 *
 * CLAUDE.md's current phase forbids auto-publish until Meta app review clears, and the
 * plan's "Instagram posts automatically" is the thing that rule is about. So every
 * function here exists and is driven by a harness against a stub, and the only caller —
 * `publishReel` in `src/lib/bureau/instagram-run.ts` — refuses unless
 * `channel_policy.instagram_publish_enabled` is true. Flipping that column is an approver
 * action (`caps_set`), never something an agent token can reach. Decision 0012.
 *
 * Constraints from Meta's documentation, enforced before any call: 9:16, 5–90 s, a public
 * `video_url` (a presigned GET from the bucket — bytes never pass through Vercel), and the
 * account's rolling publishing limit read from `content_publishing_limit` rather than
 * assumed, because the two figures in circulation (25 and 100) disagree.
 *
 * Unverified against a real account — 0008 §B4.
 */

export const GRAPH_BASE = 'https://graph.facebook.com/v23.0';

export const REEL_MIN_S = 5;
export const REEL_MAX_S = 90;

const Created = z.object({ id: z.string().min(1) });
const ContainerStatus = z.object({
  status_code: z.enum(['EXPIRED', 'ERROR', 'FINISHED', 'IN_PROGRESS', 'PUBLISHED']),
  status: z.string().optional(),
});
const Limit = z.object({
  data: z.array(
    z.object({
      quota_usage: z.number(),
      config: z.object({ quota_total: z.number(), quota_duration: z.number().optional() }).optional(),
    }),
  ),
});

export interface IgCreds {
  igUserId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}

export type IgResult<T> = { ok: true; value: T } | { ok: false; code: string; detail: string };

export function reelPreflight(meta: { width: number; height: number; durationS: number | null }): string | null {
  if (meta.durationS === null) return 'Duration unknown — refusing rather than guessing it fits 5–90 s.';
  if (meta.durationS < REEL_MIN_S || meta.durationS > REEL_MAX_S) {
    return `Reels via the API must be ${REEL_MIN_S}–${REEL_MAX_S} s; this is ${meta.durationS} s.`;
  }
  if (meta.width * 16 !== meta.height * 9) return `Reels must be 9:16; this is ${meta.width}×${meta.height}.`;
  return null;
}

export async function publishingHeadroom(c: IgCreds): Promise<IgResult<{ used: number; total: number }>> {
  const url = `${GRAPH_BASE}/${encodeURIComponent(c.igUserId)}/content_publishing_limit?fields=quota_usage,config`;
  const r = await httpJson(url, { headers: { authorization: `Bearer ${c.accessToken}` }, fetchImpl: c.fetchImpl });
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  const p = Limit.safeParse(r.json);
  if (!p.success || !p.data.data[0]) return { ok: false, code: 'upstream', detail: 'Unreadable publishing limit.' };
  const row = p.data.data[0];
  if (!row.config) return { ok: false, code: 'upstream', detail: 'Limit response carried no quota_total.' };
  return { ok: true, value: { used: row.quota_usage, total: row.config.quota_total } };
}

export async function createReelContainer(
  c: IgCreds,
  input: { videoUrl: string; caption: string; shareToFeed?: boolean },
): Promise<IgResult<string>> {
  const body = new URLSearchParams({
    media_type: 'REELS',
    video_url: input.videoUrl,
    caption: input.caption,
    share_to_feed: String(input.shareToFeed ?? true),
  });
  const r = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(c.igUserId)}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.accessToken}` },
    body,
    fetchImpl: c.fetchImpl,
  });
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  const p = Created.safeParse(r.json);
  return p.success ? { ok: true, value: p.data.id } : { ok: false, code: 'upstream', detail: 'No container id.' };
}

export async function containerStatus(c: IgCreds, containerId: string) {
  const r = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(containerId)}?fields=status_code,status`, {
    headers: { authorization: `Bearer ${c.accessToken}` },
    fetchImpl: c.fetchImpl,
  });
  if (!r.ok) return { ok: false as const, code: r.code, detail: r.detail };
  const p = ContainerStatus.safeParse(r.json);
  return p.success
    ? { ok: true as const, value: p.data }
    : { ok: false as const, code: 'upstream', detail: 'Unreadable container status.' };
}

export async function publishContainer(c: IgCreds, containerId: string): Promise<IgResult<string>> {
  const r = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(c.igUserId)}/media_publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.accessToken}` },
    body: new URLSearchParams({ creation_id: containerId }),
    fetchImpl: c.fetchImpl,
  });
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  const p = Created.safeParse(r.json);
  return p.success ? { ok: true, value: p.data.id } : { ok: false, code: 'upstream', detail: 'No media id.' };
}

/** Settings probe: reads the account's username. */
export async function probeInstagram(igUserId: string | undefined, token: string | undefined) {
  if (!igUserId || !token) return { passed: false, detail: 'Account id and token are both required.' };
  const r = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(igUserId)}?fields=username`, {
    headers: { authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  return r.ok ? { passed: true, detail: 'Account read.' } : { passed: false, detail: r.detail };
}

// ── Insights (Sprint 6) ─────────────────────────────────────────────────────
// Reel metrics have been renamed by the vendor more than once (plays → views); every metric
// the response omits is null, never 0. Never called from this environment.
const Insights = z.object({
  data: z.array(z.object({ name: z.string(), values: z.array(z.object({ value: z.number() })).optional(), total_value: z.object({ value: z.number() }).optional() })),
});

export async function reelInsights(c: IgCreds, mediaId: string): Promise<IgResult<Record<string, number | null>>> {
  const metrics = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'ig_reels_avg_watch_time'];
  const url = `${GRAPH_BASE}/${encodeURIComponent(mediaId)}/insights?metric=${metrics.join(',')}`;
  const r = await httpJson(url, { headers: { authorization: `Bearer ${c.accessToken}` }, fetchImpl: c.fetchImpl });
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  const p = Insights.safeParse(r.json);
  if (!p.success) return { ok: false, code: 'upstream', detail: 'Unreadable insights.' };
  const out: Record<string, number | null> = Object.fromEntries(metrics.map((m) => [m, null]));
  for (const d of p.data.data) out[d.name] = d.total_value?.value ?? d.values?.[0]?.value ?? null;
  return { ok: true, value: out };
}
