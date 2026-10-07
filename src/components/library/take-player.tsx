'use client';

import { useRef, useState, type CSSProperties } from 'react';

import { Icon } from '@/components/ui/icon';

/**
 * A character's last take (canvas: Voices): play/pause and a waveform that moves only while
 * audio is actually playing. No src → the caller says why; this never draws a dead player.
 */
export function TakePlayer({ src, name, accent, label }: { src: string; name: string; accent?: string; label: string }) {
  const a = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  return (
    <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
      <button
        className="btn icon"
        type="button"
        aria-label={on ? `Pause ${name}` : `Play ${name}’s last take`}
        onClick={() => (a.current?.paused ? a.current.play() : a.current?.pause())}
      >
        <Icon name={on ? 'pause' : 'play'} />
      </button>
      <div className={`wv${on ? ' on' : ''}`} style={accent ? ({ '--c': accent } as CSSProperties) : undefined} aria-hidden="true">
        {Array.from({ length: 20 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <span className="mono xs t3">{label}</span>
      <audio ref={a} src={src} preload="none" onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => setOn(false)} />
    </div>
  );
}
