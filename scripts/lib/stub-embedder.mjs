/**
 * A deterministic embedder for harnesses: 768 numbers from a hash of the text, unit length.
 *
 * It is an INPUT, never the thing asserted. What the harness asserts is what the code did
 * with the vectors — the similarity pgvector computed, the result stored on the brief, the
 * refusal lifted — so a stub whose numbers mean nothing semantically is the right shape:
 * two different texts land far apart, the same text lands on itself.
 */
import { createHash } from 'node:crypto';

export function stubVector(text, dims = 768) {
  const out = [];
  let block = 0;
  while (out.length < dims) {
    const h = createHash('sha256').update(`${block++}:${text}`).digest();
    for (let i = 0; i + 1 < h.length && out.length < dims; i += 2) out.push(h.readInt16BE(i) / 32768);
  }
  const norm = Math.sqrt(out.reduce((n, v) => n + v * v, 0));
  return out.map((v) => v / norm);
}

export const stubEmbedder = async (texts) => ({ ok: true, model: 'harness-stub', vectors: texts.map((t) => stubVector(t)) });
