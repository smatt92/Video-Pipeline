import { publishTargets } from '../channels/list';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { usability } from '../integrations/verify';
import { containerStatus, createReelContainer, mediaPermalink, publishContainer, publishingHeadroom, reelPreflight, type IgCreds } from './instagram';
import { instagramShortcode } from './instagram-bundle';

/**
 * Post one Instagram Reel publication: container → status until FINISHED → media_publish →
 * permalink. Decision 0023 (accounts we own, Standard Access). Every refusal is here, not in
 * the Trigger tasks that call it (26-ig-post for "Publish now", 23-ig-publish for the slot),
 * so `verify:ig-publish` reaches all of them.
 *
 * ── Gates, in order ──────────────────────────────────────────────────────────
 *
 * The row is `scheduled` only through `bureau_mark_scheduled` (review pass, kill switch, daily
 * cap — the database). Here, before anything is created at Meta: the channel's
 * `instagram_publish_enabled` and kill switch, its Instagram target enabled, the integration
 * verified (`usability`), the publishing limit read from the account, the render's length and
 * shape. Then the CLAIM: `scheduled → uploading` as a compare-and-set, which
 * enforce_review_pass inspects again, and which only one caller can win — the slot cron and
 * a "Publish now" run cannot both post the same row.
 *
 * ── Never twice ──────────────────────────────────────────────────────────────
 *
 * Progress is written to `bundle.publish` as it happens: the container id once created, a
 * `publishing_at` mark immediately before media_publish, the media id the moment it returns.
 * A replay re-uses a FINISHED container instead of making a second; one that finds a
 * `publishing_at` with no media id — the process died between the call and the write —
 * refuses, because Meta may already have posted it and an audience would see two. That row
 * is reconciled by a person (Mark posted, with the permalink), never by a retry.
 *
 * ── Why this polls (CLAUDE.md rule 4) ─────────────────────────────────────────
 *
 * Meta offers no webhook for container processing; its guide says to query the status "once
 * per minute, for no more than 5 minutes". So the wait is bounded to exactly that and the
 * sleep is injected — the task passes Trigger's `wait.for`, which checkpoints instead of
 * holding a worker. A container still IN_PROGRESS after it fails the row with that reason.
 *
 * Free at Meta: no cost_ledger row (rule 5 covers calls that cost money).
 */

/** Seconds before each status check: once a minute, five checks, ≈ 5 min (Meta's guidance). */
export const CONTAINER_CHECKS_S = [60, 60, 60, 60, 60] as const;
/** How long the presigned video and cover URLs live: Meta fetches them while processing. */
export const MEDIA_URL_TTL_S = 3 * 3600;

type PublishMark = { container_id?: string; container_at?: string; publishing_at?: string; media_id?: string; error?: string };

export interface ReelDeps {
  /** Presigned GET for a bucket key (worker side). */
  presign(key: string, expiresIn: number): Promise<string>;
  /** Render facts for preflight. */
  render(renderId: string): Promise<{ key: string; width: number; height: number; durationS: number | null }>;
  sleep?: (s: number) => Promise<void>;
  now?: () => Date;
}

export type ReelOutcome =
  | { ok: true; publicationId: string; mediaId: string; permalink: string | null; reused: boolean }
  | { ok: false; publicationId: string; code: string; detail: string };

async function setMark(db: Db, id: string, bundle: Record<string, unknown>, mark: PublishMark) {
  const next = { ...bundle, publish: { ...((bundle.publish as PublishMark | undefined) ?? {}), ...mark } };
  await db.from('publications').update({ bundle: next as unknown as Json }).eq('id', id);
  return next;
}

/** Can this channel post Reels from Kiln right now? The predicate Ready shows and publishReel enforces. */
export async function instagramPublishReadiness(db: Db, channelId: string): Promise<{ ready: true } | { ready: false; reason: string }> {
  const { data: pol } = await db.from('channel_policy').select('instagram_publish_enabled, kill_switch').eq('channel_id', channelId).maybeSingle();
  if (!pol) return { ready: false, reason: 'the channel has no policy row' };
  if (pol.kill_switch) return { ready: false, reason: 'the kill switch is on' };
  if (!pol.instagram_publish_enabled) return { ready: false, reason: 'Instagram publishing is off for this channel (channel_policy.instagram_publish_enabled; caps_set turns it on)' };
  const { targets } = await publishTargets(db, channelId);
  if (!targets.some((t) => t.platform === 'instagram' && t.enabled)) return { ready: false, reason: 'Instagram is not an enabled publish target for this channel' };
  const use = await usability(db, 'instagram');
  if (!use.usable) return { ready: false, reason: `the Instagram integration cannot be used: ${use.reason}` };
  return { ready: true };
}

