import { LiveRefresh } from '@/components/bureau/live-status';
import { BuildInstagram, CopyButton, MarkPosted, MarkScheduled, PublishInstagram, QueueDubs } from '@/components/bureau/ready-controls';
import { ScreenHeader } from '@/components/shell/screen-header';
import { inr, Note } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Pill } from '@/components/ui/tags';
import { readyBundles } from '@/lib/bureau/read';
import { RUNNING } from '@/lib/bureau/running';
import { requireChannel } from '@/lib/channels/active';
import { publishTargets } from '@/lib/channels/list';
import { serverClient } from '@/lib/db/server';
import { instagramPublishReadiness } from '@/lib/publish/ig-run';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ready' };

type Bundle = { title?: string; description?: string; tags?: string[]; made_for_kids?: boolean; contains_synthetic_media?: boolean; pinned_comment?: string; slot_time?: string | null; alternate_titles?: string[] };
type IgBundle = { caption?: string; hashtags?: string[]; alt_text?: string; first_comment?: string; cover_frame_s?: number; cover_note?: string; reels_api_problem?: string | null; instagram_account?: string | null };
type Row = Awaited<ReturnType<typeof readyBundles>>[number];

const PUB_TONE: Record<string, 'rdy' | 'live' | 'blk' | 'draft'> = { draft: 'rdy', scheduled: 'rdy', uploading: 'rdy', live: 'live', failed: 'blk' };
const PUB_LABEL: Record<string, string> = { draft: 'Ready', scheduled: 'Scheduled', uploading: 'Uploading', live: 'Posted', failed: 'Failed' };

/**
 * Ready to schedule (canvas: Ready, Ready-m) — one card per episode, one section per publish
 * target. YouTube: the upload API is unaudited, so download, paste, schedule in Studio at the
 * slot, then Mark scheduled with the link. Instagram (decision 0023): "Publish now" / "at the
 * slot" when the channel can post (flag, target, verified integration —
 * instagramPublishReadiness); otherwise the manual card stays with the reason — post the MP4
 * as a Reel, then Mark posted with the permalink. The review gate, kill switch and daily cap
 * are checked by the database on both.
 */
