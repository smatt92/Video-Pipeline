import { BureauNav } from '@/components/bureau/bureau-nav';
import { CutControls, RegenerateButton } from '@/components/bureau/cut-controls';
import { LiveRefresh, LiveStatus } from '@/components/bureau/live-status';
import { channelGeneration, episodeClips } from '@/lib/bureau/overlay-only';
import { isRunning } from '@/lib/bureau/running';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { storage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

type Clip = { shot_idx: number; passed: boolean; reasons: string[]; action: string };

/**
 * Cuts — every episode waiting on the second gate: the composite in a 9:16 player, the shot
 * strip with each shot's route and QC verdict, re-roll per generated shot, approve / reject.
 */
export default async function CutsPage() {
  const channel = await requireChannel();
  const db = serverClient();
  const { data: eps } = await db
    .from('episodes')
    .select('id, slot_id, status, status_detail, script_id, final_render_id, qc, estimate_inr, voice_detail, updated_at')
    .eq('channel_id', channel.id)
    .in('status', ['awaiting_cut', 'cut_rejected', 'qc', 'assembling'])
    .order('updated_at', { ascending: false });
  const rows = await Promise.all(
    (eps ?? []).map(async (e) => {
      let url: string | null = null;
      if (e.final_render_id) {
        const { data: r } = await db.from('renders').select('asset_id').eq('id', e.final_render_id).single();
        const { data: a } = r?.asset_id ? await db.from('assets').select('storage_key').eq('id', r.asset_id).single() : { data: null };
        url = a ? await storage().presignGet({ key: a.storage_key, expiresIn: 3600 }).then((p) => p.url).catch(() => null) : null;
      }
      const { data: shots } = e.script_id ? await db.from('shots').select('idx, render_route, duration_s, status, description').eq('script_id', e.script_id).order('idx') : { data: [] };
      const { data: spend } = await db.from('v_episode_spend').select('spent_inr, unpriced_rows').eq('episode_id', e.id).maybeSingle();
      const clips = Object.values(((e.qc ?? {}) as { clips?: Record<string, Clip> }).clips ?? {});
      const lufs = ((e.qc ?? {}) as { loudness_lufs?: number | null }).loudness_lufs ?? null;
      const gen = await episodeClips(db, e);
      return { e, url, shots: shots ?? [], clips, spend, lufs, gen };
    }),
  );
  const readiness = await channelGeneration(db, channel.id);
  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6">
      <LiveRefresh active={rows.some(({ e }) => isRunning(e.status))} />
      <BureauNav active="cuts" />
      <h1 className="text-lg font-medium">Cuts</h1>
      {readiness.summary && (
        <p className="mt-1 text-sm" style={{ color: 'var(--state-blocked)' }}>
          {readiness.summary} A viewer sees the chalk diagrams and none of the cast. Nothing is spent on this; it is the pipeline refusing to generate a different-looking person.
        </p>
      )}
      {rows.length === 0 && <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>No cut is waiting.</p>}
      <div className="mt-4 grid gap-6">
        {rows.map(({ e, url, shots, clips, spend, lufs, gen }) => (
          <section key={e.id} className="grid gap-4 rounded-md border p-4 md:grid-cols-[320px_1fr]" style={{ borderColor: 'var(--border-default)' }}>
            <div>
              {url ? (
                <video src={url} controls playsInline className="aspect-[9/16] w-full rounded" style={{ background: 'var(--surface-inset)' }} />
              ) : (
                <div className="flex aspect-[9/16] w-full items-center justify-center rounded text-sm" style={{ background: 'var(--surface-inset)', color: 'var(--text-muted)' }}>
                  {e.status === 'awaiting_cut' ? 'render unavailable' : e.status}
                </div>
              )}
            </div>
            <div>
              <div className="flex flex-wrap gap-3 text-2xs" style={{ color: 'var(--text-muted)' }}>
                <span className="font-mono">{e.slot_id ?? 'bank'}</span>
                <span>{e.status}</span>
                <span className="font-mono tabular-nums">spent {spend?.spent_inr === undefined || spend?.spent_inr === null ? '—' : `₹${Number(spend.spent_inr).toFixed(2)}`}{Number(spend?.unpriced_rows ?? 0) > 0 ? ` + ${spend?.unpriced_rows} unpriced` : ''} (estimates)</span>
                <span className="font-mono">{lufs === null ? 'loudness unmeasured' : `${lufs} LUFS`}</span>
              </div>
              {gen && e.final_render_id && gen.overlayOnly && (
                <p className="mt-1 text-sm" style={{ color: 'var(--state-blocked)' }}>
                  Overlay-only cut: {gen.generatedPlanned === 0 ? 'every shot was planned as an overlay' : `${gen.generatedPlanned} generated shot${gen.generatedPlanned === 1 ? '' : 's'} planned, none produced a clip, so each is drawn as its overlay`}.
                  {gen.swaps.length > 0 && <span className="block text-2xs" style={{ color: 'var(--text-muted)' }}>{gen.swaps.join(' · ')}</span>}
                </p>
              )}
              {(() => {
                // Written by the voice stage: lines whose words the aligner could not confirm.
                // They caption as whole lines, and only a listen confirms they say the script.
                const v = e.voice_detail as { unaligned?: number | null; lines?: number } | null;
                const n = v?.unaligned;
                if (n === undefined || n === null || n === 0) return null;
                return (
                  <p className="mt-1 text-sm" style={{ color: 'var(--state-blocked)' }}>
                    Listen to every line: {n} of {v?.lines ?? '—'} could not be checked against the script automatically, and caption as whole lines.
                  </p>
                );
              })()}
              {isRunning(e.status) ? (
                <LiveStatus status={e.status} detail={e.status_detail} updatedAt={e.updated_at} />
              ) : (
                e.status_detail && <p className="mt-1 text-sm" style={{ color: 'var(--state-blocked)' }}>{e.status_detail}</p>
              )}
              <ol className="mt-3 grid gap-1 text-sm">
                {shots.map((s) => {
                  const qc = clips.filter((c) => c.shot_idx === s.idx).pop();
                  return (
                    <li key={s.idx} className="flex flex-wrap items-baseline gap-2">
                      <span className="w-6 font-mono text-2xs">{s.idx}</span>
                      <span className="w-28 text-2xs" style={{ color: 'var(--text-muted)' }}>{s.render_route} · {Number(s.duration_s).toFixed(1)}s</span>
                      <span className="flex-1">{s.description}</span>
                      {qc && <span className="text-2xs" style={{ color: qc.passed ? 'var(--state-live)' : 'var(--state-blocked)' }}>QC {qc.passed ? 'pass' : `${qc.action}: ${qc.reasons.join(', ')}`}</span>}
                      {s.render_route && s.render_route !== 'overlay' && <RegenerateButton episodeId={e.id} shotIdx={s.idx} />}
                    </li>
                  );
                })}
              </ol>
              {e.status === 'awaiting_cut' && <CutControls episodeId={e.id} />}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
