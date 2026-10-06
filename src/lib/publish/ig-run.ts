import type { Db } from '../db/server';
import { containerStatus, createReelContainer, publishContainer, publishingHeadroom, reelPreflight, type IgCreds } from './instagram';

/**
 * Post the Reels mirrors that are due: container → poll until FINISHED → media_publish.
 *
 * Refuses outright while `channel_policy.instagram_publish_enabled` is false (CLAUDE.md
 * current phase). Respects the account's publishing limit by reading the headroom first, and
 * the 5–90 s / 9:16 rules by preflight on the render, both before anything is created.
 * The DB gates already ran when the row became `scheduled` (afterBundle); this moves it to
 * `uploading` then `live`, which they inspect again.
 */
export async function publishDueReels(
  db: Db,
  creds: IgCreds,
  deps: { videoUrlFor(renderId: string): Promise<{ url: string; width: number; height: number; durationS: number | null }>; sleep?: (ms: number) => Promise<void>; now?: () => Date },
) {
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { data: due } = await db
    .from('publications')
    .select('id, channel_id, render_id, title, description, bundle, scheduled_for')
    .eq('platform', 'instagram')
    .eq('status', 'scheduled')
    .lte('scheduled_for', now.toISOString());
  const results: { id: string; outcome: string }[] = [];
  for (const p of due ?? []) {
    const { data: pol } = await db.from('channel_policy').select('instagram_publish_enabled, kill_switch').eq('channel_id', p.channel_id).single();
    if (!pol?.instagram_publish_enabled || pol.kill_switch) {
      results.push({ id: p.id, outcome: 'refused: instagram publishing is disabled (or the kill switch is on)' });
      continue;
    }
    const head = await publishingHeadroom(creds);
    if (!head.ok || head.value.used >= head.value.total) {
      results.push({ id: p.id, outcome: head.ok ? `refused: publishing limit reached (${head.value.used}/${head.value.total})` : `refused: ${head.detail}` });
      continue;
    }
    const video = await deps.videoUrlFor(p.render_id);
    const pre = reelPreflight(video);
    if (pre) {
      await db.from('publications').update({ status: 'failed', error_detail: pre }).eq('id', p.id);
      results.push({ id: p.id, outcome: `failed: ${pre}` });
      continue;
    }
    const caption = [p.title, '', (p.description ?? '').split('\n#')[0]].join('\n').slice(0, 2000);
    const upd = await db.from('publications').update({ status: 'uploading' }).eq('id', p.id);
    if (upd.error) {
      results.push({ id: p.id, outcome: `refused by the publish gates: ${upd.error.message}` });
      continue;
    }
    const c = await createReelContainer(creds, { videoUrl: video.url, caption, shareToFeed: true });
    if (!c.ok) {
      await db.from('publications').update({ status: 'failed', error_detail: `${c.code}: ${c.detail}` }).eq('id', p.id);
      results.push({ id: p.id, outcome: `failed: ${c.detail}` });
      continue;
    }
    let finished = false;
    for (let i = 0; i < 40 && !finished; i++) {
      const s = await containerStatus(creds, c.value);
      if (s.ok && s.value.status_code === 'FINISHED') finished = true;
      else if (s.ok && (s.value.status_code === 'ERROR' || s.value.status_code === 'EXPIRED')) break;
      else await sleep(15_000);
    }
    if (!finished) {
      await db.from('publications').update({ status: 'failed', error_detail: 'container never reached FINISHED' }).eq('id', p.id);
      results.push({ id: p.id, outcome: 'failed: container not FINISHED' });
      continue;
    }
    const pubd = await publishContainer(creds, c.value);
    if (!pubd.ok) {
      await db.from('publications').update({ status: 'failed', error_detail: `${pubd.code}: ${pubd.detail}` }).eq('id', p.id);
      results.push({ id: p.id, outcome: `failed: ${pubd.detail}` });
      continue;
    }
    await db.from('publications').update({ status: 'live', external_post_id: pubd.value, published_at: new Date().toISOString() }).eq('id', p.id);
    results.push({ id: p.id, outcome: `live: ${pubd.value}` });
  }
  return results;
}
