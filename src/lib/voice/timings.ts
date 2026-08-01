import { z } from 'zod';

/**
 * Character timings → word timings → shot durations.
 *
 * The whole audio-first inversion (Addendum 02 §1) rests on this file. VO costs about a
 * hundredth of video generation, so the cheap artifact defines the timeline the expensive
 * one satisfies — which only works if a stretch of `vo_text` can be turned into a number of
 * seconds. That is what this does, and it is pure, so it is the one part of stage 6 that
 * can be proven without reaching the vendor.
 *
 * ── normalized_alignment, never alignment ────────────────────────────────────
 *
 * The response carries both. `alignment` maps to the characters as *submitted*;
 * `normalized_alignment` maps to what was *actually spoken* — "$5" is submitted as two
 * characters and spoken as "five dollars", and a dictionary substitution replaces a word
 * outright.
 *
 * Using the raw alignment would put word boundaries at the wrong offsets whenever the two
 * diverge, and it diverges precisely where this project needs it most: numbers, currency,
 * and the pronunciation dictionary that exists because Indian place names and gaming
 * acronyms are mispronounced by default. The failure is silent — every timing is a
 * plausible number, and the video is out of sync in a way that looks like a rendering bug.
 *
 * The schema below therefore requires `normalized_alignment` and does not accept
 * `alignment` as a substitute. A response missing it is a failure, not a fallback.
 */

/**
 * The documented response shape.
 *
 * **Never validated against a real response.** The vendor host is refused by this
 * environment's egress policy, so this is read from documentation and is exactly the kind
 * of assumption CLAUDE.md rule 8 says is not done. See 0008 for the command that proves it.
 */
export const CharAlignmentSchema = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
});

export const TtsResponseSchema = z.object({
  audio_base64: z.string().min(1),
  /** Required. See the note above about why `alignment` is not an acceptable substitute. */
  normalized_alignment: CharAlignmentSchema,
  alignment: CharAlignmentSchema.optional(),
});

export type CharAlignment = z.infer<typeof CharAlignmentSchema>;

export interface WordTiming {
  w: string;
  start: number;
  end: number;
}

/**
 * Collapse per-character timings into per-word timings.
 *
 * A word runs from the start of its first character to the end of its last. Whitespace
 * separates words and belongs to neither — a trailing space carries the pause *after* a
 * word, and folding it in would make every word overrun into the gap and every shot
 * boundary land late.
 *
 * The three arrays are required to be the same length. They come from the vendor and a
 * mismatch means the response is not what it claims to be; continuing would silently pair
 * a character with another character's timing, which produces plausible numbers that are
 * wrong — the worst available outcome.
 */
export function wordsFromCharacters(alignment: CharAlignment): WordTiming[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } =
    alignment;

  if (characters.length !== starts.length || characters.length !== ends.length) {
    throw new Error(
      `Alignment arrays disagree: ${characters.length} characters, ${starts.length} starts, ` +
        `${ends.length} ends. Pairing them anyway would produce plausible wrong timings.`,
    );
  }

  const words: WordTiming[] = [];
  let current: WordTiming | null = null;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];

    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = null;
      }
      continue;
    }

    if (current === null) {
      current = { w: ch, start: starts[i], end: ends[i] };
    } else {
      current.w += ch;
      // Monotonic by construction rather than by trust: a vendor end time that goes
      // backwards would otherwise shorten a word to nothing and drag a shot boundary with
      // it.
      current.end = Math.max(current.end, ends[i]);
    }
  }

  if (current) words.push(current);
  return words;
}

/** Total spoken length of a take: the end of its last word. */
export function takeDuration(words: readonly WordTiming[]): number {
  return words.length === 0 ? 0 : Math.max(...words.map((w) => w.end));
}

/** A take's words shifted into whole-script time. */
export function shiftBy(words: readonly WordTiming[], offsetS: number): WordTiming[] {
  return words.map((w) => ({ w: w.w, start: w.start + offsetS, end: w.end + offsetS }));
}

// ═════════════════════════════════════════════════════════════════════════════
// Shot durations
// ═════════════════════════════════════════════════════════════════════════════

export interface ShotSpan {
  shotId: string;
  idx: number;
  /** Half-open [start, end) into `vo_text`. Null when the shot covers no speech. */
  voCharStart: number | null;
  voCharEnd: number | null;
  /** What the shotlist estimated. Kept when nothing can be derived. */
  authoredDurationS: number;
}

export type DerivedDuration =
  | { shotId: string; idx: number; durationS: number; source: 'derived_from_vo'; words: number }
  | { shotId: string; idx: number; durationS: number; source: 'authored'; reason: string };

/**
 * Turn a shot's character span into a real duration.
 *
 * The join is by **word index**, not by time. `vo_text` and the spoken words are the same
 * sequence in the same order — the shotlist copied its spans verbatim out of `vo_text`, and
 * the vendor spoke that same string — so counting words up to `vo_char_start` gives the
 * index of the first word the shot is on screen for.
 *
 * Counting rather than matching strings, because a dictionary substitution changes the
 * *word* ("GTA" spoken as "gee tee ay") while leaving its position untouched. Matching text
 * would fail on exactly the words the pronunciation dictionary exists for.
 *
 * A shot whose span yields no words keeps its authored duration and says why. That is the
 * right outcome for a deliberate silent frame, and the honest one for a span that has
 * drifted out of alignment with the text — inventing zero seconds would collapse the shot.
 */
export function deriveShotDurations(
  shots: readonly ShotSpan[],
  voText: string,
  words: readonly WordTiming[],
): DerivedDuration[] {
  // Word index of the first word starting at or after each character offset. Built once:
  // this is a scan over the text, and doing it per shot is the same walk repeated.
  const wordStartChar: number[] = [];
  {
    let cursor = 0;
    for (const word of words) {
      // Skip whitespace, then claim as many characters as the word has. Length rather than
      // content, for the substitution reason above.
      while (cursor < voText.length && /\s/.test(voText[cursor])) cursor++;
      wordStartChar.push(cursor);
      cursor += word.w.length;
    }
  }

  return shots.map((shot) => {
    if (shot.voCharStart === null || shot.voCharEnd === null) {
      return {
        shotId: shot.shotId,
        idx: shot.idx,
        durationS: shot.authoredDurationS,
        source: 'authored' as const,
        reason: 'covers no speech — a deliberate silent frame keeps its authored duration',
      };
    }

    const first = wordStartChar.findIndex((c) => c >= shot.voCharStart!);
    const lastExclusive = wordStartChar.findIndex((c) => c >= shot.voCharEnd!);
    const end = lastExclusive === -1 ? words.length : lastExclusive;

    if (first === -1 || end <= first) {
      return {
        shotId: shot.shotId,
        idx: shot.idx,
        durationS: shot.authoredDurationS,
        source: 'authored' as const,
        reason:
          `span [${shot.voCharStart}, ${shot.voCharEnd}) matched no spoken words — the ` +
          'shotlist and the synthesised text have drifted apart',
      };
    }

    const span = words.slice(first, end);
    const durationS = Math.round((span[span.length - 1].end - span[0].start) * 1000) / 1000;

    return {
      shotId: shot.shotId,
      idx: shot.idx,
      durationS,
      source: 'derived_from_vo' as const,
      words: span.length,
    };
  });
}
