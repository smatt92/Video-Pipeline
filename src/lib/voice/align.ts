import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { WordTiming } from './timings';

const run = promisify(execFile);

/**
 * Forced alignment of synthesised speech against the script it was synthesised from.
 *
 * The voice vendor's TTS endpoint returns audio and no timestamps (plan v2.2, Prompt H). Shot
 * durations derive from word timings (Addendum 02 §1), so they have to be recovered here,
 * on the Trigger worker, from the audio and the KNOWN text.
 *
 * ── Method: DTW against a synthetic reference ─────────────────────────────────
 *
 * The classic TTS-reference aligner (the approach aeneas takes): synthesise each script word
 * with espeak-ng, so the reference's word boundaries are known exactly by construction;
 * compute MFCCs of reference and target; dynamic-time-warp one onto the other; carry each
 * reference boundary through the warping path into target time. CPU only, no model download,
 * two apt packages on the worker (espeak-ng, ffmpeg — see trigger.config.ts).
 *
 * It aligns one LINE at a time — each line is its own synthesis, so a line is the natural
 * unit and keeps the DTW matrix to ~500×500 rather than a minute of audio squared.
 *
 * ── It refuses rather than guesses ────────────────────────────────────────────
 *
 * Returns `null` timings — not zeros, not an even split — when: a binary is missing, the
 * audio is unreadable, the aligned word count differs from the script's, any word comes out
 * shorter than 40 ms, or the mean path cost is above `MAX_PATH_COST` (the audio does not
 * sound like these words). Null timings leave `derived_from_vo` unset, so stage 5 keeps
 * refusing and v_pipeline_blockers names the reason. That is the behaviour Prompt H asks for.
 */

export const SAMPLE_RATE = 16_000;
const FRAME = 400; // 25 ms
const HOP = 160; // 10 ms
const N_MELS = 26;
const N_MFCC = 13;
/**
 * Confidence is RELATIVE, not absolute. An absolute path cost depends on how different the
 * vendor's voice is from espeak's, which nobody here has measured. So the reference is also
 * warped against the target played BACKWARDS — same sounds, same length, wrong order — and
 * the alignment is accepted only when the forward fit costs at most this fraction of the
 * backward one. A wrong sentence fits both about equally badly (ratio ≈ 1); matched speech
 * fits forwards far better. (A reversed word-order reference was tried first and failed on a
 * five-word line: short lines reordered are still similar.) Calibrated in test:align and
 * verify:episode on espeak-vs-espeak in a different voice, speed and pitch; NOT yet on vendor
 * audio (0008).
 */
export const MAX_COST_RATIO = 0.7;
const MIN_WORD_S = 0.04;

export type AlignResult =
  | { ok: true; words: WordTiming[]; meanCost: number; costRatio: number; durationS: number }
  | { ok: false; code: 'tool_missing' | 'unreadable' | 'count_mismatch' | 'low_confidence' | 'degenerate'; detail: string; meanCost?: number; costRatio?: number };

/** The script tokens exactly as `deriveShotDurations` walks them: whitespace-split. */
export function scriptWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

// ── Audio in and out ─────────────────────────────────────────────────────────

export async function decodePcm(path: string): Promise<Float32Array> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  const buf = stdout as unknown as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
}

