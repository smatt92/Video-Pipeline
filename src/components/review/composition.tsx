'use client';

import { AbsoluteFill, OffthreadVideo, Sequence, useVideoConfig } from 'remotion';

import type { CaptionCue, TimelineSpan } from '@/lib/review/timeline';
import { VIDEO_PAINT } from '@/styles/media-paint';

/**
 * The review composition.
 *
 * Remotion rather than a `<video>` element pointed at the rough cut, and the reason is what
 * the screen is for. The rough cut is one flat MP4 produced by an ffmpeg concat: play it
 * and you learn whether it hangs together, which is worth knowing and is the *only* thing
 * it can tell you. It cannot show a reordering you have not rendered yet, a trim you just
 * dragged, or where a caption lands — all of which are the questions a reviewer is actually
 * asking, and all of which would otherwise need a render round trip each.
 *
 * So this composes the per-shot clips live, from the same `TimelineSpan[]` the shot strip
 * and the drift column read. Change the order and the canvas changes; nothing is re-encoded
 * until the cut is re-rendered for real.
 *
 * ── This is a preview and says so ────────────────────────────────────────────
 *
 * What plays here is not byte-identical to what stage 7 produces — the browser decodes each
 * clip independently, the concat demuxer does not. That difference is why `07-assemble`
 * asserts the finished render's duration against the sum of its shots rather than trusting
 * a preview: this canvas can look right while the render is wrong, and the check that
 * catches that lives in the task, not here.
 *
 * ── FPS is the canonical one, not a guess ────────────────────────────────────
 *
 * Frames are the unit Remotion counts in, and every duration in this project is seconds. A
 * mismatch between the fps used to convert them and the fps the clips actually carry
 * produces a preview that drifts progressively from the render — the exact failure the
 * drift column exists to surface, introduced by the tool meant to display it.
 */

export const CANONICAL_FPS = 30;

export interface CompositionProps {
  spans: TimelineSpan[];
  /** shot id → presigned clip URL. Absent means the shot has no asset yet. */
  clipUrls: Record<string, string>;
  cues: CaptionCue[];
  showCaptions: boolean;
}

export function ReviewComposition({ spans, clipUrls, cues, showCaptions }: CompositionProps) {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: VIDEO_PAINT.background }}>
      {spans.map((span) => {
        const url = clipUrls[span.shot.id];
        const from = Math.round(span.startS * fps);
        const durationInFrames = Math.max(1, Math.round(span.shot.effectiveDurationS * fps));

        return (
          <Sequence key={span.shot.id} from={from} durationInFrames={durationInFrames}>
            {url ? (
              <OffthreadVideo
                src={url}
                // The in point is where the clip starts, not where the sequence does. Passing
                // the sequence offset here would play the wrong part of every trimmed shot
                // and look exactly like a correct trim.
                startFrom={Math.round((span.shot.trimInS ?? 0) * fps)}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <MissingClip idx={span.shot.idx} description={span.shot.description} />
            )}
          </Sequence>
        );
      })}

      {showCaptions &&
        cues.map((cue, i) => (
          <Sequence
            key={`${cue.startS}-${i}`}
            from={Math.round(cue.startS * fps)}
            durationInFrames={Math.max(1, Math.round((cue.endS - cue.startS) * fps))}
          >
            <Caption text={cue.text} />
          </Sequence>
        ))}
    </AbsoluteFill>
  );
}

/**
 * A shot with no asset renders as a legible placeholder, not as black.
 *
 * Black is what a dropped segment looks like too, and telling those apart is most of what
 * this screen is for.
 */
function MissingClip({ idx, description }: { idx: number; description: string }) {
  return (
    <AbsoluteFill
      style={{
        background: VIDEO_PAINT.placeholderSurface,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
        textAlign: 'center',
      }}
    >
      <div style={{ color: VIDEO_PAINT.placeholderText, fontFamily: 'monospace', fontSize: 28 }}>
        shot {String(idx).padStart(2, '0')} — no clip
      </div>
      <div style={{ color: VIDEO_PAINT.placeholderSubtext, fontSize: 22, marginTop: 16, maxWidth: 640 }}>
        {description}
      </div>
    </AbsoluteFill>
  );
}

function Caption({ text }: { text: string }) {
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: '18%' }}>
      <div
        style={{
          // Deliberately inside the platform safe area. A caption that is legible in the
          // player and covered by the UI chrome on a phone is worse than no preview.
          maxWidth: '82%',
          padding: '10px 18px',
          borderRadius: 8,
          background: VIDEO_PAINT.captionBackground,
          color: VIDEO_PAINT.captionText,
          fontSize: 34,
          lineHeight: 1.25,
          textAlign: 'center',
          fontWeight: 600,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}
