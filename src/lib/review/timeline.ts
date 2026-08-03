import type { WordTiming } from '../voice/timings';

/**
 * The review timeline — picture, voice, and whether they still agree.
 *
 * Pure functions over plain data, no database and no React, for the usual reason: the
 * harness runs *these* and the screen runs these, so what is verified is what ships.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The thing this module exists to catch
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Shot durations are derived from word timings — Addendum 02 §1, the audio-first
 * inversion: stage 6 runs before stage 5 so that picture is generated against measured
 * speech rather than a word-count guess. Every shot's length is therefore a claim about
 * how long a specific span of the voiceover takes to say.
 *
 * A reviewer dragging an in/out handle breaks that claim, and breaks it silently. The clip
 * gets shorter; the voiceover does not. Everything downstream still works — the concat
 * succeeds, the file plays, the captions render — and from shot three onward the words are
 * spoken over the wrong pictures. It looks like a cut that is slightly off rather than like
 * a bug, which is exactly why it would survive review.
 *
 * So `buildTimeline` does not just lay shots end to end. It carries each shot's VO span
 * alongside its picture span and reports the drift between them, cumulatively, because the
 * error accumulates: a 0.4s trim on shot one moves every later shot 0.4s earlier relative
 * to the audio.
 *
 * Three bugs in the assembly path have now produced a file that plays and is wrong, and
 * duration caught all three. This is the same check moved one stage earlier, to the point
 * where a human is about to say the cut is fine.
 */

export interface TimelineShot {
  id: string;
  idx: number;
  description: string;
  /** What was generated and billed. Never mutated by a trim. */
  durationS: number;
  /** What the cut uses: the trim window, or `durationS` when untrimmed. */
  effectiveDurationS: number;
  trimInS: number | null;
  trimOutS: number | null;
  status: string;
  /** Character span of `vo_text` this shot covers. Null for a deliberate silent frame. */
  voCharStart: number | null;
  voCharEnd: number | null;
  /** Whether the duration was measured from speech or is still the shotlist estimate. */
  durationSource: string;
  assetKey: string | null;
  /** Whether the asset has been normalised. A non-normalised clip cannot be concatenated. */
  normalised: boolean;
}

export interface TimelineSpan {
  shot: TimelineShot;
  /** Where this shot sits in the cut. */
  startS: number;
  endS: number;
  /**
   * Where the speech this shot was cut to sits on the voiceover timeline, or null when the
   * shot covers no speech.
   */
  voStartS: number | null;
  voEndS: number | null;
  /**
   * Seconds the picture has drifted from the voice by the time this shot starts. Positive
   * means the picture is running ahead — the words for this shot have not been said yet.
   */
  driftS: number | null;
}

export interface Timeline {
  spans: TimelineSpan[];
  /** Sum of the effective durations. What the render will be. */
  pictureDurationS: number;
  /** Last word end across every chunk. What the voiceover is. */
  voDurationS: number;
  /**
   * The largest absolute drift at any shot boundary — every boundary, not only the ones
   * over tolerance.
   *
   * Counting only the flagged ones was the first version and it was quietly dishonest: a
   * cut whose shots were each 0.24s adrift reported `worstDriftS: 0`, which reads as
   * "perfectly aligned" and means "under the threshold". The threshold decides what gets
   * flagged; it does not get to decide what the number is.
   *
   * This is the number that says whether a cut is watchable, not the total-length
   * difference — a cut can be exactly the right length overall and two seconds out in the
   * middle.
   */
  worstDriftS: number;
  /** Shots whose drift exceeds the tolerance, in order. */
  driftedShotIds: string[];
}

/**
 * How far picture and voice may separate before it is worth a person's attention.
 *
 * A quarter of a second. Below that a viewer reads it as edit rhythm; above it the mouth
 * and the words are visibly apart. Deliberately not zero — word timings are measured to
 * the millisecond and shot boundaries land on frames, so exact agreement is not achievable
 * and demanding it would flag every cut.
 */
export const DRIFT_TOLERANCE_S = 0.25;

/** Whole VO for a script: every chunk's words, already shifted onto one timeline. */
export function mergeTakes(
  takes: readonly { chunkIdx: number; offsetS: number; words: readonly WordTiming[] }[],
): WordTiming[] {
  return [...takes]
    .sort((a, b) => a.chunkIdx - b.chunkIdx)
    .flatMap((take) =>
      take.words.map((w) => ({
        w: w.w,
        start: round(w.start + take.offsetS),
        end: round(w.end + take.offsetS),
      })),
    );
}

export function buildTimeline(
  shots: readonly TimelineShot[],
  voText: string,
  words: readonly WordTiming[],
): Timeline {
  const ordered = [...shots].sort((a, b) => a.idx - b.idx);
  const charToTime = characterTimeIndex(voText, words);

  const spans: TimelineSpan[] = [];
  let cursor = 0;
  let worstDriftS = 0;
  const driftedShotIds: string[] = [];

  for (const shot of ordered) {
    const startS = round(cursor);
    const endS = round(cursor + shot.effectiveDurationS);

    const voStartS =
      shot.voCharStart === null ? null : charToTime.startAt(shot.voCharStart);
    const voEndS = shot.voCharEnd === null ? null : charToTime.endBefore(shot.voCharEnd);

    // Drift is measured at the *start* of the shot, not from its length. A shot can be the
    // right length and in the wrong place because an earlier one was trimmed, and that is
    // the case a per-shot length check misses entirely.
    const driftS = voStartS === null ? null : round(startS - voStartS);

    if (driftS !== null) {
      worstDriftS = Math.max(worstDriftS, Math.abs(driftS));
      if (Math.abs(driftS) > DRIFT_TOLERANCE_S) driftedShotIds.push(shot.id);
    }

    spans.push({ shot, startS, endS, voStartS, voEndS, driftS });
    cursor = endS;
  }

  return {
    spans,
    pictureDurationS: round(cursor),
    voDurationS: words.length === 0 ? 0 : round(words[words.length - 1].end),
    worstDriftS: round(worstDriftS),
    driftedShotIds,
  };
}

