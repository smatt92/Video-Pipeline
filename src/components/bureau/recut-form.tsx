'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { PACE_INFO, type VoicePace } from '@/lib/bureau/formats';
import type { RecutOptions } from '@/lib/bureau/recut';
import { recutAction } from '@/lib/bureau/ui-actions';

/**
 * Re-cut a sent-back episode with your notes: the pace, a different voice for any speaker,
 * and pictures for any shot that is still a diagram. The script and the paid-for lines are
 * kept; only a speaker whose voice changes is spoken again (and priced before it is).
 */
export function RecutForm({ episodeId, options }: { episodeId: string; options: RecutOptions }) {
  const router = useRouter();
  const [pace, setPace] = useState<VoicePace>(options.pace);
  const [voices, setVoices] = useState<Record<string, string>>(() => Object.fromEntries(options.speakers.map((s) => [s.slug, s.voice ?? ''])));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const changed = options.speakers.filter((s) => voices[s.slug] && voices[s.slug] !== s.voice);
  const go = () =>
    start(async () => {
      const r = await recutAction(episodeId, {
        pace: pace !== options.pace ? pace : undefined,
        voices: Object.fromEntries(changed.map((s) => [s.slug, voices[s.slug]!])),
      });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });

  return (
    <section className="card" aria-label="Re-cut with your notes">
      <div className="card-h">
        <h2 className="h3">Re-cut with your notes</h2>
      </div>
      <div className="card-b col" style={{ gap: 12 }}>
        {options.note && <p className="sm t2">Your note: “{options.note}”</p>}
        <div className="field">
          <label>Voice pace</label>
          <div className="seg" role="radiogroup" aria-label="Voice pace">
            {(Object.keys(PACE_INFO) as VoicePace[]).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={pace === p} className={pace === p ? 'on' : ''} onClick={() => setPace(p)} disabled={pending}>
                {PACE_INFO[p].label}
              </button>
            ))}
          </div>
          <span className="xs t3">{PACE_INFO[pace].blurb}. Free — the lines you paid for are sped up, not re-bought.</span>
        </div>
        {options.speakers.map((s) => (
          <div className="field" key={s.slug}>
            <label htmlFor={`v-${s.slug}`}>{s.name}’s voice</label>
            <select id={`v-${s.slug}`} className="input" value={voices[s.slug] ?? ''} disabled={pending} onChange={(e) => setVoices({ ...voices, [s.slug]: e.target.value })}>
              {!s.voice && <option value="">— not locked —</option>}
              {options.presets.map((p) => (
                <option key={p} value={p}>
                  {p}
                  {p === s.voice ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
        ))}
        {changed.length > 0 && (
          <p className="xs t3">
            {changed.map((s) => s.name).join(', ')} will be spoken again in the new voice (priced before it is spent), and keep that voice on every later episode.
          </p>
        )}
        <p className="xs t3">Any shot still drawn as a diagram gets pictures; the script stays as approved.</p>
        <button className="btn pri full" type="button" disabled={pending} onClick={go}>
          {pending ? 'Starting…' : 'Re-cut with these changes'}
        </button>
        {msg && (
          <p className="sm" role="status" style={{ color: msg.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
            {msg.text}
          </p>
        )}
      </div>
    </section>
  );
}
