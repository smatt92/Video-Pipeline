import { z } from 'zod';

import { syntheticDisclosure } from '../db/enums';
import type { Db } from '../db/server';
import { MAX_PICTURES_PER_SHOT, SECONDS_PER_PICTURE } from '../bureau/formats';
import { DEFAULT_CAPTION_SCALE, DEFAULT_HOOK_SCALE } from '../../remotion/bureau/text-scale';

/**
 * A channel's generation, assembly and publishing numbers (migration 0049) — the values that
 * were constants until Settings → Generation / Assembly / Publishing existed.
 *
 * ── One reader ───────────────────────────────────────────────────────────────
 *
 * `readTuning(db, channelId)` is the only way any of these columns is read. The estimate on
 * Approvals, the stills step and the assembler all ask it for the picture numbers, so the
 * number of pictures a brief is priced for, drawn with, and cut between can never disagree;
 * the voice stage asks it for the gaps; the assembler for loudness, text sizes and the hook.
 *
 * ── Before 0049 is pasted ────────────────────────────────────────────────────
 *
 * The select names the new columns, so on a database without them it fails with "column
 * does not exist". That is the probe: the result then carries today's constants with
 * `source: 'defaults'` and a reason, and every Settings screen prints the reason. Nothing
 * renders differently either side of the paste until a value is changed.
 */

/** The constants these columns replaced. The 0049 column defaults equal these. */
export const TUNING_DEFAULTS = {
  secondsPerPicture: SECONDS_PER_PICTURE,
  maxPicturesPerShot: MAX_PICTURES_PER_SHOT,
  /** Silence between voice lines, seconds. */
  lineGapS: 0.18,
  /** Hold after the last word, so the loop line lands before the video restarts. */
  tailS: 0.6,
  /** Integrated loudness the VO is normalised to before the render. */
  loudnessLufs: -14,
  captionScale: DEFAULT_CAPTION_SCALE,
  hookScale: DEFAULT_HOOK_SCALE,
  /** Seconds the hook title holds at the start of a Short. */
  hookS: 2,
  madeForKids: false,
  syntheticDisclosure: 'auto' as SyntheticDisclosure,
} as const;

export type SyntheticDisclosure = z.infer<typeof syntheticDisclosure>;

/** Ranges equal the 0049 CHECK constraints — the database refuses what the form refuses. */
export const TuningSchema = z.object({
  secondsPerPicture: z.number().min(2).max(30),
  maxPicturesPerShot: z.number().int().min(1).max(12),
  lineGapS: z.number().min(0).max(2),
  tailS: z.number().min(0).max(5),
  loudnessLufs: z.number().min(-24).max(-9),
  captionScale: z.number().min(0.016).max(0.08),
  hookScale: z.number().min(0.02).max(0.12),
  hookS: z.number().min(0).max(6),
  madeForKids: z.boolean(),
  syntheticDisclosure: syntheticDisclosure,
});
export type Tuning = z.infer<typeof TuningSchema>;
export type TuningKey = keyof Tuning;

/** Column ↔ field. One table, so a write and a read cannot name different columns. */
export const TUNING_COLUMNS = {
  secondsPerPicture: 'seconds_per_picture',
  maxPicturesPerShot: 'max_pictures_per_shot',
  lineGapS: 'line_gap_s',
  tailS: 'tail_s',
  loudnessLufs: 'loudness_target_lufs',
  captionScale: 'caption_scale',
  hookScale: 'hook_scale',
  hookS: 'hook_s',
  madeForKids: 'made_for_kids_default',
  syntheticDisclosure: 'synthetic_disclosure',
} as const satisfies Record<TuningKey, string>;

export type TuningRead =
  | { source: 'channel'; values: Tuning }
  /** The constants, and why — never silently. */
  | { source: 'defaults'; values: Tuning; reason: string };

export const TUNING_NEEDS_0049 = 'These settings need migration 0049 (paste docs/bureau/hosted-migrations-7-0049.sql); until then every channel uses the built-in values shown.';

const isMissingColumn = (msg: string) => /column .* does not exist|could not find .* column|schema cache/i.test(msg);

/** The channel's values, or the constants with the reason. Never throws on a missing column. */
export async function readTuning(db: Db, channelId: string): Promise<TuningRead> {
  const cols = Object.values(TUNING_COLUMNS).join(', ');
  const { data, error } = await db.from('channel_policy').select(cols).eq('channel_id', channelId).maybeSingle();
  if (error) {
    if (isMissingColumn(error.message)) return { source: 'defaults', values: { ...TUNING_DEFAULTS }, reason: TUNING_NEEDS_0049 };
    throw new Error(`Reading channel_policy: ${error.message}`);
  }
  if (!data) return { source: 'defaults', values: { ...TUNING_DEFAULTS }, reason: 'This channel has no policy row; the built-in values apply.' };
  const row = data as unknown as Record<string, unknown>;
  // numeric arrives as a string (CLAUDE.md): Number() here, at the boundary, is a decision —
  // every value is a small bounded figure the CHECKs keep far from 2^53.
  const parsed = TuningSchema.safeParse({
    secondsPerPicture: Number(row.seconds_per_picture),
    maxPicturesPerShot: Number(row.max_pictures_per_shot),
    lineGapS: Number(row.line_gap_s),
    tailS: Number(row.tail_s),
    loudnessLufs: Number(row.loudness_target_lufs),
    captionScale: Number(row.caption_scale),
    hookScale: Number(row.hook_scale),
    hookS: Number(row.hook_s),
    madeForKids: row.made_for_kids_default,
    syntheticDisclosure: row.synthetic_disclosure,
  });
  if (!parsed.success) throw new Error(`channel_policy holds a tuning value outside its range: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return { source: 'channel', values: parsed.data };
}

export interface PictureTuning {
  secondsPerPicture: number;
  maxPicturesPerShot: number;
}

/** The two picture numbers, for the estimate, the stills step and the assembler. */
export async function pictureTuning(db: Db, channelId: string): Promise<PictureTuning> {
  const { values } = await readTuning(db, channelId);
  return { secondsPerPicture: values.secondsPerPicture, maxPicturesPerShot: values.maxPicturesPerShot };
}

/** Whether the altered/synthetic flag is set on a bundle, from the policy and the shots. */
export function syntheticFlag(policy: SyntheticDisclosure, anyRealisticShot: boolean): boolean {
  return policy === 'always' ? true : anyRealisticShot;
}