/**
 * Character offset → time, both ends.
 *
 * The same walk `deriveShotDurations` does, and deliberately the same walk rather than a
 * shared helper: that function is stage 6 deciding what to generate, this is stage 8
 * checking what was generated, and the two agreeing *by construction* would mean the check
 * cannot catch a mistake in the derivation. It is written to agree by producing the same
 * answer from the same inputs, which is a check; sharing the code would make it a tautology.
 */
function characterTimeIndex(voText: string, words: readonly WordTiming[]) {
  const wordStartChar: number[] = [];
  let cursor = 0;
  for (const word of words) {
    while (cursor < voText.length && /\s/.test(voText[cursor])) cursor++;
    wordStartChar.push(cursor);
    cursor += word.w.length;
  }

  return {
    /** Start of the first word at or after this character. */
    startAt(char: number): number | null {
      const i = wordStartChar.findIndex((c) => c >= char);
      return i === -1 ? null : round(words[i].start);
    },
    /** End of the last word before this character. */
    endBefore(char: number): number | null {
      const i = wordStartChar.findIndex((c) => c >= char);
      const last = i === -1 ? words.length - 1 : i - 1;
      return last < 0 ? null : round(words[last].end);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Captions
// ═════════════════════════════════════════════════════════════════════════════

export interface CaptionCue {
  startS: number;
  endS: number;
  text: string;
  words: WordTiming[];
}

/**
 * Group word timings into caption cues.
 *
 * Two rules, both from what a caption is for rather than from what is easy: a cue breaks
 * when it would exceed `maxChars`, and it breaks on a gap longer than `gapS` because a
 * pause is where a sentence ends far more reliably than punctuation is — the timings come
 * from the *normalised* alignment, which is what was spoken, and "$5" was spoken as "five
 * dollars" with no punctuation anywhere near it.
 */
export function captionCues(
  words: readonly WordTiming[],
  options: { maxChars?: number; gapS?: number } = {},
): CaptionCue[] {
  const maxChars = options.maxChars ?? 42;
  const gapS = options.gapS ?? 0.45;

  const cues: CaptionCue[] = [];
  let current: WordTiming[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      startS: round(current[0].start),
      endS: round(current[current.length - 1].end),
      text: current.map((w) => w.w).join(' '),
      words: current,
    });
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    const wouldBeTooLong =
      current.map((w) => w.w).join(' ').length + word.w.length + 1 > maxChars;
    const gap = previous ? word.start - previous.end : 0;

    if (previous && (wouldBeTooLong || gap > gapS)) flush();
    current.push(word);
  }
  flush();

  return cues;
}

// ═════════════════════════════════════════════════════════════════════════════
// Editing gestures
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Move one shot to a new position and return the complete id order.
 *
 * Complete, because `reorder_shots` rejects a partial list — a caller holding three of five
 * ids has a stale view, and renumbering against it drops the other two wherever the scan
 * left them. Returning the whole order makes the stale case a database error rather than a
 * silently reordered cut.
 */
export function moveShot(shots: readonly TimelineShot[], shotId: string, toPosition: number): string[] {
  const ordered = [...shots].sort((a, b) => a.idx - b.idx);
  const from = ordered.findIndex((s) => s.id === shotId);
  if (from === -1) return ordered.map((s) => s.id);

  const to = Math.max(0, Math.min(ordered.length - 1, toPosition));
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  return ordered.map((s) => s.id);
}

export type TrimResult =
  | { ok: true; trimInS: number | null; trimOutS: number | null }
  | { ok: false; reason: string };

/**
 * Validate an in/out window against the clip that exists.
 *
 * The same rule as the CHECK constraint in 0018, applied before the round trip so a dragged
 * handle gets a sentence rather than a Postgres error. Both exist on purpose: this one is
 * for the person, that one is for correctness, and only the second one is load-bearing.
 */
export function validateTrim(
  shot: Pick<TimelineShot, 'durationS'>,
  next: { inS: number | null; outS: number | null },
): TrimResult {
  const { inS, outS } = next;

  if (inS === null && outS === null) return { ok: true, trimInS: null, trimOutS: null };

  if (inS === null || outS === null) {
    return {
      ok: false,
      reason:
        'Both handles or neither. A half-set window is a state a drag passes through, and ' +
        'stored it would produce a segment of no length.',
    };
  }

  if (inS < 0) return { ok: false, reason: 'The in point cannot be before the clip starts.' };

  if (outS <= inS) {
    return { ok: false, reason: 'The out point must be after the in point.' };
  }

  if (outS > shot.durationS + 0.001) {
    return {
      ok: false,
      reason:
        `The out point is ${round(outS)}s but the clip is only ${shot.durationS}s long. ` +
        'Trimming can only remove; there is nothing past the end to keep.',
    };
  }

  return { ok: true, trimInS: round(inS), trimOutS: round(outS) };
}

/** Milliseconds. Enough for word timings, and it keeps float noise out of the comparisons. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
