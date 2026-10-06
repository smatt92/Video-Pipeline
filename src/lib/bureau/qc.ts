import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { routed, type RouterDeps } from '../llm/router';

const run = promisify(execFile);

/**
 * Quality control for a generated clip, before it reaches the cut.
 *
 *   signal  ffmpeg blackdetect + freezedetect over the clip; loudness (EBU R128 integrated)
 *           over the final mix, against −14 LUFS
 *   vision  frames sampled at 1–2 fps → the judge-tier model scores artifacts, garbled
 *           text, extra limbs, and similarity to the character's locked reference frame
 *
 * A clip that fails is re-rolled (gen_jobs.reroll_of) up to `channel_policy.rerolls_max`
 * (2); after that it goes to the cut as it is, flagged, and Sahil decides. Every verdict is
 * stored on `episodes.qc` keyed by shot so the Cuts page shows why.
 *
 * Scores are null when they could not be measured — never 0. A vision call that could not be
 * priced or failed leaves `vision: null` and the clip is flagged "unscored", not passed.
 */

// ── Parsers (pure) ───────────────────────────────────────────────────────────

export interface Interval {
  start: number;
  end: number;
}

export function parseBlack(stderr: string): Interval[] {
  return [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}

export function parseFreeze(stderr: string): Interval[] {
  const starts = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return starts.map((s, i) => ({ start: s, end: ends[i] ?? Number.POSITIVE_INFINITY }));
}

/** The integrated loudness from ebur128's summary block. Null when absent — not 0 LUFS. */
export function parseLoudness(stderr: string): number | null {
  const summary = stderr.split(/Summary:/).pop() ?? '';
  const m = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(summary);
  if (!m || m[1] === '-inf') return null;
  return Number(m[1]);
}

export const LOUDNESS_TARGET = -14;
export const LOUDNESS_TOLERANCE = 1;

export interface SignalQc {
  black: Interval[];
  freeze: Interval[];
  passed: boolean;
  reasons: string[];
}

/** Black/freeze over a clip. Thresholds tuned for navy paper, which is dark but not black. */
export async function signalQc(path: string, durationS: number): Promise<SignalQc> {
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', path, '-vf', 'blackdetect=d=0.4:pix_th=0.05,freezedetect=n=0.002:d=1.2', '-an', '-f', 'null', '-'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const black = parseBlack(String(stderr));
  const freeze = parseFreeze(String(stderr)).map((f) => ({ start: f.start, end: Number.isFinite(f.end) ? f.end : durationS }));
  const reasons: string[] = [];
  const blackS = black.reduce((n, b) => n + (b.end - b.start), 0);
  const freezeS = freeze.reduce((n, f) => n + (f.end - f.start), 0);
  if (blackS > 0.4) reasons.push(`${blackS.toFixed(1)} s of black`);
  if (freezeS > Math.max(1.2, durationS * 0.35)) reasons.push(`${freezeS.toFixed(1)} s frozen`);
  return { black, freeze, passed: reasons.length === 0, reasons };
}

export async function measureLoudness(path: string): Promise<number | null> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128', '-vn', '-f', 'null', '-'], { maxBuffer: 32 * 1024 * 1024 });
  return parseLoudness(String(stderr));
}

/** Two-pass-free loudnorm to the target; used on the VO+music mix before the final render. */
export async function normaliseLoudness(input: string, output: string): Promise<void> {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-af', `loudnorm=I=${LOUDNESS_TARGET}:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', output]);
}

// ── Vision ───────────────────────────────────────────────────────────────────

export const VisionSchema = z.object({
  artifacts: z.number().min(0).max(1),
  garbled_text: z.number().min(0).max(1),
  extra_limbs: z.number().min(0).max(1),
  character_similarity: z.number().min(0).max(1).nullable(),
  style_match: z.number().min(0).max(1),
  notes: z.string(),
});
export type VisionScores = z.infer<typeof VisionSchema>;

export const VISION_LIMITS = { artifacts: 0.35, garbled_text: 0.3, extra_limbs: 0.25, character_similarity: 0.6, style_match: 0.5 } as const;

export function visionVerdict(s: VisionScores): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (s.artifacts > VISION_LIMITS.artifacts) reasons.push(`artifacts ${s.artifacts}`);
  if (s.garbled_text > VISION_LIMITS.garbled_text) reasons.push(`garbled text ${s.garbled_text}`);
  if (s.extra_limbs > VISION_LIMITS.extra_limbs) reasons.push(`extra limbs ${s.extra_limbs}`);
  if (s.character_similarity !== null && s.character_similarity < VISION_LIMITS.character_similarity) reasons.push(`off-model ${s.character_similarity}`);
  if (s.style_match < VISION_LIMITS.style_match) reasons.push(`off-style ${s.style_match}`);
  return { passed: reasons.length === 0, reasons };
}

/** Sample frames at `fps`, 512 px tall, as base64 PNG. */
export async function sampleFrames(path: string, fps = 1.5, max = 8): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-qc-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-i', path, '-vf', `fps=${fps},scale=-2:512`, '-frames:v', String(max), join(dir, 'f%03d.png')]);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    return Promise.all(files.map(async (f) => (await readFile(join(dir, f))).toString('base64')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const VISION_SYSTEM =
  'You are the QC reviewer for "Bureau of Reality", a stick-figure office sitcom: white chalk-line figures with ONE accent colour each, on navy blueprint paper. Score the sampled frames of one generated clip, each 0–1: artifacts (warping, smearing, flicker), garbled_text (any rendered text or pseudo-letters — the style has none), extra_limbs (extra or missing arms/legs/heads), character_similarity vs the reference frame (null if no reference is given), style_match (chalk line on navy, not 3D, not photoreal, not anime, not kid-coded). Be strict; a human reviews anything you pass.';

export async function visionQc(input: { frames: string[]; referencePng: string | null; description: string }, deps: RouterDeps) {
  const content = [
    { type: 'text' as const, text: `Shot: ${input.description}` },
    ...(input.referencePng ? [{ type: 'text' as const, text: 'Reference frame (the locked character):' }, { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: input.referencePng } }] : []),
    { type: 'text' as const, text: `Sampled frames (${input.frames.length}):` },
    ...input.frames.map((data) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data } })),
  ];
  const r = await routed({ task: 'vision_qc', system: VISION_SYSTEM, user: content, schema: VisionSchema, maxTokens: 600 }, deps);
  return { scores: r.data, ...visionVerdict(r.data), model: r.model, costInr: r.costInr };
}
