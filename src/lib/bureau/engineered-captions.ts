import type { CaptionCue } from '../review/timeline';
import type { WordTiming } from '../voice/timings';
import type { KeywordRole, ShotGraphics } from './graphics';

/**
 * Captions for the 3D explainer (0052): 2–4 words at a time, with the beat's keyword coloured
 * by its role. Pure; the assembler builds them from the timed words and each shot's window, and
 * the composition only draws what it is given.
 */

export interface KeywordCue extends CaptionCue {
  /** Which word of `words` is the keyword, and its colour role. Absent → no word coloured. */
  keyword?: { index: number; role: KeywordRole };
}

export const CUE_MAX_WORDS = 4;
export const CUE_MIN_WORDS = 2;

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * Chunks of at most four words. A chunk ends early on a pause (> `gapS`) or after a word that
 * ends a clause (. , ; : ? ! —) once it has two words; a lone trailing word joins the chunk
 * before it rather than flashing on its own.
 */
export function chunkWords(words: readonly WordTiming[], gapS = 0.45): WordTiming[][] {
  const out: WordTiming[][] = [];
  let cur: WordTiming[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (cur.length >= CUE_MAX_WORDS || w.start - prev.end > gapS || (cur.length >= CUE_MIN_WORDS && /[.,;:?!—–]$/.test(prev.w)))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  // Fold a single-word tail into the previous chunk when it still fits the cap.
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].length === 1 && out[i - 1].length < CUE_MAX_WORDS && out[i][0].start - out[i - 1][out[i - 1].length - 1].end <= gapS) {
      out[i - 1] = [...out[i - 1], ...out[i]];
      out.splice(i, 1);
    }
  }
  return out;
}

/**
 * The cues, with each beat's keyword marked in the first cue of that beat that contains it
 * (matched on the word, case and punctuation ignored, a plural or suffix allowed: "brake"
 * matches "brakes"). A keyword is coloured once per beat — colouring it every time it recurs
 * would make it noise.
 */
export function engineeredCues(words: readonly WordTiming[], beats: readonly { startS: number; endS: number; graphics: ShotGraphics | null }[]): KeywordCue[] {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const used = new Set<number>();
  // Chunked WITHIN each beat: a caption never straddles a cut, so the words on screen belong
  // to the picture on screen, and a keyword is coloured in its own beat. (The first version
  // chunked the whole track; the line gap is shorter than a pause, so "aside. Then gravity
  // drops" ran across two beats — verify:engineered §7.)
  const beatOf = (w: WordTiming) => beats.findIndex((b) => (w.start + w.end) / 2 >= b.startS && (w.start + w.end) / 2 < b.endS);
  const groups: { bi: number; words: WordTiming[] }[] = [];
  for (const w of words) {
    const bi = beatOf(w);
    const last = groups[groups.length - 1];
    if (last && last.bi === bi) last.words.push(w);
    else groups.push({ bi, words: [w] });
  }
  return groups.flatMap((g) => chunkWords(g.words).map((c) => ({ c, bi: g.bi }))).map(({ c, bi }) => {
    const cue: KeywordCue = { startS: round(c[0].start), endS: round(c[c.length - 1].end), text: c.map((w) => w.w).join(' '), words: c };
    const kw = bi >= 0 ? beats[bi].graphics?.keyword : undefined;
    if (kw && !used.has(bi)) {
      const k = norm(kw.word);
      const index = c.findIndex((w) => {
        const n = norm(w.w);
        return n === k || (k.length >= 4 && n.startsWith(k) && n.length - k.length <= 3);
      });
      if (index >= 0) {
        cue.keyword = { index, role: kw.role };
        used.add(bi);
      }
    }
    return cue;
  });
}
