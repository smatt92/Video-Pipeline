'use client';

import { useEffect, useRef, useState } from 'react';

import type { CaptionCue } from '@/lib/review/timeline';
import { WAVEFORM_PAINT } from '@/styles/media-paint';

/**
 * The voiceover track.
 *
 * wavesurfer.js, loaded dynamically because it touches `window` and `AudioContext` at
 * import time — a static import makes it part of the server render and the page 500s before
 * anything is visible.
 *
 * ── Why the VO gets its own track at all ─────────────────────────────────────
 *
 * The player already plays audio. What it cannot show is *where the words are*, and that is
 * the thing this screen has to answer: shot durations are derived from word timings, so a
 * cut is right or wrong according to whether the picture boundaries land where the speech
 * boundaries do. Seeing the waveform with caption regions drawn on it turns "the timing
 * feels off" into "shot four starts 0.6s before its line does".
 *
 * ── Regions come from word_timings, not from the audio ───────────────────────
 *
 * wavesurfer can find silences; it cannot find sentences. The regions here are the caption
 * cues, which are grouped from the vendor's NORMALISED alignment — what was actually spoken
 * — so a region boundary is a real word boundary rather than a guess from amplitude.
 */

export interface WaveformProps {
  audioUrl: string | null;
  cues: CaptionCue[];
  /** Playhead in seconds, driven by the player. */
  currentTimeS: number;
  /** Called when the user scrubs the waveform. */
  onSeek: (seconds: number) => void;
  /** Boundaries of the picture, drawn over the audio so drift is visible as a gap. */
  shotBoundariesS: number[];
}

export function Waveform({ audioUrl, cues, currentTimeS, onSeek, shotBoundariesS }: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<{ destroy(): void; setTime(t: number): void; getDuration(): number } | null>(null);
  const onSeekRef = useRef(onSeek);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [durationS, setDurationS] = useState(0);

  // Kept in a ref so a changing callback identity does not tear down and rebuild the
  // waveform — which would refetch the audio on every parent render.
  onSeekRef.current = onSeek;

  useEffect(() => {
    if (!audioUrl || !containerRef.current) {
      setState('idle');
      return;
    }

    let cancelled = false;
    setState('loading');
    setError(null);

    (async () => {
      try {
        const { default: WaveSurfer } = await import('wavesurfer.js');
        if (cancelled || !containerRef.current) return;

        const ws = WaveSurfer.create({
          container: containerRef.current,
          height: 64,
          waveColor: WAVEFORM_PAINT.wave,
          progressColor: WAVEFORM_PAINT.progress,
          cursorColor: WAVEFORM_PAINT.cursor,
          cursorWidth: 1,
          barWidth: 2,
          barGap: 1,
          barRadius: 1,
          normalize: true,
          // The player owns playback; this is a display and a scrub target. Two elements
          // both playing the same audio is an echo, and syncing them is a race nobody wins.
          media: undefined,
          interact: true,
        });

        ws.on('ready', () => {
          if (cancelled) return;
          setDurationS(ws.getDuration());
          setState('ready');
        });

        ws.on('error', (err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setState('failed');
        });

        ws.on('interaction', (time: number) => onSeekRef.current(time));

        await ws.load(audioUrl);
        waveRef.current = ws as unknown as typeof waveRef.current;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('failed');
      }
    })();

    return () => {
      cancelled = true;
      waveRef.current?.destroy();
      waveRef.current = null;
    };
  }, [audioUrl]);

  // The playhead follows the player rather than the other way round. One clock.
  useEffect(() => {
    if (state !== 'ready') return;
    waveRef.current?.setTime(currentTimeS);
  }, [currentTimeS, state]);

  if (!audioUrl) {
    return (
      <Shell>
        <p className="px-3 py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
          No voiceover asset. Shot durations on this script are the shotlist estimate rather
          than measured speech, so nothing here can say whether the cut is timed correctly —
          run stage 6 first.
        </p>
      </Shell>
    );
  }

  const span = durationS || Math.max(...cues.map((c) => c.endS), 1);

  return (
    <Shell>
      <div className="relative px-3 pt-3">
        <div ref={containerRef} />

        {/* Caption regions, drawn over the waveform rather than inside it: wavesurfer's
            regions plugin would own its own DOM and its own coordinate space, and two
            sources of truth for "where is 4.2 seconds" is one too many. */}
        {state === 'ready' && (
          <div className="pointer-events-none absolute inset-x-3 top-3 h-[64px]">
            {cues.map((cue, i) => (
              <div
                key={`${cue.startS}-${i}`}
                className="absolute top-0 h-full border-l"
                style={{
                  left: `${(cue.startS / span) * 100}%`,
                  width: `${((cue.endS - cue.startS) / span) * 100}%`,
                  borderColor: 'var(--border-strong)',
                  background:
                    i % 2 === 0 ? WAVEFORM_PAINT.regionEven : WAVEFORM_PAINT.regionOdd,
                }}
                title={cue.text}
              />
            ))}

            {/* Shot boundaries. Where these do not line up with a caption edge is where the
                picture and the voice have come apart, which is the whole reason both are
                drawn on one axis. */}
            {shotBoundariesS.map((t) => (
              <div
                key={t}
                className="absolute top-0 h-full w-px"
                style={{ left: `${(t / span) * 100}%`, background: 'var(--state-review)' }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-baseline gap-3 px-3 pb-2 pt-1">
        <span className="font-mono text-3xs" style={{ color: 'var(--text-faint)' }}>
          {state === 'loading' ? 'loading…' : `${cues.length} caption regions`}
        </span>
        {state === 'ready' && (
          <span className="font-mono text-3xs" style={{ color: 'var(--text-faint)' }}>
            VO {durationS.toFixed(2)}s
          </span>
        )}
        {state === 'failed' && (
          <span className="font-mono text-3xs" style={{ color: 'var(--state-blocked)' }}>
            waveform failed — {error}
          </span>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-md border"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
    >
      {children}
    </div>
  );
}