export async function publishReel(db: Db, publicationId: string, creds: IgCreds, deps: ReelDeps): Promise<ReelOutcome> {
  const sleep = deps.sleep ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000)));
  const now = deps.now ?? (() => new Date());
  const refuse = (code: string, detail: string): ReelOutcome => ({ ok: false, publicationId, code, detail });
  const failRow = async (code: string, detail: string, bundle: Record<string, unknown>): Promise<ReelOutcome> => {
    await db.from('publications').update({ status: 'failed', error_detail: `${code}: ${detail}`.slice(0, 1000), bundle: { ...bundle, publish: { ...((bundle.publish as PublishMark | undefined) ?? {}), error: detail.slice(0, 500) } } as unknown as Json }).eq('id', publicationId);
    return refuse(code, detail);
  };

  const { data: pub } = await db.from('publications').select('id, channel_id, platform, status, render_id, bundle, description, scheduled_for, external_url').eq('id', publicationId).maybeSingle();
  if (!pub) return refuse('no_such_publication', `No publication ${publicationId}.`);
  if (pub.platform !== 'instagram') return refuse('wrong_platform', 'This publication is not an Instagram Reel.');
  let bundle = (pub.bundle ?? {}) as Record<string, unknown>;
  const mark = (bundle.publish ?? {}) as PublishMark;
  if (pub.status === 'live') return refuse('already_live', `Already posted${pub.external_url ? ` at ${pub.external_url}` : ''}. Refusing rather than posting it twice.`);
  if (mark.media_id) return refuse('already_published', `Meta returned media ${mark.media_id} for this publication already; reconcile the row (Mark posted) rather than posting again.`);
  if (mark.publishing_at) {
    return refuse('maybe_published', `media_publish was called at ${mark.publishing_at} and its answer was never recorded — it may be live on the account. Check Instagram, then Mark posted with the permalink. Not retried: an audience would see two.`);
  }
  if (pub.status !== 'scheduled') return refuse('not_scheduled', `The Reel is ${pub.status}; it is posted only once scheduled through the review gate (Publish now / at the slot on Ready).`);
  if (pub.scheduled_for && new Date(pub.scheduled_for).getTime() > now().getTime() + 60_000) return refuse('not_due', `Scheduled for ${pub.scheduled_for}; not due yet.`);

  const ready = await instagramPublishReadiness(db, pub.channel_id);
  if (!ready.ready) return refuse('disabled', ready.reason);

  const head = await publishingHeadroom(creds);
  if (!head.ok) return refuse('limit_unreadable', `The publishing limit could not be read: ${head.detail}`);
  if (head.value.used >= head.value.total) return refuse('limit_reached', `Publishing limit reached (${head.value.used}/${head.value.total} in 24 h); it stays scheduled.`);

  const render = await deps.render(pub.render_id);
  const pre = reelPreflight(render);
  if (pre) return failRow('preflight', pre, bundle);

  // The claim. A compare-and-set on status: only one caller moves scheduled → uploading, and
  // enforce_review_pass inspects the move again.
  const { data: claimed, error: claimErr } = await db.from('publications').update({ status: 'uploading', upload_started_at: now().toISOString() }).eq('id', publicationId).eq('status', 'scheduled').select('id');
  if (claimErr) return refuse('gate', `Refused by the publish gates: ${claimErr.message}`);
  if (!claimed?.length) return refuse('claimed', 'Another run is already posting this Reel.');

  let containerId = mark.container_id ?? null;
  if (containerId) {
    const s = await containerStatus(creds, containerId);
    if (!s.ok || s.value.status_code === 'EXPIRED' || s.value.status_code === 'ERROR') containerId = null;
    else if (s.value.status_code === 'PUBLISHED') return failRow('maybe_published', `Container ${containerId} is already PUBLISHED at Meta; reconcile with Mark posted rather than posting again.`, bundle);
  }
  if (!containerId) {
    const caption = typeof bundle.caption === 'string' ? bundle.caption : (pub.description ?? '');
    const files = (bundle.files ?? {}) as Record<string, string | null>;
    const videoUrl = await deps.presign(render.key, MEDIA_URL_TTL_S);
    const coverUrl = files.cover_jpg ? await deps.presign(files.cover_jpg, MEDIA_URL_TTL_S) : null;
    const c = await createReelContainer(creds, { videoUrl, caption: caption.slice(0, 2200), shareToFeed: true, coverUrl });
    if (!c.ok) return failRow(c.code, `Meta refused the container: ${c.detail}`, bundle);
    containerId = c.value;
    bundle = await setMark(db, publicationId, bundle, { container_id: containerId, container_at: now().toISOString() });
  }

  let finished = false;
  let last = 'IN_PROGRESS';
  for (const wait of CONTAINER_CHECKS_S) {
    const s = await containerStatus(creds, containerId);
    if (s.ok) {
      last = s.value.status_code;
      if (last === 'FINISHED') {
        finished = true;
        break;
      }
      if (last === 'ERROR' || last === 'EXPIRED') {
        // A dead container is never re-used: forget it, so Publish again makes a fresh one.
        const { container_id: _dead, ...rest } = (bundle.publish ?? {}) as PublishMark;
        void _dead;
        return failRow('container_error', `Meta could not process the video (${last}): ${s.value.status ?? 'no message'}`, { ...bundle, publish: rest });
      }
      if (last === 'PUBLISHED') return failRow('maybe_published', `Container ${containerId} is already PUBLISHED; reconcile with Mark posted.`, bundle);
    }
    await sleep(wait);
  }
  if (!finished) {
    const s = await containerStatus(creds, containerId);
    if (s.ok && s.value.status_code === 'FINISHED') finished = true;
    else return failRow('container_timeout', `The container was still ${s.ok ? s.value.status_code : last} after ≈5 min of checks (Meta: once a minute, at most 5 minutes). Publish again from Ready to re-use it.`, bundle);
  }

  bundle = await setMark(db, publicationId, bundle, { publishing_at: now().toISOString() });
  const published = await publishContainer(creds, containerId);
  if (!published.ok) {
    // A refused publish posted nothing: clear the mark so a later attempt may try again.
    const { publishing_at: _drop, ...rest } = (bundle.publish ?? {}) as PublishMark;
    void _drop;
    bundle = { ...bundle, publish: rest };
    return failRow(published.code, `Meta refused media_publish: ${published.detail}`, bundle);
  }
  bundle = await setMark(db, publicationId, bundle, { media_id: published.value });

  const link = await mediaPermalink(creds, published.value);
  const permalink = link.ok ? link.value.permalink : null;
  const shortcode = (link.ok ? link.value.shortcode : null) ?? (permalink ? instagramShortcode(permalink) : null);
  // The same fields Mark posted writes (permalink in external_url, shortcode in
  // external_post_id), so Metrics finds an API post exactly as it finds a hand-posted one.
  const { error: liveErr } = await db
    .from('publications')
    .update({ status: 'live', published_at: now().toISOString(), external_url: permalink, external_post_id: shortcode ?? published.value, error_detail: link.ok ? null : `posted; permalink not read: ${link.detail}` })
    .eq('id', publicationId);
  if (liveErr) return refuse('published_but_unrecorded', `Posted as media ${published.value}, but the row could not be updated: ${liveErr.message}. Do not publish again — reconcile the row.`);
  return { ok: true, publicationId, mediaId: published.value, permalink, reused: Boolean(mark.container_id) };
}

/** The slot cron (23-ig-publish): every scheduled Reel that is due, one at a time. */
export async function publishDueReels(db: Db, creds: IgCreds, deps: ReelDeps): Promise<ReelOutcome[]> {
  const now = (deps.now ?? (() => new Date()))();
  const { data: due } = await db.from('publications').select('id').eq('platform', 'instagram').eq('status', 'scheduled').lte('scheduled_for', now.toISOString()).order('scheduled_for');
  const out: ReelOutcome[] = [];
  for (const p of due ?? []) out.push(await publishReel(db, p.id, creds, deps));
  return out;
}
