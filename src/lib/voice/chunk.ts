/**
 * Splitting a script's voiceover into synthesis chunks.
 *
 * Addendum 02 §2: chunk to 200–500 words and stitch with request ids. The reason is a
 * documented, repeatable vendor failure — language and accent drift on long single
 * generations — so this is not an optimisation, it is the thing that keeps one script
 * sounding like one person.
 *
 * ── Split on sentences, never mid-sentence ───────────────────────────────────
 *
 * A chunk boundary is a seam in the audio. Stitching carries prosody across it, but a seam
 * inside a clause is audible even when the voice matches, because the model has no way to
 * know the sentence continues. Sentence ends are the only defensible cut points, so the
 * word ceiling is a target rather than a hard limit — a long sentence overruns it rather
 * than being cut in half.
 *
 * The character caps are hard, though. They come from the model, not from taste, and
 * exceeding one is a rejected request rather than a worse-sounding one.
 */

export interface Chunk {
  idx: number;
  text: string;
  /** Character offset into the full `vo_text` where this chunk starts. */
  charStart: number;
  charEnd: number;
  words: number;
}

export interface ChunkOptions {
  /** Target ceiling. Exceeded rather than splitting a sentence. */
  maxWords?: number;
  /** Below this, a trailing fragment is merged back into the previous chunk. */
  minWords?: number;
  /** Hard, from the model. `eleven_v3` is 5k, `eleven_multilingual_v2` is 10k. */
  maxChars: number;
}

export class ChunkError extends Error {}

/** Sentence ends, keeping the terminator with the sentence it belongs to. */
function sentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match[0].trim()) out.push({ text: match[0], start: match.index });
  }
  return out.length > 0 ? out : [{ text, start: 0 }];
}

const countWords = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function chunkVoText(voText: string, opts: ChunkOptions): Chunk[] {
  const maxWords = opts.maxWords ?? 500;
  const minWords = opts.minWords ?? 200;

  const parts = sentences(voText);
  const chunks: Chunk[] = [];

  let buffer = '';
  let bufferStart = parts[0]?.start ?? 0;

  const flush = () => {
    const text = buffer.trim();
    if (!text) return;
    // Offsets refer to the *original* text, so the trim has to be accounted for or every
    // shot span downstream is shifted by the leading whitespace.
    const lead = buffer.length - buffer.trimStart().length;
    const start = bufferStart + lead;
    chunks.push({
      idx: chunks.length,
      text,
      charStart: start,
      charEnd: start + text.length,
      words: countWords(text),
    });
    buffer = '';
  };

  for (const part of parts) {
    const candidate = buffer + part.text;

    // The character cap is the model's, and exceeding it is a rejection rather than a
    // degradation. It wins over the word target.
    if (buffer && candidate.length > opts.maxChars) {
      flush();
      bufferStart = part.start;
      buffer = part.text;
      continue;
    }

    if (buffer && countWords(candidate) > maxWords) {
      flush();
      bufferStart = part.start;
      buffer = part.text;
      continue;
    }

    if (!buffer) bufferStart = part.start;
    buffer = candidate;
  }
  flush();

  // A short tail is a seam bought for nothing. Merged back, unless that would breach the
  // character cap — in which case the seam is the cheaper problem.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    const merged = voText.slice(prev.charStart, last.charEnd);

    if (last.words < minWords && merged.length <= opts.maxChars) {
      chunks.splice(chunks.length - 2, 2, {
        idx: prev.idx,
        text: merged,
        charStart: prev.charStart,
        charEnd: last.charEnd,
        words: countWords(merged),
      });
    }
  }

  const oversized = chunks.find((c) => c.text.length > opts.maxChars);
  if (oversized) {
    throw new ChunkError(
      `Chunk ${oversized.idx} is ${oversized.text.length} characters, over the model's ` +
        `${opts.maxChars} limit, and it is a single sentence so there is no seam to use. ` +
        'Shorten the sentence in the script rather than splitting mid-clause — a seam ' +
        'inside a clause is audible even when the voice matches.',
    );
  }

  return chunks;
}
