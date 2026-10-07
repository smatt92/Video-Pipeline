import { z } from 'zod';

import { httpJson } from '../drivers/http';

/**
 * Instagram Reels through the Graph API (Facebook Login for Business, graph.facebook.com):
 * container → status until FINISHED → media_publish → permalink.
 *
 * ── On, for accounts we own (decision 0023) ──────────────────────────────────
 *
 * Meta's Instagram Platform overview (read 07-Oct-2026): "If your app only serves your
 * Instagram professional account or an account you manage, Standard Access is all your app
 * needs"; App Review and Business Verification are for Advanced Access, i.e. accounts you do
 * not own. So publishing to the channel's own account needs no review. It is still gated:
 * `publishReel` (ig-run.ts) refuses unless `channel_policy.instagram_publish_enabled`, the
 * channel's Instagram target is enabled and the integration has verified, and the row only
 * moves to `scheduled` through `bureau_mark_scheduled` — enforce_review_pass and
 * enforce_channel_policy in the database, never bypassed.
 *
 * Every endpoint and field below was checked against Meta's docs on 07-Oct-2026
 * (content-publishing guide; IG User /media and IG Media references): REELS containers take
 * `video_url` and `cover_url` from a public server (a presigned bucket GET — bytes never pass
 * through Vercel), `cover_url` wins over `thumb_offset`; container `status_code` is one of
 * EXPIRED / ERROR / FINISHED / IN_PROGRESS / PUBLISHED; "100 API-published posts within a
 * 24-hour moving period", read from `content_publishing_limit` rather than assumed; Reels are
 * 3 s – 15 min, ≤ 300 MB, 9:16 recommended; IG Media exposes `permalink` and `shortcode`.
 *
 * Unverified against a real account — 0008 §28.
 */

/** The version Meta's examples use as of 07-Oct-2026. */
export const GRAPH_BASE = 'https://graph.facebook.com/v25.0';

/** Meta, IG User /media reference (07-Oct-2026): Reels 3 seconds minimum, 15 minutes maximum. */
export const REEL_MIN_S = 3;
export const REEL_MAX_S = 900;

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
  input: { videoUrl: string; caption: string; shareToFeed?: boolean; coverUrl?: string | null },
): Promise<IgResult<string>> {
  const body = new URLSearchParams({
    media_type: 'REELS',
    video_url: input.videoUrl,
    caption: input.caption,
    share_to_feed: String(input.shareToFeed ?? true),
    // Absent → Meta uses the first frame (thumb_offset defaults to 0).
    ...(input.coverUrl ? { cover_url: input.coverUrl } : {}),
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

const Permalink = z.object({ id: z.string(), permalink: z.string().url().optional(), shortcode: z.string().optional() });

/** The published Reel's permalink and shortcode (IG Media fields), read back after media_publish. */
export async function mediaPermalink(c: IgCreds, mediaId: string): Promise<IgResult<{ permalink: string | null; shortcode: string | null }>> {
  const r = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(mediaId)}?fields=id,permalink,shortcode`, { headers: { authorization: `Bearer ${c.accessToken}` }, fetchImpl: c.fetchImpl });
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
  const p = Permalink.safeParse(r.json);
  return p.success ? { ok: true, value: { permalink: p.data.permalink ?? null, shortcode: p.data.shortcode ?? null } } : { ok: false, code: 'upstream', detail: 'Unreadable media fields.' };
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

/**
 * Settings probe (Save and test) — read-only, three checks; nothing is posted.
 *
 *   credentials  GET /{ig-user-id}?fields=id,username — the token reads the account. Only a
 *                professional (Business or Creator) account has an IG User node on the Graph
 *                API, so a personal account fails here, by name.
 *   channel      GET /me/accounts?fields=name,instagram_business_account{id,username} — the
 *                account is linked to a Facebook Page this token can see (the Facebook Login
 *                path decision 0020 submits for), and, when the channel's Instagram target
 *                names an account id, it is that one.
 *   publish      GET /{ig-user-id}/content_publishing_limit — readable only with
 *                instagram_content_publish, so it proves the token can publish (decision
 *                0023) without posting, and reports the 24-hour headroom.
 */
const IgUser = z.object({ id: z.string(), username: z.string().optional() });
const Pages = z.object({
  data: z.array(z.object({ name: z.string().optional(), instagram_business_account: z.object({ id: z.string(), username: z.string().optional() }).optional() })),
});

export async function probeInstagram(
  igUserId: string | undefined,
  token: string | undefined,
  opts: { expectedAccountId?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<{ name: 'credentials' | 'channel' | 'publish'; passed: boolean; required: boolean; detail: string }[]> {
  if (!igUserId || !token) {
    return [{ name: 'credentials', passed: false, required: true, detail: 'Account id and token are both required.' }];
  }
  const headers = { authorization: `Bearer ${token}` };
  const me = await httpJson(`${GRAPH_BASE}/${encodeURIComponent(igUserId)}?fields=id,username`, { headers, timeoutMs: 15_000, fetchImpl: opts.fetchImpl });
  if (!me.ok) {
    return [{ name: 'credentials', passed: false, required: true, detail: `${me.detail} — a personal account has no Graph API node; switch it to Business or Creator and link it to a Facebook Page.` }];
  }
  const user = IgUser.safeParse(me.json);
  if (!user.success) return [{ name: 'credentials', passed: false, required: true, detail: 'Unreadable account response.' }];
  const username = user.data.username ?? '(no username returned)';
  const checks: { name: 'credentials' | 'channel' | 'publish'; passed: boolean; required: boolean; detail: string }[] = [
    { name: 'credentials', passed: true, required: true, detail: `Account ${user.data.id} (@${username}) read.` },
  ];

  const pages = await httpJson(`${GRAPH_BASE}/me/accounts?fields=name,instagram_business_account%7Bid,username%7D`, { headers, timeoutMs: 15_000, fetchImpl: opts.fetchImpl });
  const parsed = pages.ok ? Pages.safeParse(pages.json) : null;
  if (!pages.ok || !parsed?.success) {
    checks.push({ name: 'channel', passed: false, required: true, detail: pages.ok ? 'Unreadable page list.' : `${pages.detail} — the token needs pages_show_list to read the linked Page.` });
    return checks;
  }
  const page = parsed.data.data.find((p) => p.instagram_business_account?.id === user.data.id);
  if (!page) {
    checks.push({ name: 'channel', passed: false, required: true, detail: `@${username} is not linked to any Facebook Page this token can see. Link it in Instagram → Settings → Accounts Center, or grant the Page to the app.` });
    return checks;
  }
  if (opts.expectedAccountId && opts.expectedAccountId !== user.data.id) {
    checks.push({ name: 'channel', passed: false, required: true, detail: `The token reads @${username} (${user.data.id}), but the active channel's Instagram target is ${opts.expectedAccountId}.` });
    return checks;
  }
  checks.push({ name: 'channel', passed: true, required: true, detail: `@${username} is linked to the Page "${page.name ?? '(unnamed)'}"${opts.expectedAccountId ? ' and is the active channel\'s target' : ' (no account id on the channel target to compare)'}.` });
  const head = await publishingHeadroom({ igUserId, accessToken: token, fetchImpl: opts.fetchImpl });
  checks.push(
    head.ok
      ? { name: 'publish', passed: true, required: true, detail: `Can publish: ${head.value.used} of ${head.value.total} API posts used in the last 24 h.` }
      : { name: 'publish', passed: false, required: true, detail: `${head.detail} — the token cannot read the publishing limit; it needs instagram_content_publish (Standard Access is enough for an account you own — decision 0023).` },
  );
  return checks;
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