/** One word, spoken by the reference voice. Numbers and symbols are espeak's to read. */
async function espeakWord(word: string, dir: string, i: number, voice: string): Promise<Float32Array> {
  const wav = join(dir, `w${i}.wav`);
  const clean = word.replace(/["“”‘’()[\]{}]/g, '');
  await run('espeak-ng', ['-v', voice, '-s', '165', '-w', wav, clean || word]);
  return decodePcm(wav);
}

// ── Features ─────────────────────────────────────────────────────────────────

const hann = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const NFFT = 512;

function melFilters(): Float32Array[] {
  const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const fromMel = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const lo = toMel(60);
  const hi = toMel(SAMPLE_RATE / 2 - 200);
  const points = Array.from({ length: N_MELS + 2 }, (_, i) => fromMel(lo + ((hi - lo) * i) / (N_MELS + 1)));
  const bins = points.map((f) => Math.floor(((NFFT + 1) * f) / SAMPLE_RATE));
  return Array.from({ length: N_MELS }, (_, m) => {
    const fb = new Float32Array(NFFT / 2 + 1);
    for (let k = bins[m]; k < bins[m + 1]; k++) fb[k] = (k - bins[m]) / Math.max(1, bins[m + 1] - bins[m]);
    for (let k = bins[m + 1]; k < bins[m + 2]; k++) fb[k] = (bins[m + 2] - k) / Math.max(1, bins[m + 2] - bins[m + 1]);
    return fb;
  });
}
const MEL = melFilters();

function powerSpectrum(frame: Float32Array): Float32Array {
  // Radix-2 FFT, in place, over NFFT points.
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  re.set(frame);
  for (let i = 1, j = 0; i < NFFT; i++) {
    let bit = NFFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < NFFT; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
  const out = new Float32Array(NFFT / 2 + 1);
  for (let k = 0; k <= NFFT / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

/** MFCC 1..12 (c0 dropped — loudness is not content), cepstral-mean normalised. */
export function mfcc(pcm: Float32Array): Float32Array[] {
  const frames: Float32Array[] = [];
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    const f = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) f[i] = (pcm[start + i] - (i ? 0.97 * pcm[start + i - 1] : 0)) * hann[i];
    const p = powerSpectrum(f);
    const logMel = MEL.map((fb) => {
      let s = 0;
      for (let k = 0; k < fb.length; k++) s += fb[k] * p[k];
      return Math.log(s + 1e-10);
    });
    const c = new Float32Array(N_MFCC - 1);
    for (let n = 1; n < N_MFCC; n++) {
      let s = 0;
      for (let m = 0; m < N_MELS; m++) s += logMel[m] * Math.cos((Math.PI * n * (m + 0.5)) / N_MELS);
      c[n - 1] = s;
    }
    frames.push(c);
  }
  if (frames.length) {
    const mean = new Float32Array(N_MFCC - 1);
    for (const f of frames) for (let i = 0; i < mean.length; i++) mean[i] += f[i] / frames.length;
    for (const f of frames) for (let i = 0; i < mean.length; i++) f[i] -= mean[i];
  }
  return frames;
}

// ── DTW ──────────────────────────────────────────────────────────────────────

/** For each reference frame, the target frame the optimal path maps it to; plus mean cost. */
export function dtwMap(ref: Float32Array[], tgt: Float32Array[]): { map: Int32Array; meanCost: number } {
  const n = ref.length;
  const m = tgt.length;
  const cost = new Float32Array(n * m);
  const dist = (a: Float32Array, b: Float32Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
    return Math.sqrt(s);
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = dist(ref[i], tgt[j]);
      if (i === 0 && j === 0) cost[0] = d;
      else {
        const up = i > 0 ? cost[(i - 1) * m + j] : Infinity;
        const left = j > 0 ? cost[i * m + j - 1] : Infinity;
        const diag = i > 0 && j > 0 ? cost[(i - 1) * m + j - 1] : Infinity;
        cost[i * m + j] = d + Math.min(up, left, diag);
      }
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = n - 1;
  let j = m - 1;
  let steps = 1;
  map[i] = j;
  while (i > 0 || j > 0) {
    const up = i > 0 ? cost[(i - 1) * m + j] : Infinity;
    const left = j > 0 ? cost[i * m + j - 1] : Infinity;
    const diag = i > 0 && j > 0 ? cost[(i - 1) * m + j - 1] : Infinity;
    if (diag <= up && diag <= left) {
      i--;
      j--;
    } else if (up <= left) i--;
    else j--;
    if (map[i] === -1) map[i] = j;
    steps++;
  }
  return { map, meanCost: cost[n * m - 1] / steps };
}

// ── The aligner ──────────────────────────────────────────────────────────────

export interface AlignInput {
  audioPath: string;
  text: string;
  /** espeak-ng voice for the reference; "en-us" for this channel. */
  voice?: string;
  maxCostRatio?: number;
}

export async function alignLine(input: AlignInput): Promise<AlignResult> {
  const words = scriptWords(input.text);
  if (!words.length) return { ok: false, code: 'degenerate', detail: 'the line has no words' };

  const dir = await mkdtemp(join(tmpdir(), 'kiln-align-'));
  try {
    let target: Float32Array;
    try {
      target = await decodePcm(input.audioPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, code: /ENOENT/.test(msg) ? 'tool_missing' : 'unreadable', detail: msg };
    }
    if (target.length < FRAME * 4) return { ok: false, code: 'unreadable', detail: 'the audio is shorter than 100 ms' };

    // Reference: each word, a short gap between, silence padding at both ends so leading and
    // trailing silence in the target have something to match.
    const recordings: Float32Array[] = [];
    for (const [i, w] of words.entries()) {
      try {
        recordings.push(trimSilence(await espeakWord(w, dir, i, input.voice ?? 'en-us')));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, code: /ENOENT/.test(msg) ? 'tool_missing' : 'unreadable', detail: `reference synthesis failed for "${w}": ${msg}` };
      }
    }
    const built = buildReference(recordings);
    const refF = mfcc(built.pcm);
    const tgtF = mfcc(target);
    const { map, meanCost } = dtwMap(refF, tgtF);

    // The null: the same target, time-reversed — identical spectral content, wrong order at
    // every scale, so it is discriminative even for a three-word line.
    const nullCost = dtwMap(refF, [...tgtF].reverse()).meanCost;
    const costRatio = meanCost / nullCost;
    const limit = input.maxCostRatio ?? MAX_COST_RATIO;
    if (!(costRatio <= limit)) {
      return {
        ok: false,
        code: 'low_confidence',
        detail: `path cost ${meanCost.toFixed(2)} is ${(costRatio * 100).toFixed(0)}% of the time-reversed null (${nullCost.toFixed(2)}); the limit is ${Math.round(limit * 100)}%`,
        meanCost,
        costRatio,
      };
    }
    const bounds = built.bounds;

    const frameOf = (sample: number) => Math.min(refF.length - 1, Math.max(0, Math.floor((sample - FRAME / 2) / HOP)));
    const toS = (frame: number) => (frame * HOP + FRAME / 2) / SAMPLE_RATE;
    const timings: WordTiming[] = words.map((w, i) => ({
      w,
      start: round3(toS(map[frameOf(bounds[i].start)])),
      end: round3(toS(map[frameOf(bounds[i].end)])),
    }));

    if (timings.length !== words.length) {
      return { ok: false, code: 'count_mismatch', detail: `aligned ${timings.length} words against ${words.length} in the script` };
    }
    for (let i = 0; i < timings.length; i++) {
      if (timings[i].end - timings[i].start < MIN_WORD_S || (i && timings[i].start < timings[i - 1].start)) {
        return { ok: false, code: 'degenerate', detail: `word ${i} ("${timings[i].w}") came out ${(timings[i].end - timings[i].start).toFixed(3)} s long`, meanCost };
      }
    }
    return { ok: true, words: timings, meanCost, costRatio, durationS: round3(target.length / SAMPLE_RATE) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Words joined by a short gap, with silence padding at both ends so leading and trailing
 *  silence in the target have something to match. */
function buildReference(recordings: Float32Array[]): { pcm: Float32Array; bounds: { start: number; end: number }[] } {
  const gap = new Float32Array(Math.round(SAMPLE_RATE * 0.04));
  const pad = new Float32Array(Math.round(SAMPLE_RATE * 0.2));
  const parts: Float32Array[] = [pad];
  const bounds: { start: number; end: number }[] = [];
  let cursor = pad.length;
  for (const pcm of recordings) {
    bounds.push({ start: cursor, end: cursor + pcm.length });
    parts.push(pcm, gap);
    cursor += pcm.length + gap.length;
  }
  parts.push(pad);
  return { pcm: concat(parts), bounds };
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** espeak pads each word with silence; the reference must not, or every boundary shifts. */
function trimSilence(pcm: Float32Array, threshold = 0.01): Float32Array {
  let a = 0;
  let b = pcm.length - 1;
  while (a < b && Math.abs(pcm[a]) < threshold) a++;
  while (b > a && Math.abs(pcm[b]) < threshold) b--;
  return pcm.slice(a, b + 1);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
