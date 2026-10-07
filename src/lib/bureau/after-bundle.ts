import type { Db } from '../db/server';
import type { Json } from '../db/types';

/**
 * What happens to a bundle once the cut is approved — decided by two flags, both false today.
 *
 *   youtube_api_audited = false  (today)  nothing more: the bundle waits on Ready to schedule;
 *                                         Sahil schedules in Studio and calls mark_scheduled.
 *   youtube_api_audited = true            the publication is scheduled at the slot (both DB
 *                                         gates run) and the upload is started: private now,
 *                                         public at the slot via publishAt (10-publish).
 *   instagram_publish_enabled = true      a mirror Reels publication is created and scheduled
 *                                         at the same slot; 23-ig-publish posts it when due.
 *
 * CLAUDE.md current phase: no auto-publish until Meta app review clears. These paths exist so
 * the flags are the only change needed; while a flag is false this function does nothing for
 * it and says so. Neither path can bypass enforce_review_pass or enforce_channel_policy: the
 * status change below is exactly what those triggers inspect.
 */
export async function afterBundle(
  db: Db,
  publicationId: string,
  deps: { startUpload(publicationId: string): Promise<string | null> },
): Promise<{ youtube: string; instagram: string }> {
  const { data: pub } = await db.from('publications').select('*').eq('id', publicationId).single();
  if (!pub) throw new Error(`publication ${publicationId} not found`);
  const { data: pol } = await db.from('channel_policy').select('youtube_api_audited, instagram_publish_enabled').eq('channel_id', pub.channel_id).single();
  const slot = (pub.bundle as { slot_time?: string | null } | null)?.slot_time ?? null;

  let youtube = 'bundle only — upload API unaudited; schedule in Studio, then mark_scheduled';
  if (pol?.youtube_api_audited) {
    if (!slot) youtube = 'refused: no slot time to schedule at';
    else {
      const { error } = await db.from('publications').update({ status: 'scheduled', scheduled_for: slot }).eq('id', publicationId);
      if (error) youtube = `refused by the publish gates: ${error.message}`;
      else {
        const run = await deps.startUpload(publicationId);
        youtube = `scheduled for ${slot}; upload started (${run ?? 'no run id'})`;
      }
    }
  }

  let instagram = 'off — instagram_publish_enabled is false until Meta app review clears';
  if (pol?.instagram_publish_enabled) {
    if (!slot) instagram = 'refused: no slot time';
    else {
      // The manual Instagram draft (instagram-draft.ts) carries the same idempotency key; when
      // it exists, schedule it rather than inserting a second Reels row for one cut.
      const { data: draft } = await db.from('publications').select('id, status').eq('idempotency_key', `ig:${publicationId}`).maybeSingle();
      const { error } = draft
        ? draft.status === 'draft'
          ? await db.from('publications').update({ status: 'scheduled', scheduled_for: slot }).eq('id', draft.id)
          : { error: { message: `the Reels row is already ${draft.status}` } }
        : await db.from('publications').insert({
        render_id: pub.render_id,
        channel_id: pub.channel_id,
        review_id: pub.review_id,
        title: pub.title,
        description: pub.description,
        tags: pub.tags,
        made_for_kids: false,
        altered_content_disclosed: pub.altered_content_disclosed,
        platform: 'instagram',
        bundle: pub.bundle as Json,
        episode_id: pub.episode_id,
        slot_id: pub.slot_id,
        status: 'scheduled',
        scheduled_for: slot,
        idempotency_key: `ig:${publicationId}`,
        });
      instagram = error ? `refused: ${error.message}` : `Reels mirror scheduled for ${slot}`;
    }
  }
  return { youtube, instagram };
}
