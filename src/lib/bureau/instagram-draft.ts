import { publishTargets } from '../channels/list';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { buildInstagramVariant, instagramShortcode, type InstagramVariant } from '../publish/instagram-bundle';
import { getBible } from './bible';
import { requireApprover } from './control';
import type { BureauToken } from './tokens';

/**
 * The Instagram half of a publish bundle: a `publications` row with platform 'instagram',
 * status 'draft', the same render and review as the YouTube row, and the Reels variant in
 * `bundle`. One per YouTube bundle (`idempotency_key = ig:<youtube publication id>` — the same
 * key afterBundle's switched-off auto path uses, so the two can never make two rows).
 *
 * Made when the bundle is built (20-episode), and from Ready to schedule for a bundle that
 * predates this. Refused, by name, for a channel without an enabled Instagram target.
 *
 * Nothing here publishes. Decision 0020: manual until Meta app review clears.
 */

export interface DraftDeps {
  /** Worker only: extract the cover still at `atS` and store it; absent → the time is the cover. */
  coverStill?(input: { videoKey: string; atS: number; publicationId: string }): Promise<{ ok: true; key: string } | { ok: false; detail: string }>;
}

export type DraftResult =
  | { ok: true; publicationId: string; created: boolean; variant: InstagramVariant }
  | { ok: false; refused: string };

type YtBundle = { video_key?: string; files?: Record<string, string | null>; pinned_comment?: string | null; slot_time?: string | null; slot_id?: string | null };

export async function buildInstagramDraft(db: Db, youtubePublicationId: string, deps: DraftDeps = {}): Promise<DraftResult> {
  const { data: yt } = await db.from('publications').select('*').eq('id', youtubePublicationId).maybeSingle();
  if (!yt) return { ok: false, refused: `No publication ${youtubePublicationId}.` };
  if (yt.platform !== 'youtube') return { ok: false, refused: 'The Instagram variant is built from the YouTube bundle; this publication is not one.' };

  const { targets } = await publishTargets(db, yt.channel_id);
  const ig = targets.find((t) => t.platform === 'instagram');
  const { data: ch } = await db.from('channels').select('name').eq('id', yt.channel_id).single();
  const channelName = ch?.name ?? 'this channel';
  if (!ig || !ig.enabled) {
    return { ok: false, refused: `${channelName} has no enabled Instagram publish target — add one on Channels (/channels; needs migration 0046).` };
  }

  const key = `ig:${yt.id}`;
  const { data: existing } = await db.from('publications').select('id, bundle').eq('idempotency_key', key).maybeSingle();
  if (existing) return { ok: true, publicationId: existing.id, created: false, variant: existing.bundle as unknown as InstagramVariant };

  const b = (yt.bundle ?? {}) as YtBundle;
  const { data: ep } = yt.episode_id ? await db.from('episodes').select('brief_id').eq('id', yt.episode_id).maybeSingle() : { data: null };
  const { data: brief } = ep?.brief_id ? await db.from('briefs').select('premise, fact, series, pinned_comment').eq('id', ep.brief_id).maybeSingle() : { data: null };
  const { data: render } = await db.from('renders').select('width, height, duration_s').eq('id', yt.render_id).maybeSingle();

  const cb = await getBible(db, yt.channel_id).catch(() => null);
  const series = brief && cb ? cb.series[brief.series as keyof typeof cb.series] : undefined;
  // The cover is the end of the cold open — the frame the series designs to stop a thumb.
  const coldOpen = series?.beat_sheet.find((x) => x.id === 'cold_open');
  const coverFrameS = coldOpen ? coldOpen.end_s : 1;

  const fact = brief?.fact as { claim?: string; source_url?: string } | null | undefined;
  const variant = buildInstagramVariant({
    channelName,
    seriesName: series?.name ?? brief?.series ?? '',
    title: yt.title,
    premise: brief?.premise ?? yt.description ?? '',
    fact: fact?.claim && fact?.source_url ? { claim: fact.claim, source_url: fact.source_url } : null,
    hashtagPool: cb?.bible.publishing?.hashtags ?? [],
    pinnedComment: brief?.pinned_comment ?? b.pinned_comment ?? null,
    // numeric arrives as a string; a duration is far inside a double's exact range.
    render: { width: render?.width ?? 0, height: render?.height ?? 0, durationS: render?.duration_s === null || render?.duration_s === undefined ? null : Number(render.duration_s) },
    coverFrameS,
  });

  let cover: { cover_key: string | null; cover_note: string } = { cover_key: null, cover_note: `pick the frame at ${variant.cover_frame_s.toFixed(1)} s in the app` };
  if (deps.coverStill && b.video_key) {
    const r = await deps.coverStill({ videoKey: b.video_key, atS: variant.cover_frame_s, publicationId: yt.id });
    cover = r.ok ? { cover_key: r.key, cover_note: `still at ${variant.cover_frame_s.toFixed(1)} s` } : { cover_key: null, cover_note: `still not extracted (${r.detail}); pick the frame at ${variant.cover_frame_s.toFixed(1)} s in the app` };
  }

  const bundle = {
    video_key: b.video_key ?? null,
    files: { ...(b.files ?? {}), ...(cover.cover_key ? { cover_jpg: cover.cover_key } : {}) },
    ...variant,
    cover_note: cover.cover_note,
    instagram_account: ig.handle ?? ig.externalId ?? null,
    slot_time: b.slot_time ?? null,
    note: 'Manual until Meta app review clears: post the MP4 as a Reel with this caption, cover and alt text, add the first comment, then Mark posted with the permalink.',
  };
  const { data: row, error } = await db
    .from('publications')
    .insert({
      render_id: yt.render_id,
      channel_id: yt.channel_id,
      review_id: yt.review_id,
      title: yt.title,
      description: variant.caption,
      tags: variant.hashtags,
      made_for_kids: false,
      altered_content_disclosed: yt.altered_content_disclosed,
      platform: 'instagram',
      bundle: bundle as unknown as Json,
      episode_id: yt.episode_id,
      slot_id: yt.slot_id,
      status: 'draft',
      idempotency_key: key,
    })
    .select('id')
    .single();
  if (error || !row) return { ok: false, refused: `Recording the Instagram draft failed: ${error?.message ?? 'no row'}` };
  return { ok: true, publicationId: row.id, created: true, variant };
}

