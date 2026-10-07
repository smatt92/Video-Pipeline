'use client';

import { useEffect, useRef, useState } from 'react';

import { Icon } from './icon';

/**
 * 9:16 player (canvas: Components → Video player, Cuts). The scrub bar is drawn as one segment
 * per shot, sized by the shot's duration, so a click lands on a shot rather than a timestamp —
 * the question at a cut review is always "which shot", never "which second".
 *
 * The HUD shows integrated loudness when it was measured and an em dash when it was not. No
 * src means no cut exists yet; the frame says so instead of drawing an empty video element.
 */
export function Player({
  src,
  poster,
  label,
  shots,
  lufs,
  width = 260,
}: {
  src: string | null;
  poster?: string | null;
  label: string;
  /** Durations in seconds, in order. Empty → a single plain bar. */
  shots: readonly number[];
  lufs: number | null;
  width?: number | string;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = shots.reduce((a, b) => a + b, 0);
  const [dur, setDur] = useState<number | null>(total > 0 ? total : null);

  useEffect(() => {
    const el = v.current;
    if (!el) return;
    const tick = () => setT(el.currentTime);
    const meta = () => Number.isFinite(el.duration) && setDur(el.duration);
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    el.addEventListener('timeupdate', tick);
    el.addEventListener('loadedmetadata', meta);
    el.addEventListener('play', play);
    el.addEventListener('pause', pause);
    return () => {
      el.removeEventListener('timeupdate', tick);
      el.removeEventListener('loadedmetadata', meta);
      el.removeEventListener('play', play);
      el.removeEventListener('pause', pause);
    };
  }, [src]);

  const shotIndex = (() => {
    let acc = 0;
    for (let i = 0; i < shots.length; i++) {
      acc += shots[i]!;
      if (t < acc) return i;
    }
    return shots.length - 1;
  })();

  const seekShot = (i: number) => {
    const start = shots.slice(0, i).reduce((a, b) => a + b, 0);
    if (v.current) v.current.currentTime = start;
    setT(start);
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  const share = dur ? Math.min(1, t / dur) : 0;

  return (
    <div className="player bp" style={{ width, maxWidth: '100%' }}>
      {src ? (
        <video
          ref={v}
          className="scene"
          src={src}
          poster={poster ?? undefined}
          playsInline
          preload="metadata"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          aria-label={label}
        />
      ) : (
        <div className="scene" style={{ display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
          <span className="sm" style={{ color: 'var(--chalk)', opacity: 0.75 }}>
            No cut to play yet.
          </span>
        </div>
      )}
      <div className="hud">
        <span className="mono xs" style={{ color: 'var(--chalk)', opacity: 0.85 }}>
          {label}
          {shots.length > 0 ? ` · shot ${shotIndex + 1}/${shots.length}` : ''}
        </span>
        <span className="mono xs" style={{ color: 'var(--chalk)', opacity: 0.85 }} title={lufs === null ? 'loudness not measured' : 'integrated loudness'}>
          {lufs === null ? '— LUFS' : `${lufs.toFixed(1)} LUFS`}
        </span>
      </div>
      <div className="ctl">
        <div className="scrub">
          {shots.length > 0 ? (
            shots.map((d, i) => (
              <b
                key={i}
                style={{ flex: d, cursor: src ? 'pointer' : 'default' }}
                onClick={() => src && seekShot(i)}
                title={`Shot ${i + 1} · ${d.toFixed(1)}s`}
              />
            ))
          ) : (
            <b style={{ flex: 1 }} />
          )}
          <i style={{ width: `${share * 100}%` }} />
        </div>
        <div className="row sb">
          <button
            className="pbtn"
            type="button"
            disabled={!src}
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={() => (v.current?.paused ? v.current.play() : v.current?.pause())}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          {shots.length > 0 && src && (
            <span className="row" style={{ gap: 4 }}>
              <button type="button" className="btn sm ghost" style={{ color: 'var(--chalk)' }} onClick={() => seekShot(Math.max(0, shotIndex - 1))} aria-label="Previous shot">
                ‹
              </button>
              <button type="button" className="btn sm ghost" style={{ color: 'var(--chalk)' }} onClick={() => seekShot(Math.min(shots.length - 1, shotIndex + 1))} aria-label="Next shot">
                ›
              </button>
            </span>
          )}
          <span className="mono xs" style={{ color: 'var(--chalk)', opacity: 0.85 }}>
            {fmt(t)} / {dur === null ? '—' : fmt(dur)}
          </span>
        </div>
      </div>
    </div>
  );
}
