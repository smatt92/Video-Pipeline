import { captionCues, type CaptionCue } from '../review/timeline';
import type { WordTiming } from '../voice/timings';

/**
 * Everything the final composition needs, computed before any renderer exists.
 *
 * ── What this is, and what it deliberately is not ────────────────────────────
 *
 * Stage 7's rough cut is ffmpeg concat — clips end to end, for "does this hang together?".
 * The **final** render is a Remotion composition: captions burned in from real word
 * timings, the hook on screen for the first seconds, and every element inside the platform's
 * safe area. This module is that composition's *input contract*: a pure function from a
 * script and its timings to the numbers a React component would position things with.
 *
 * It exists separately from the composition for the reason every other pure core in this
 * project does — it is exercisable without the thing that renders it. A caption that drifts
 * or a hook that sits under the platform's own UI is a file that plays and is wrong, which
 * is the failure class stage 7 has already produced three times.
 *
 * **`captionCues` is imported, not reimplemented.** It already exists in `review/timeline.ts`
 * and is already asserted there — no cue overlaps another, no cue exceeds the line length.
 * A second grouping function tuned slightly differently would put the review screen and the
 * rendered file out of sync, and the bug would be that the captions you approved are not the
 * captions that shipped. Two modules for one concept is worse than none.
 *
 * **No `server-only` here, deliberately.** This is a pure function over numbers with no
 * database access and no secrets, and the review screen's `@remotion/player` would want the
 * same plan client-side to preview what will be rendered. Marking it server-only would put
 * the preview and the render on two different planners, which is the drift `captionCues`
 * being shared exists to prevent.
 *
 * ── Safe areas are per platform and are not decoration ───────────────────────
 *
 * A 9:16 short is not a 9:16 rectangle you may draw on. The platform puts its own chrome
 * over the top and bottom — handle, caption, follow button, the scrubber — and anything
 * placed there is either covered or fighting for attention with a UI element. The insets
 * below are expressed as fractions of the frame rather than pixels so they survive a
 * resolution change, which is the form the mistake usually takes: a safe area measured in
 * pixels at 1080×1920 silently stops being safe at 720×1280.
 *
 * These are **conservative and unverified against a real handset**. They are recorded as a
 * starting point with the uncertainty stated, not as a measurement — see the note on
 * `verified` below.
 */

export type RenderFormat = 'shorts_9x16' | 'reels_9x16' | 'longform_16x9';

export interface SafeArea {
  /** Fractions of frame height/width. Multiply by the real dimension at layout time. */
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  /**
   * False on every entry, and it must stay false until somebody has looked at a real post
   * on a real handset. A safe area that claims to be verified and is not produces captions
   * under the follow button on every video, and the failure looks like a design choice
   * rather than a bug.
   */
  readonly verified: boolean;
  readonly note: string;
}

export const SAFE_AREAS: Record<RenderFormat, SafeArea> = {
  shorts_9x16: {
    top: 0.08,
    bottom: 0.20,
    left: 0.05,
    right: 0.14,
    verified: false,
    note:
      'Bottom is the largest inset: title, handle and description stack there, and the '
      + 'progress scrubber sits under them. Right is wider than left for the action rail.',
  },
  reels_9x16: {
    top: 0.08,
    bottom: 0.22,
    left: 0.05,
    right: 0.16,
    verified: false,
    note: 'Same shape as shorts with a taller bottom stack and a wider action rail.',
  },
  longform_16x9: {
    top: 0.05,
    bottom: 0.10,
    left: 0.05,
    right: 0.05,
    verified: false,
    note: 'Only the player controls overlay, and only on hover. The most forgiving format.',
  },
};

export interface CompositionPlan {
  format: RenderFormat;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  safeArea: SafeArea;
  /** Pixel box the composition may draw inside, derived from the fractions. */
  safeBox: { x: number; y: number; width: number; height: number };
  cues: CaptionCue[];
  hook: { text: string; startS: number; endS: number } | null;
  /** Everything that would be positioned outside the safe box, named rather than clipped. */
  problems: string[];
}

export type PlanResult =
  | { ok: true; plan: CompositionPlan }
  | { ok: false; code: string; detail: string };

/** How long the hook stays up. The first two seconds decide the business. */
const HOOK_SECONDS = 2;

export function planComposition(input: {
  format: RenderFormat;
  width: number;
  height: number;
  fps: number;
  /** Measured, from the assembled file — never the shotlist's estimate. */
  durationS: number;
  hook: string;
  words: readonly WordTiming[];
}): PlanResult {
  const safeArea = SAFE_AREAS[input.format];
  if (!safeArea) {
    return { ok: false, code: 'unknown_format', detail: `No safe area for "${input.format}".` };
  }

  // Refused rather than defaulted. A composition planned against a duration nobody measured
  // is the exact shape of the three bugs that produced a file which plays and is wrong —
  // and `?? 0` on a duration is the smell this project greps for.
  if (!Number.isFinite(input.durationS) || input.durationS <= 0) {
    return {
      ok: false,
      code: 'no_duration',
      detail:
        'The composition needs a measured duration. An unmeasured one is unknown, not zero, '
        + 'and planning against zero produces a render of no frames rather than an error.',
    };
  }

  if (input.words.length === 0) {
    return {
      ok: false,
      code: 'no_timings',
      detail:
        'No word timings, so there are no captions to burn in and no way to know when the '
        + 'speech happens. Stage 6 produces these; a final render without them is a rough '
        + 'cut with extra steps.',
    };
  }

  const cues = captionCues(input.words);

  const safeBox = {
    x: Math.round(input.width * safeArea.left),
    y: Math.round(input.height * safeArea.top),
    width: Math.round(input.width * (1 - safeArea.left - safeArea.right)),
    height: Math.round(input.height * (1 - safeArea.top - safeArea.bottom)),
  };

  const problems: string[] = [];

  if (safeBox.width <= 0 || safeBox.height <= 0) {
    return {
      ok: false,
      code: 'no_safe_area',
      detail: `The safe insets for ${input.format} leave no drawable area at ${input.width}×${input.height}.`,
    };
  }

  // A cue that runs past the end of the file is a caption over black, or a crash, depending
  // on the renderer. Reported rather than clamped: clamping hides a timing drift, and
  // timing drift between the voice and the picture is what the audio-first ordering exists
  // to prevent — so if it has appeared, that is the finding.
  const overrun = cues.filter((c) => c.endS > input.durationS + 0.05);
  if (overrun.length > 0) {
    problems.push(
      `${overrun.length} caption cue(s) end after the file does — last ends at `
        + `${overrun[overrun.length - 1].endS.toFixed(2)}s against a ${input.durationS.toFixed(2)}s file. `
        + 'The voice and the picture have drifted apart.',
    );
  }

  if (!safeArea.verified) {
    problems.push(
      `The ${input.format} safe area has never been checked against a real post. Captions may `
        + 'sit under the platform’s own chrome, which looks like a design choice rather '
        + 'than a bug.',
    );
  }

  const hookText = input.hook.trim();

  return {
    ok: true,
    plan: {
      format: input.format,
      width: input.width,
      height: input.height,
      fps: input.fps,
      // Rounded up: a composition one frame short of the audio ends on a cut mid-word.
      durationInFrames: Math.ceil(input.durationS * input.fps),
      safeArea,
      safeBox,
      cues,
      hook: hookText
        ? { text: hookText, startS: 0, endS: Math.min(HOOK_SECONDS, input.durationS) }
        : null,
      problems,
    },
  };
}