/**
 * "Mark posted" for a Reel posted by hand: the permalink is how metrics find it later. Goes
 * through the same decision function as mark_scheduled (review gate, kill switch, daily cap,
 * authorship log — all in the database), then records the post as live.
 */
export async function markInstagramPosted(
  db: Db,
  token: BureauToken,
  input: { publication_id: string; permalink: string; posted_at: string },
): Promise<{ ok: true; shortcode: string; status: 'live' }> {
  requireApprover(token, 'mark_posted');
  const { data: pub } = await db.from('publications').select('id, channel_id, platform, status').eq('id', input.publication_id).maybeSingle();
  if (!pub || pub.channel_id !== token.channelId) throw new Error('No such publication on this channel.');
  if (pub.platform !== 'instagram') throw new Error('Mark posted is for the Instagram variant; a YouTube bundle uses Mark scheduled.');
  const shortcode = instagramShortcode(input.permalink);
  if (!shortcode) throw new Error('That is not an Instagram Reel permalink (https://www.instagram.com/reel/<code>/).');
  if (pub.status === 'draft') {
    const { error } = await db.rpc('bureau_mark_scheduled', { p_token: token.id, p_publication: pub.id, p_at: input.posted_at });
    if (error) throw new Error(error.message);
  } else if (pub.status !== 'scheduled') {
    throw new Error(`This post is already ${pub.status}.`);
  }
  const { error } = await db
    .from('publications')
    .update({ status: 'live', published_at: input.posted_at, external_url: input.permalink.trim(), external_post_id: shortcode })
    .eq('id', pub.id);
  if (error) throw new Error(error.message);
  return { ok: true, shortcode, status: 'live' };
}

/**
 * Ready → "Publish to Instagram now" / "at the slot" (decision 0023). Approver only. Refused by
 * name unless the channel can post (`instagramPublishReadiness`: the flag, the target, the
 * verified integration). The row moves to `scheduled` through `bureau_mark_scheduled` — the
 * review gate, kill switch, daily cap and authorship log, in the database — and then:
 *   now   the post starts at once (`26-ig-post`, keyed per publication and attempt);
 *   slot  the 15-minute slot cron (`23-ig-publish`) posts it when due.
 * A failed post that never reached media_publish can be published again from here; one that
 * may have posted cannot (publishReel refuses it — reconcile with Mark posted).
 */
export async function requestInstagramPublish(
  db: Db,
  token: BureauToken,
  effects: { startInstagramPost?(publicationId: string, attempt: string): Promise<string | null> },
  input: { publication_id: string; when: 'now' | 'slot'; now?: Date },
): Promise<{ ok: true; status: 'scheduled'; at: string; run_id: string | null }> {
  requireApprover(token, 'instagram_publish');
  const { instagramPublishReadiness } = await import('../publish/ig-run');
  const { data: pub } = await db.from('publications').select('id, channel_id, platform, status, bundle').eq('id', input.publication_id).maybeSingle();
  if (!pub || pub.channel_id !== token.channelId) throw new Error('No such publication on this channel.');
  if (pub.platform !== 'instagram') throw new Error('This is not the Instagram variant.');
  const ready = await instagramPublishReadiness(db, pub.channel_id);
  if (!ready.ready) throw new Error(`Not published: ${ready.reason}.`);
  const bundle = (pub.bundle ?? {}) as { slot_time?: string | null; publish?: { publishing_at?: string; media_id?: string } };
  if (bundle.publish?.media_id || bundle.publish?.publishing_at) throw new Error('This Reel may already be on the account (media_publish was called). Check Instagram and use Mark posted.');
  if (pub.status === 'failed') {
    // Back to draft so the gate function runs again — never straight to scheduled.
    const { error } = await db.from('publications').update({ status: 'draft', error_detail: null }).eq('id', pub.id).eq('status', 'failed');
    if (error) throw new Error(error.message);
  } else if (pub.status !== 'draft') {
    throw new Error(`This Reel is already ${pub.status}.`);
  }
  const now = input.now ?? new Date();
  const at = input.when === 'now' ? now.toISOString() : bundle.slot_time ?? null;
  if (!at) throw new Error('This bundle has no slot time; publish now instead.');
  if (input.when === 'slot' && new Date(at).getTime() < now.getTime()) throw new Error(`The slot (${at}) has passed; publish now instead.`);
  const { error } = await db.rpc('bureau_mark_scheduled', { p_token: token.id, p_publication: pub.id, p_at: at });
  if (error) throw new Error(error.message.replace(/^(conflict|invalid|not_found|scope_denied): /, ''));
  let runId: string | null = null;
  if (input.when === 'now') {
    if (!effects.startInstagramPost) throw new Error('Scheduled for now, but this deployment cannot start the post; the slot cron posts it within 15 minutes.');
    runId = await effects.startInstagramPost(pub.id, String(now.getTime()));
  }
  return { ok: true, status: 'scheduled', at, run_id: runId };
}