export default async function ReadyPage() {
  const channel = await requireChannel();
  const db = serverClient();
  const [bundles, { targets }, igReady, { count: running }] = await Promise.all([
    readyBundles(db, channel.id),
    publishTargets(db, channel.id),
    instagramPublishReadiness(db, channel.id),
    // Episodes the worker is still moving: one of them lands here as a bundle on its own, so
    // the screen keeps itself current while any exists (and stops when none does).
    db.from('episodes').select('id', { count: 'exact', head: true }).eq('channel_id', channel.id).in('status', [...RUNNING]),
  ]);
  // What the post itself wrote: the permalink once live, Meta's reason when it failed.
  const igIds = bundles.filter((b) => b.platform === 'instagram' && b.publication_id).map((b) => b.publication_id!);
  const igRows = igIds.length ? (await db.from('publications').select('id, status, external_url, error_detail').in('id', igIds)).data ?? [] : [];
  const igRow = new Map(igRows.map((r) => [r.id, r]));
  const igTarget = targets.find((t) => t.platform === 'instagram' && t.enabled) ?? null;
  const ytTarget = targets.find((t) => t.platform === 'youtube' && t.enabled) ?? null;

  const groups = new Map<string, { youtube: Row | null; instagram: Row | null }>();
  for (const b of bundles) {
    const k = b.episode_id ?? b.publication_id!;
    const g = groups.get(k) ?? { youtube: null, instagram: null };
    if (b.platform === 'instagram') g.instagram = b;
    else g.youtube = b;
    groups.set(k, g);
  }
  const targetLine =
    [ytTarget ? 'YouTube' : null, igTarget ? `Instagram${igTarget.handle ? ` (${igTarget.handle})` : ''}` : null].filter(Boolean).join(' + ') || 'no publish target';

  return (
    <main className="main">
      <LiveRefresh active={(running ?? 0) > 0 || bundles.some((b) => b.status === 'uploading')} everyMs={15_000} />
      <ScreenHeader
        channel={channel}
        crumb="Ready"
        title="Ready to schedule"
        mobileTitle="Ready"
        sub={`${groups.size} bundle${groups.size === 1 ? '' : 's'} · ${targetLine}`}
        actions={<span className="sm t3">Cut approved → bundle → you upload and schedule → mark it here</span>}
      />
      <Note>
        YouTube is manual until Google’s audit of the upload API clears: download, schedule in Studio, then Mark scheduled. Instagram posts from Kiln to the channel’s own account only — behind the review gate —{' '}
        {igReady.ready ? 'and is on for this channel.' : `but not for this channel yet: ${igReady.reason}. Post by hand and Mark posted until then.`}
      </Note>

      {groups.size === 0 && (
        <div className="empty" style={{ padding: 40 }}>
          <span style={{ color: 'var(--t2)', fontWeight: 500 }}>Nothing ready yet</span>
          <span>An approved cut lands here with its publish bundle.</span>
        </div>
      )}

      {[...groups.entries()].map(([k, g]) => {
        const head = g.youtube ?? g.instagram!;
        const meta = (head.bundle ?? {}) as Bundle;
        const slotTime = meta.slot_time ? new Date(meta.slot_time).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST' : null;
        return (
          <div className="split" key={k}>
            <section className="wide card" aria-label={`${head.slot_id ?? 'bank'} bundle`}>
              <div className="card-h">
                <div className="row" style={{ gap: 10 }}>
                  <span className="chm" aria-hidden="true" />
                  <span className="mono" style={{ fontWeight: 600, fontSize: 16 }}>
                    {head.slot_id ?? 'bank'}
                  </span>
                  <span className="sm t2">{head.title}</span>
                  <Pill tone={PUB_TONE[head.status ?? 'draft'] ?? 'rdy'}>{PUB_LABEL[head.status ?? 'draft'] ?? head.status}</Pill>
                </div>
                <span className="mono xs t3">{slotTime ? `slot ${slotTime}` : 'no slot time'}</span>
              </div>
              <div className="plat">
                <Icon name="publish" />
                <span className="h3">YouTube</span>
                <span className="xs t3">{g.youtube ? PUB_LABEL[g.youtube.status ?? 'draft'] ?? g.youtube.status : 'no bundle'}</span>
              </div>
              {g.youtube ? <YoutubeFields b={g.youtube} /> : <div className="card-b sm t3">No YouTube bundle for this episode.</div>}
              <div className="plat">
                <Icon name="publish" />
                <span className="h3">Instagram Reels</span>
                <span className={`pill nodot ${igReady.ready ? 's-live' : 's-rev'}`}>{igReady.ready ? 'posts from Kiln' : 'manual'}</span>
              </div>
              {g.instagram ? (
                <InstagramFields b={g.instagram} />
              ) : (
                <div className="card-b">
                  {igTarget && g.youtube ? <BuildInstagram youtubePublicationId={g.youtube.publication_id!} /> : <span className="sm t3">{igTarget ? 'No variant yet.' : 'Instagram is not a target for this channel.'}</span>}
                </div>
              )}
            </section>

            <aside className="side">
              <section className="card card-b col" style={{ gap: 12 }}>
                <span className="lbl">Files</span>
                <div className="col" style={{ gap: 8 }}>
                  {head.download_urls.video ? (
                    <a className="btn sm" href={head.download_urls.video}>
                      <Icon name="download" />
                      Video · MP4
                    </a>
                  ) : (
                    <span className="xs t3">Video — not in the bucket yet</span>
                  )}
                  {head.download_urls.captions_srt && (
                    <a className="btn sm" href={head.download_urls.captions_srt}>
                      <Icon name="download" />
                      Captions · SRT
                    </a>
                  )}
                  {head.download_urls.clean_master && (
                    <a className="btn sm" href={head.download_urls.clean_master}>
                      <Icon name="download" />
                      Clean master
                    </a>
                  )}
                  {g.instagram?.download_urls.cover_jpg && (
                    <a className="btn sm" href={g.instagram.download_urls.cover_jpg}>
                      <Icon name="download" />
                      Reel cover still
                    </a>
                  )}
                </div>
                <span className="xs t3">
                  madeForKids: {meta.made_for_kids ? 'Yes' : 'No'} · altered/synthetic: {meta.contains_synthetic_media ? 'Yes' : 'No'}
                </span>
                {head.episode_id && <QueueDubs episodeId={head.episode_id} />}
                {g.youtube && g.youtube.dubs.length > 0 && (
                  <div className="col" style={{ gap: 4 }}>
                    {g.youtube.dubs.map((d) => (
                      <span className="xs" key={d.language}>
                        <span className="mono">{d.language}</span>: {d.audio_url ? <a href={d.audio_url}>audio</a> : 'audio —'} · {d.captions_url ? <a href={d.captions_url}>captions</a> : 'captions —'} ·{' '}
                        {d.cost_inr === null ? 'unpriced' : inr(d.cost_inr)} <span className="t3">({d.cost_label})</span>
                      </span>
                    ))}
                  </div>
                )}
              </section>
              {g.youtube?.status === 'draft' && (
                <section className="card">
                  <div className="card-h">
                    <h2 className="h3">Mark scheduled</h2>
                    <span className="mono xs t3">{slotTime ?? ''}</span>
                  </div>
                  <div className="card-b">
                    <MarkScheduled publicationId={g.youtube.publication_id!} slotTime={meta.slot_time ?? null} />
                  </div>
                </section>
              )}
              {g.instagram && (g.instagram.status === 'draft' || g.instagram.status === 'failed') && igReady.ready && (
                <section className="card">
                  <div className="card-h">
                    <h2 className="h3">Publish · Instagram</h2>
                  </div>
                  <div className="card-b col" style={{ gap: 10 }}>
                    {g.instagram.status === 'failed' && <span className="sm" style={{ color: 'var(--blk-text)' }}>Last attempt failed: {igRow.get(g.instagram.publication_id!)?.error_detail ?? 'no reason recorded'}</span>}
                    <PublishInstagram publicationId={g.instagram.publication_id!} slotTime={((g.instagram.bundle ?? {}) as Bundle).slot_time ?? null} retry={g.instagram.status === 'failed'} />
                  </div>
                </section>
              )}
              {g.instagram && ['scheduled', 'uploading'].includes(g.instagram.status ?? '') && (
                <section className="card card-b">
                  <span className="sm t2">Instagram: {g.instagram.status === 'uploading' ? 'posting now — Meta is processing the video' : `scheduled for ${g.instagram.scheduled_for ? new Date(g.instagram.scheduled_for).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'the slot'}`}.</span>
                </section>
              )}
              {g.instagram?.status === 'live' && igRow.get(g.instagram.publication_id!)?.external_url && (
                <section className="card card-b">
                  <a className="btn sm" href={igRow.get(g.instagram.publication_id!)!.external_url!}>
                    Open the Reel on Instagram
                  </a>
                </section>
              )}
              {g.instagram?.status === 'draft' && (
                <section className="card">
                  <div className="card-h">
                    <h2 className="h3">Mark posted · Instagram</h2>
                  </div>
                  <div className="card-b">
                    <MarkPosted publicationId={g.instagram.publication_id!} />
                  </div>
                </section>
              )}
            </aside>
          </div>
        );
      })}
    </main>
  );
}

