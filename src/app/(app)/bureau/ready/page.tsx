import { BureauNav } from '@/components/bureau/bureau-nav';
import { BuildInstagram, CopyButton, MarkPosted, MarkScheduled, QueueDubs } from '@/components/bureau/ready-controls';
import { readyBundles } from '@/lib/bureau/read';
import { requireChannel } from '@/lib/channels/active';
import { publishTargets } from '@/lib/channels/list';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

type Bundle = { title?: string; description?: string; tags?: string[]; made_for_kids?: boolean; contains_synthetic_media?: boolean; pinned_comment?: string; slot_time?: string | null; alternate_titles?: string[] };
type IgBundle = { caption?: string; hashtags?: string[]; alt_text?: string; first_comment?: string; cover_frame_s?: number; cover_note?: string; reels_api_problem?: string | null; instagram_account?: string | null };
type Row = Awaited<ReturnType<typeof readyBundles>>[number];

const link = { borderColor: 'var(--border-default)', color: 'var(--accent)' } as const;
const muted = { color: 'var(--text-muted)' } as const;

/**
 * Ready to schedule — one card per episode, one section per publish target.
 *
 * YouTube: the upload API is unaudited, so download, paste, schedule in Studio at the slot,
 * then "Mark scheduled" (with the link, so metrics can find the video). Instagram: manual
 * until Meta app review clears (decision 0020) — the same MP4 posted as a Reel with the
 * caption, cover, alt text and first comment below, then "Mark posted" with the permalink.
 * The review gate, kill switch and daily cap are checked by the database on both.
 */
export default async function ReadyPage() {
  const channel = await requireChannel();
  const db = serverClient();
  const [bundles, { targets }] = await Promise.all([readyBundles(db, channel.id), publishTargets(db, channel.id)]);
  const igTarget = targets.find((t) => t.platform === 'instagram' && t.enabled) ?? null;
  const ytTarget = targets.find((t) => t.platform === 'youtube' && t.enabled) ?? null;

  // Group by episode (a bundle without one stands alone), YouTube first.
  const groups = new Map<string, { youtube: Row | null; instagram: Row | null }>();
  for (const b of bundles) {
    const k = b.episode_id ?? b.publication_id!;
    const g = groups.get(k) ?? { youtube: null, instagram: null };
    if (b.platform === 'instagram') g.instagram = b;
    else g.youtube = b;
    groups.set(k, g);
  }

  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6">
      <BureauNav active="ready" />
      <h1 className="text-lg font-medium">Ready to schedule</h1>
      <p className="mt-1 text-sm" style={muted}>
        Targets for {channel.name}: {[ytTarget ? 'YouTube' : null, igTarget ? `Instagram${igTarget.handle ? ` (${igTarget.handle})` : ''}` : null].filter(Boolean).join(' + ') || 'none'}. Both are manual: the YouTube upload API is unaudited and Instagram publishing waits on Meta app review.
      </p>
      {groups.size === 0 && <p className="mt-3 text-sm" style={muted}>Nothing ready yet.</p>}
      <div className="mt-4 grid gap-4">
        {[...groups.entries()].map(([k, g]) => {
          const head = g.youtube ?? g.instagram!;
          const meta = (head.bundle ?? {}) as Bundle;
          return (
            <section key={k} className="rounded-md border p-4" style={{ borderColor: 'var(--border-default)' }}>
              <div className="flex flex-wrap items-baseline gap-2 text-2xs" style={muted}>
                <span className="font-mono">{head.slot_id ?? 'bank'}</span>
                <span className="font-mono">slot {meta.slot_time ? new Date(meta.slot_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : '—'}</span>
              </div>
              <h2 className="mt-1 text-md font-medium">{head.title}</h2>

              {/* ── YouTube ─────────────────────────────────────────────── */}
              <h3 className="mt-3 text-sm font-medium">YouTube <span className="text-2xs font-normal" style={muted}>{g.youtube?.status ?? 'no bundle'}</span></h3>
              {g.youtube && <YoutubeSection b={g.youtube} />}

              {/* ── Instagram ───────────────────────────────────────────── */}
              <h3 className="mt-4 text-sm font-medium">Instagram Reels <span className="text-2xs font-normal" style={muted}>{g.instagram?.status ?? (igTarget ? 'no variant yet' : 'not a target for this channel')}</span></h3>
              {g.instagram ? <InstagramSection b={g.instagram} /> : igTarget && g.youtube ? <BuildInstagram youtubePublicationId={g.youtube.publication_id!} /> : null}

              {head.episode_id && <div className="mt-3"><QueueDubs episodeId={head.episode_id} /></div>}
            </section>
          );
        })}
      </div>
    </main>
  );
}

