import { TOUR, type TourStep } from './tour';

/**
 * The tour scene, as data. No three.js in this file, on purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The rule this file enforces structurally
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `tour.ts` says the 3D layer may add spatial explanation and may never add a sentence the
 * flat renderer does not have. That is a rule somebody has to remember — unless the scene
 * has no way to say a sentence, in which case it is a property of the code.
 *
 * So look at `Beat`: camera position, which stages are lit, whether the gate is closed, how
 * far the ledger has filled. Numbers and enums. **There is no string field anywhere in it**,
 * and the renderer draws no text — no font is loaded, no glyph atlas, no `TextGeometry`.
 * The scene cannot express a claim, so it cannot express one the flat version lacks.
 *
 * Adding a `label` here is not a small change. It is the change that makes the rule
 * remembered again, and the reason the rule exists is that a fallback which drifts into a
 * summary of the tour stops being the tour.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why it is separate from the renderer
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because it can then be asserted without a GPU. `pnpm test:tour` reads this file and the
 * tour and checks that every step has a beat and every beat has a step — the failure it
 * prevents is a sixth step added to the copy that silently gets the fifth step's camera,
 * which nobody would notice in review and everybody would notice on the screen.
 */

/**
 * The eleven stages, laid out along one axis.
 *
 * Same eleven as the splash mark's eleven bars and the same eleven as `src/trigger/`, which
 * is the only reason the track means anything: it is the actual pipeline, drawn to scale in
 * count if nothing else. Heights vary on a three-cycle for the same reason the mark's do —
 * a flat row of identical bars reads as a loading state.
 *
 * The labels are here for the reader of this file and for the canvas's accessible name.
 * They are never drawn. See the note above.
 */
export const STAGES: readonly { readonly n: number; readonly label: string }[] = [
  { n: 1, label: 'Trend intake' },
  { n: 2, label: 'Concept generation' },
  { n: 3, label: 'Script and shotlist' },
  { n: 4, label: 'Prompt compile' },
  { n: 5, label: 'Generate' },
  { n: 6, label: 'Voice and audio' },
  { n: 7, label: 'Assemble' },
  { n: 8, label: 'QA gate' },
  { n: 9, label: 'Metadata' },
  { n: 10, label: 'Publish' },
  { n: 11, label: 'Measure' },
];

/** Stage `n` → its position along the track, centred on zero. */
export function stageX(n: number): number {
  return (n - (STAGES.length + 1) / 2) * 0.62;
}

/** Stage `n` → its height. The three-cycle from the splash mark. */
export function stageHeight(n: number): number {
  return 0.5 + ((n - 1) % 3) * 0.34;
}

export type StageMood =
  /** Reached and passed. */
  | 'done'
  /** This beat's subject. */
  | 'active'
  /** Refused, and holding. Amber. */
  | 'held';

export interface Beat {
  /** Where the camera sits. Metres, in the same space as `stageX`. */
  readonly camera: readonly [number, number, number];
  /** What it points at. */
  readonly lookAt: readonly [number, number, number];
  /** Stage numbers that are not idle, and how each is not idle. */
  readonly lit: Readonly<Record<number, StageMood>>;
  /**
   * Where the travelling marker stops, as a stage number. `null` runs it end to end.
   *
   * The marker is the only thing that moves on most beats, and where it *stops* is the
   * spatial argument: at stage 5 for a refusal, at the gate for review. A marker that
   * always completes the track would be decoration.
   */
  readonly pulseStopsAt: number | null;
  /**
   * A flow from one stage to another, drawn as a line. Used once — 6 → 5 — because that is
   * the one place the pipeline runs against its own numbering and a diagram says it faster
   * than a sentence can.
   */
  readonly flow?: readonly [number, number];
  /** The publish gate, between stage 8 and stage 9. */
  readonly gateClosed: boolean;
  /** How much of the ledger under the track has filled, 0 to 1. */
  readonly ledger: number;
}

/**
 * One beat per tour step, keyed by the step's stable id.
 *
 * Keyed rather than positional so reordering the copy reorders the scene with it. A
 * positional array would silently give step 3 step 2's camera the moment somebody moved a
 * step, which is exactly the class of bug that only shows up on a screen.
 */
