/**
 * The product tour, as data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this is a data file and not two components
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There are two renderers: a 3D sequence and a flat one. The flat one is not a degraded
 * version — it is what reduced-motion users, anyone without WebGL, and anyone whose context
 * is lost mid-sequence actually see, and between them that is not a rounding error.
 *
 * If the copy lived inside the 3D scene, the fallback would drift into a summary of the
 * tour rather than the tour. Keeping the words here makes "the same content" enforceable
 * instead of aspirational: both renderers read this array, and a step added for one appears
 * in the other or does not exist.
 *
 * What the 3D layer may add is *spatial* explanation — where a stage sits relative to the
 * others, what flows into what. Never a sentence the flat version does not have.
 *
 * ── Five, and why not six ────────────────────────────────────────────────────
 *
 * Completion drops sharply past five steps, and this tour is in front of sign-in where the
 * audience has the least invested. Five is a ceiling rather than a target — `spatial` is
 * optional precisely so a step can be cheap.
 */

export interface TourStep {
  /** Stable, so a resumed or replayed tour can address a step by name. */
  id: string;
  title: string;
  /** The claim. One or two sentences — this is read standing up, not sitting down. */
  body: string;
  /**
   * What the 3D layer should show. Advisory: the flat renderer ignores it, and a step is
   * complete without it.
   */
  spatial?: string;
}

export const TOUR: readonly TourStep[] = [
  {
    id: 'what',
    title: 'Kiln makes short videos, and tells you what each one cost.',
    body:
      'Trend to published, as one pipeline: find the idea, write it, shoot it with AI models, ' +
      'cut it, review it, publish it, measure it. The part most tools skip is the last two — ' +
      'so Kiln attaches a rupee figure to every call and carries it all the way to cost per ' +
      'thousand views.',
    spatial: 'The eleven stages as a single track, end to end, seen from the side.',
  },
  {
    id: 'audio-first',
    title: 'The voiceover is recorded before the picture.',
    body:
      'Word timings decide how long each shot needs to be. Generate video first and you are ' +
      'guessing from a word count, then paying a video model to be wrong. Kiln runs the ' +
      'voice stage before the video stage — the expensive artifact is cut to something ' +
      'already measured.',
    spatial: 'Stage 6 lighting before stage 5, out of numeric order, with the timings ' +
      'flowing forward into shot lengths.',
  },
  {
    id: 'refusal',
    title: 'It refuses rather than guessing.',
    body:
      'No verified price for a model? It will not submit the call. No proven recipe for a ' +
      'shot? It will not invent one. Every refusal names what is missing and what would ' +
      'clear it. This is the behaviour that keeps a pipeline from spending real money on ' +
      'something nobody can explain afterwards.',
    spatial: 'A stage lit amber, held, with the blocker named beside it.',
  },
  {
    id: 'review',
    title: 'A human approves every video, and the database enforces it.',
    body:
      'Publishing is blocked by a constraint, not by politeness — there is no admin override ' +
      'and no force flag. The review screen shows you what a player cannot: whether the ' +
      'picture has drifted from the voice, which clips are missing, and whether this video is ' +
      'built the same way as the last one.',
    spatial: 'The gate between stage 8 and stage 10, closed, with the review row as the key.',
  },
  {
    id: 'cost',
    title: 'Every call that costs money writes a row before it happens.',
    body:
      'Not after, and not on success — before. Cost per video cannot be reconstructed later, ' +
      'so it is recorded at the moment of spending or the spending does not happen. That is ' +
      'the number this whole thing is built to answer.',
    spatial: 'The ledger accumulating underneath the track as each stage fires.',
  },
];

if (TOUR.length > 5) {
  // A build-time shout rather than a lint rule, because the constraint is a product
  // decision about completion rates and belongs next to the content it constrains.
  throw new Error(
    `The tour has ${TOUR.length} steps. Five is the ceiling — completion drops sharply past ` +
      'it, and this runs in front of sign-in where the audience has least invested.',
  );
}