function YoutubeSection({ b }: { b: Row }) {
  const meta = (b.bundle ?? {}) as Bundle;
  const tags = (meta.tags ?? b.tags ?? []).join(', ');
  return (
    <div>
      {meta.alternate_titles?.length ? <p className="text-2xs" style={{ color: 'var(--text-faint)' }}>alternates: {meta.alternate_titles.join(' · ')}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <CopyButton text={b.title ?? ''} label="title" />
        <CopyButton text={b.description ?? ''} label="description" />
        <CopyButton text={tags} label="tags" />
        {meta.pinned_comment && <CopyButton text={meta.pinned_comment} label="pinned comment" />}
        {b.download_urls.video && <a className="rounded border px-2 py-1 text-2xs" style={link} href={b.download_urls.video}>download MP4</a>}
        {b.download_urls.captions_srt && <a className="rounded border px-2 py-1 text-2xs" style={link} href={b.download_urls.captions_srt}>captions .srt</a>}
        {b.download_urls.clean_master && <a className="rounded border px-2 py-1 text-2xs" style={link} href={b.download_urls.clean_master}>clean master</a>}
      </div>
      <p className="mt-2 text-2xs" style={muted}>madeForKids: No · altered/synthetic: {meta.contains_synthetic_media ? 'Yes (realistic scene)' : 'No'}</p>
      {b.dubs.length > 0 && (
        <ul className="mt-2 text-2xs">
          {b.dubs.map((d) => (
            <li key={d.language}>
              {d.language}: {d.audio_url ? <a href={d.audio_url} style={{ color: 'var(--accent)' }}>audio</a> : 'audio —'} · {d.captions_url ? <a href={d.captions_url} style={{ color: 'var(--accent)' }}>captions</a> : 'captions —'} · {d.cost_inr === null ? 'unpriced' : `₹${d.cost_inr.toFixed(2)}`} ({d.cost_label})
            </li>
          ))}
        </ul>
      )}
      {b.status === 'draft' && <MarkScheduled publicationId={b.publication_id!} slotTime={meta.slot_time ?? null} />}
    </div>
  );
}

function InstagramSection({ b }: { b: Row }) {
  const ig = (b.bundle ?? {}) as IgBundle;
  return (
    <div>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border p-2 text-2xs" style={{ borderColor: 'var(--border-subtle)' }}>{ig.caption ?? b.description}</pre>
      <p className="mt-1 text-2xs" style={muted}>
        {(ig.caption ?? '').length} / 2,200 characters · {ig.hashtags?.length ?? 0} hashtags · cover: {ig.cover_note ?? '—'}
        {ig.instagram_account ? ` · account ${ig.instagram_account}` : ''}
      </p>
      {ig.reels_api_problem && <p className="mt-1 text-2xs" style={{ color: 'var(--danger)' }}>Outside the Reels API limits (postable by hand): {ig.reels_api_problem}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <CopyButton text={ig.caption ?? ''} label="caption" />
        {ig.alt_text && <CopyButton text={ig.alt_text} label="alt text" />}
        {ig.first_comment && <CopyButton text={ig.first_comment} label="first comment" />}
        {b.download_urls.video && <a className="rounded border px-2 py-1 text-2xs" style={link} href={b.download_urls.video}>download MP4</a>}
        {b.download_urls.cover_jpg && <a className="rounded border px-2 py-1 text-2xs" style={link} href={b.download_urls.cover_jpg}>cover still</a>}
      </div>
      {b.status === 'draft' && <MarkPosted publicationId={b.publication_id!} />}
      {b.status === 'live' && <p className="mt-2 text-2xs" style={muted}>Posted — metrics are read from the permalink once the Instagram read permissions are granted.</p>}
    </div>
  );
}
