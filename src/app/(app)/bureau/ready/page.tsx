import { BureauNav } from '@/components/bureau/bureau-nav';
import { CopyButton, MarkScheduled, QueueDubs } from '@/components/bureau/ready-controls';
import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import { readyBundles } from '@/lib/bureau/read';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

type Bundle = { title?: string; description?: string; tags?: string[]; made_for_kids?: boolean; contains_synthetic_media?: boolean; pinned_comment?: string; slot_time?: string | null; alternate_titles?: string[] };

/**
 * Ready to schedule — while the upload API is unaudited, this is how a Short reaches
 * YouTube: download, paste, schedule in Studio at the slot, then "Mark scheduled" (with the
 * link, so metrics can find the video). The review gate and the daily publish cap are checked
 * by the database when you mark it.
 */
export default async function ReadyPage() {
  const bundles = await readyBundles(serverClient(), BUREAU_CHANNEL_ID);
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6">
      <BureauNav active="ready" />
      <h1 className="text-lg font-medium">Ready to schedule</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
        Upload API unaudited: bundles only. madeForKids is always No; altered or synthetic content is Yes only when a realistic scene is present.
      </p>
      {bundles.length === 0 && <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>Nothing ready yet.</p>}
      <div className="mt-4 grid gap-4">
        {bundles.map((b) => {
          const meta = (b.bundle ?? {}) as Bundle;
          const tags = (meta.tags ?? b.tags ?? []).join(', ');
          return (
            <section key={b.publication_id} className="rounded-md border p-4" style={{ borderColor: 'var(--border-default)' }}>
              <div className="flex flex-wrap items-baseline gap-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
                <span className="font-mono">{b.slot_id ?? 'bank'}</span>
                <span>{b.platform}</span>
                <span>{b.status}</span>
                <span className="font-mono">slot {meta.slot_time ? new Date(meta.slot_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : '—'}</span>
              </div>
              <h2 className="mt-1 text-md font-medium">{b.title}</h2>
              {meta.alternate_titles?.length ? <p className="text-2xs" style={{ color: 'var(--text-faint)' }}>alternates: {meta.alternate_titles.join(' · ')}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton text={b.title ?? ''} label="title" />
                <CopyButton text={b.description ?? ''} label="description" />
                <CopyButton text={tags} label="tags" />
                {meta.pinned_comment && <CopyButton text={meta.pinned_comment} label="pinned comment" />}
                {b.download_urls.video && <a className="rounded border px-2 py-1 text-2xs" style={{ borderColor: 'var(--border-default)', color: 'var(--accent)' }} href={b.download_urls.video}>download MP4</a>}
                {b.download_urls.captions_srt && <a className="rounded border px-2 py-1 text-2xs" style={{ borderColor: 'var(--border-default)', color: 'var(--accent)' }} href={b.download_urls.captions_srt}>captions .srt</a>}
                {b.download_urls.clean_master && <a className="rounded border px-2 py-1 text-2xs" style={{ borderColor: 'var(--border-default)', color: 'var(--accent)' }} href={b.download_urls.clean_master}>clean master</a>}
              </div>
              <p className="mt-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
                madeForKids: No · altered/synthetic: {meta.contains_synthetic_media ? 'Yes (realistic scene)' : 'No'}
              </p>
              {b.dubs.length > 0 && (
                <ul className="mt-2 text-2xs">
                  {b.dubs.map((d) => (
                    <li key={d.language}>
                      {d.language}: {d.audio_url ? <a href={d.audio_url} style={{ color: 'var(--accent)' }}>audio</a> : 'audio —'} · {d.captions_url ? <a href={d.captions_url} style={{ color: 'var(--accent)' }}>captions</a> : 'captions —'} · {d.cost_inr === null ? 'unpriced' : `₹${d.cost_inr.toFixed(2)}`} ({d.cost_label})
                    </li>
                  ))}
                </ul>
              )}
              {b.episode_id && <div className="mt-2"><QueueDubs episodeId={b.episode_id} /></div>}
              {b.status === 'draft' && <MarkScheduled publicationId={b.publication_id!} slotTime={meta.slot_time ?? null} />}
            </section>
          );
        })}
      </div>
    </main>
  );
}