/**
 * ── The camera stays out of the text column ──────────────────────────────────
 *
 * The first version of these numbers put the camera 2.6 units from a single stage, and the
 * result was a screenshot in which an amber box sits directly behind the paragraph and the
 * paragraph cannot be read. The scene was working exactly as written; what was written was
 * wrong. Two rules came out of it and both are arithmetic rather than taste:
 *
 *   **Level and above.** Every camera looks horizontally — `lookAt.y` equals `camera.y` —
 *   and sits above the track. A level camera puts everything below its own height below the
 *   centre of the frame, which is where the text is not. A camera that tilts down to find
 *   its subject drags that subject up into the middle, which is where the text is.
 *
 *   **`camera.y ≈ 1.2 + 0.06 × distance`.** The tallest stage is 1.2 units, and this puts
 *   its top at a constant ~18% below frame centre whatever the distance — so moving in
 *   makes the subject *bigger* rather than making it *higher*. Without it every close beat
 *   re-creates the bug, and the first correction used 0.14, which fixed the collision by
 *   pushing the whole track off the bottom of the screen. A backdrop nobody can see is not
 *   a legible backdrop; it is an absent one, and the harness could not tell the difference
 *   because it was measuring the text and the text was fine.
 *
 * `verify:tour` measures the consequence rather than the rule: it reads the composited
 * pixels underneath the actual heading and the actual paragraph and computes a contrast
 * ratio. Numbers here can be re-tuned freely; that check is what says whether the tuning
 * was any good.
 */
export const BEATS: Readonly<Record<string, Beat>> = {
  // The whole track, side on. The marker runs all eleven stages because this beat's claim
  // is that the whole thing is one pipeline.
  what: {
    camera: [0, 1.8, 10],
    lookAt: [0, 1.8, 0],
    lit: {},
    pulseStopsAt: null,
    gateClosed: false,
    ledger: 0,
  },

  // In on stages 5 and 6, and the flow drawn backwards. Both are lit; six is the active
  // one because it is the one that happens first, which is the entire point.
  'audio-first': {
    camera: [stageX(5.5), 1.58, 6.4],
    lookAt: [stageX(5.5), 1.58, 0],
    lit: { 6: 'active', 5: 'done' },
    pulseStopsAt: 6,
    flow: [6, 5],
    gateClosed: false,
    ledger: 0.2,
  },

  // Stage 5 amber, and the marker stops there rather than passing. Held, not broken:
  // everything before it stays done, which is what distinguishes a refusal from a failure.
  refusal: {
    camera: [stageX(5), 1.55, 5.8],
    lookAt: [stageX(5), 1.55, 0],
    lit: { 1: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'held' },
    pulseStopsAt: 5,
    gateClosed: false,
    ledger: 0.2,
  },

  // The gate. Camera on the 8–9 boundary; everything up to 8 is done and nothing past it
  // is, because that is what the constraint does.
  review: {
    camera: [stageX(8.5), 1.58, 6.4],
    lookAt: [stageX(8.5), 1.58, 0],
    lit: { 1: 'done', 2: 'done', 3: 'done', 4: 'done', 5: 'done', 6: 'done', 7: 'done', 8: 'active' },
    pulseStopsAt: 8,
    gateClosed: true,
    ledger: 0.6,
  },

  // Back and lower, so the ledger under the track comes into frame. Lower, not below: the
  // money is drawn beneath the work because that is where it accumulates, and dropping the
  // camera under the track would put the stages back across the paragraph.
  cost: {
    camera: [0, 1.75, 9.2],
    lookAt: [0, 1.75, 0],
    lit: {},
    pulseStopsAt: null,
    gateClosed: true,
    ledger: 1,
  },
};

/**
 * Every step has a beat, and every beat has a step.
 *
 * At module load, like the five-step ceiling in `tour.ts` and for the same reason: this is a
 * product invariant about content, and a product invariant that only a test knows is one
 * that fails in the environment where nobody is running tests.
 */
const missing = TOUR.filter((s) => !BEATS[s.id]).map((s) => s.id);
const orphaned = Object.keys(BEATS).filter((id) => !TOUR.some((s) => s.id === id));

if (missing.length > 0 || orphaned.length > 0) {
  throw new Error(
    [
      missing.length > 0
        ? `Tour steps with no scene beat: ${missing.join(', ')}. A step with no beat would ` +
          'render over whatever the previous step left on screen, which reads as the scene ' +
          'having frozen.'
        : '',
      orphaned.length > 0
        ? `Scene beats with no tour step: ${orphaned.join(', ')}. Either the step was ` +
          'renamed and the beat was not, or the copy was cut and the scene was not.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function beatFor(step: TourStep): Beat {
  return BEATS[step.id]!;
}
