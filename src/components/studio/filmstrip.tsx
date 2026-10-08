import Link from 'next/link';

import { RegenerateButton } from '@/components/bureau/cut-controls';
import { Pill, type StateTone } from '@/components/ui/tags';
import type { StripShot } from '@/lib/studio/canvas';

/**
 * The bottom filmstrip (canvas: GlassStudio): the session episode's shots in order — the
 * newest picture or clip as a thumbnail (a presigned URL), the line of narration it carries,
 * its status, and Re-roll for a clip through the same regenerate action Cuts uses. A picture
 * is redrawn on Cuts, where the cut it belongs to is held while it redraws.
 */

// shots.status (0001): pending | generating | ready | failed | reshoot.
const SHOT_STATE: Record<string, { tone: StateTone; label: string }> = {
  pending: { tone: 'draft', label: 'queued' },
  generating: { tone: 'gen', label: 'drawing' },
  ready: { tone: 'rdy', label: 'done' },
  failed: { tone: 'blk', label: 'failed' },
  reshoot: { tone: 'rev', label: 're-rolling' },
};

export function Filmstrip({ shots, episodeId, note }: { shots: StripShot[] | null; episodeId: string | null; note: string }) {
  const done = shots?.filter((s) => s.thumb).length ?? 0;
  const planned = shots?.reduce((a, s) => a + (s.durationS ?? 0), 0) ?? 0;
  return (
    <section className="gp dense studio-strip" aria-label="Shots">
      {!shots || shots.length === 0 ? (
        <p className="sm t3" style={{ padding: '8px 6px' }}>
          {shots === null ? 'The shots could not be read.' : note}
        </p>
      ) : (
        <>
          <div className="fstrip">
            {shots.map((s) => {
              const st = s.thumb ? { tone: 'rdy' as const, label: 'done' } : (SHOT_STATE[s.status] ?? { tone: 'draft' as const, label: s.status.replace(/_/g, ' ') });
              return (
                <article key={s.id} className={`beat${s.thumb ? '' : ' q'}`}>
                  <div className="th">
                    {s.thumb?.kind === 'image' && (
                      // eslint-disable-next-line @next/next/no-img-element -- a presigned URL to the bucket; next/image would proxy the bytes through Vercel (rule 2)
                      <img src={s.thumb.url} alt={`Shot ${s.idx}`} loading="lazy" />
                    )}
                    {s.thumb?.kind === 'video' && <video src={`${s.thumb.url}#t=0.1`} muted playsInline preload="metadata" aria-label={`Shot ${s.idx}`} />}
                    <span className="n">{s.idx}</span>
                  </div>
                  <div className="tx">
                    <Pill tone={st.tone}>{st.label}</Pill>
                    {s.durationS !== null && <span className="mono xs t3">{s.durationS.toFixed(1)} s</span>}
                    <span className="bline">{s.line || "—"}</span>
                    {episodeId && s.reroll && s.thumb && <RegenerateButton episodeId={episodeId} shotIdx={s.idx} />}
                    {episodeId && !s.reroll && s.thumb && (
                      <Link className="xs" href={`/bureau/cuts?id=${episodeId}`}>
                        Redraw on Cuts
                      </Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
            <div className="prog grow">
              <i style={{ width: `${(done / shots.length) * 100}%` }} />
            </div>
            <span className="mono xs t3">
              {done} of {shots.length} shots · {Math.round(planned)} s planned
            </span>
          </div>
        </>
      )}
    </section>
  );
}
