import { AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';

import type { CompositionPlan } from '@/lib/assemble/composition';

/**
 * The final composition — captions burned in, hook on screen, everything inside the safe box.
 *
 * ── This file draws; it decides nothing ──────────────────────────────────────
 *
 * Every number it uses comes from `CompositionPlan`, computed by `planComposition` in
 * `src/lib/assemble/composition.ts` and asserted by `verify:assemble` §9. That split is the
 * point: a React component rendered by headless Chromium is the least testable thing in this
 * repo, so nothing is decided here. Cue timings, the hook window, the safe box in pixels and
 * the frame count are all inputs.
 *
 * The rule it exists to serve is the one three duration bugs produced: a file that plays and
 * is wrong is worse than a file that fails, because nothing downstream can tell. So the
 * component reads `durationInFrames` from the plan and the render asserts the output against
 * it — see `src/lib/assemble/render.ts`.
 *
 * ── Why pixel sizes here and nowhere else ────────────────────────────────────
 *
 * `pnpm check:scalable-sizes` forbids font sizes the `--ui-scale` control cannot move. That
 * rule is about the *application*, where a person may need larger text. A video frame is a
 * fixed raster: 1080×1920 is the whole coordinate system, the viewer cannot rescale it, and
 * a caption sized in `rem` would render at the browser default and be illegibly small. Sizes
 * here are fractions of the frame height, which is the video equivalent of the scale rule —
 * they survive a resolution change, which pixels would not.
 */

/**
 * A `type` and not an `interface`, deliberately. Remotion's `Composition` constrains its
 * props to `Record<string, unknown>`, and an interface does not satisfy that — interfaces
 * have no implicit index signature, type aliases do. The error this produces names
 * `LooseComponentType` and says nothing about the cause.
 */
export type KilnVideoProps = {
  plan: CompositionPlan;
  /** Absolute or served URLs, in order. One per shot. */
  clipUrls: string[];
  /** Frame counts per clip, so a sequence starts where the previous one ended. */
  clipFrames: number[];
};

export function KilnVideo({ plan, clipUrls, clipFrames }: KilnVideoProps) {
  const { height } = useVideoConfig();

  // Fractions of the frame, not pixels. A caption sized at 48px is right at 1080×1920 and
  // wrong at 720×1280, and the wrongness is subtle enough to ship.
  const captionSize = Math.round(height * 0.032);
  const hookSize = Math.round(height * 0.055);

  let start = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {clipUrls.map((url, i) => {
        const from = start;
        const durationInFrames = clipFrames[i] ?? 0;
        start += durationInFrames;
        // A zero-length sequence would silently drop the clip. Skipped explicitly so the
        // render's duration assertion is the thing that catches a bad clip list, rather
        // than a shorter file nobody measured.
        if (durationInFrames <= 0) return null;
        return (
          <Sequence key={url} from={from} durationInFrames={durationInFrames}>
            <OffthreadVideo src={url} />
          </Sequence>
        );
      })}

      <Captions plan={plan} fontSize={captionSize} />
      {plan.hook !== null && <Hook plan={plan} fontSize={hookSize} />}
    </AbsoluteFill>
  );
}

function Captions({ plan, fontSize }: { plan: CompositionPlan; fontSize: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // Cues do not overlap — `captionCues` asserts that in `verify:review` — so at most one is
  // live. `find` rather than `filter` states that rather than relying on it.
  const cue = plan.cues.find((c) => t >= c.startS && t < c.endS);
  if (!cue) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: plan.safeBox.x,
        top: plan.safeBox.y,
        width: plan.safeBox.width,
        height: plan.safeBox.height,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          fontFamily: 'sans-serif',
          fontWeight: 700,
          fontSize,
          lineHeight: 1.25,
          color: 'white',
          textAlign: 'center',
          // A stroke rather than a box: a caption over a light frame is unreadable without
          // one, and a translucent box covers the picture the caption is describing.
          textShadow: '0 2px 12px rgba(0,0,0,0.85), 0 0 3px rgba(0,0,0,0.95)',
        }}
      >
        {cue.text}
      </span>
    </div>
  );
}

function Hook({ plan, fontSize }: { plan: CompositionPlan; fontSize: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const hook = plan.hook!;

  if (t < hook.startS || t >= hook.endS) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: plan.safeBox.x,
        top: plan.safeBox.y,
        width: plan.safeBox.width,
        height: plan.safeBox.height,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          fontFamily: 'sans-serif',
          fontWeight: 800,
          fontSize,
          lineHeight: 1.15,
          color: 'white',
          textAlign: 'center',
          textShadow: '0 2px 16px rgba(0,0,0,0.9), 0 0 4px rgba(0,0,0,0.95)',
        }}
      >
        {hook.text}
      </span>
    </div>
  );
}
