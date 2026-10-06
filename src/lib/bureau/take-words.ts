import type { WordTiming } from '../voice/timings';

/**
 * The caption words for one VO take, in take-local seconds.
 *
 * A take the aligner confirmed carries its word timings. A take it could not confirm carries
 * `word_timings = []` — absent, not zero (CLAUDE.md) — and is captioned as ONE span: its whole
 * text over its whole measured duration (ffprobe, from the voice stage). Both edges of that
 * span are measurements; nothing inside it is invented, which is why it is one cue rather than
 * an even split of the words across the line. `captionCues` keeps an over-long first "word" in
 * a cue on its own, so a long unaligned line wraps instead of breaking at a guessed time.
 */
export function takeWords(take: { word_timings: unknown; text_in: string | null; duration_s: number | string | null }): WordTiming[] {
  const w = take.word_timings;
  if (Array.isArray(w) && w.length) return w as WordTiming[];
  const d = take.duration_s === null ? null : Number(take.duration_s);
  if (!take.text_in || d === null || !(d > 0)) return [];
  return [{ w: take.text_in.trim(), start: 0, end: d }];
}