function YoutubeFields({ b }: { b: Row }) {
  const meta = (b.bundle ?? {}) as Bundle;
  const tags = meta.tags ?? b.tags ?? [];
  const title = b.title ?? '';
  return (
    <>
      <div className="fld">
        <div className="row sb">
          <span className="lbl">Title · {title.length} / 100</span>
          <CopyButton text={title} label="title" />
        </div>
        <span className="val">{title || '—'}</span>
        {meta.alternate_titles?.length ? <span className="xs t3">alternates: {meta.alternate_titles.join(' · ')}</span> : null}
      </div>
      <div className="fld">
        <div className="row sb">
          <span className="lbl">Description</span>
          <CopyButton text={b.description ?? ''} label="description" />
        </div>
        <span className="val">{b.description || '—'}</span>
      </div>
      <div className="fld">
        <div className="row sb">
          <span className="lbl">Tags</span>
          <CopyButton text={tags.join(', ')} label="tags" />
        </div>
        <div className="row" style={{ gap: 6 }}>
          {tags.length === 0 && <span className="sm t3">—</span>}
          {tags.map((t) => (
            <span className="chip" key={t}>
              #{t.replace(/^#/, '')}
            </span>
          ))}
        </div>
      </div>
      {meta.pinned_comment && (
        <div className="fld">
          <div className="row sb">
            <span className="lbl">Pinned comment</span>
            <CopyButton text={meta.pinned_comment} label="pinned comment" />
          </div>
          <span className="val">{meta.pinned_comment}</span>
        </div>
      )}
    </>
  );
}

function InstagramFields({ b }: { b: Row }) {
  const ig = (b.bundle ?? {}) as IgBundle;
  const caption = ig.caption ?? b.description ?? '';
  return (
    <>
      <div className="fld">
        <div className="row sb">
          <span className="lbl">
            Caption · {caption.length} / 2,200 · {ig.hashtags?.length ?? 0} hashtags
          </span>
          <CopyButton text={caption} label="caption" />
        </div>
        <span className="val">{caption || '—'}</span>
        {ig.reels_api_problem && <span className="xs" style={{ color: 'var(--blk-text)' }}>Outside the Reels API limits (postable by hand): {ig.reels_api_problem}</span>}
      </div>
      {ig.alt_text && (
        <div className="fld">
          <div className="row sb">
            <span className="lbl">Alt text</span>
            <CopyButton text={ig.alt_text} label="alt text" />
          </div>
          <span className="val">{ig.alt_text}</span>
        </div>
      )}
      {ig.first_comment && (
        <div className="fld">
          <div className="row sb">
            <span className="lbl">First comment</span>
            <CopyButton text={ig.first_comment} label="first comment" />
          </div>
          <span className="val">{ig.first_comment}</span>
        </div>
      )}
      <div className="fld">
        <span className="xs t3">
          Cover: {ig.cover_note ?? '—'}
          {ig.instagram_account ? ` · account ${ig.instagram_account}` : ''}
          {b.status === 'live' ? ' · posted — metrics are read from the permalink once the Instagram read permissions are granted.' : ''}
        </span>
      </div>
    </>
  );
}
