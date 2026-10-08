import { z } from 'zod';

import { FORMAT_INFO, MOTION_INFO, MotionLevelSchema, PACE_INFO, VisualFormatSchema, VoicePaceSchema, type MotionLevel, type VisualFormat, type VoicePace } from '../bureau/formats';

/**
 * The Studio's "Video settings" panel (canvas: GlassStudio): video type, motion and voice
 * pace, folded into the message the session sends so `draft_brief` receives them as words in
 * the conversation — the same way a person typing "3D explainer, full motion" would. Nothing
 * here writes a brief; the model still calls the tool, and Approvals still decides.
 *
 * Zod at the boundary: the three values arrive as form fields from the browser.
 */

export const StudioSettingsSchema = z
  .object({
    video_type: VisualFormatSchema,
    motion: MotionLevelSchema,
    pace: VoicePaceSchema,
  })
  .strict();
export type StudioSettings = z.infer<typeof StudioSettingsSchema>;

const MARK = 'Video settings (from the Studio panel):';

/**
 * Settings from a submitted form. `null` when the form carried none (the composer with the
 * panel untouched); an error string when it carried values that are not ours.
 */
export function settingsFromForm(get: (k: string) => FormDataEntryValue | null): { ok: true; settings: StudioSettings | null } | { ok: false; message: string } {
  const raw = { video_type: get('video_type'), motion: get('motion'), pace: get('pace') };
  if (raw.video_type === null && raw.motion === null && raw.pace === null) return { ok: true, settings: null };
  const parsed = StudioSettingsSchema.safeParse({ video_type: String(raw.video_type ?? ''), motion: String(raw.motion ?? ''), pace: String(raw.pace ?? '') });
  if (!parsed.success) return { ok: false, message: 'The video settings were not recognised — reload the page and pick them again.' };
  return { ok: true, settings: parsed.data };
}

/** The settings as one sentence appended to the message. Idempotent: never appended twice. */
export function foldSettings(text: string, s: StudioSettings | null): string {
  if (!s || text.includes(MARK)) return text;
  const type = `${FORMAT_INFO[s.video_type].label} (video_type "${s.video_type}")`;
  const motion = s.video_type === 'engineered' ? `; motion ${MOTION_INFO[s.motion].label.toLowerCase()} ("${s.motion}")` : '';
  const pace = `; voice pace ${PACE_INFO[s.pace].label.toLowerCase()}`;
  const line = `${MARK} ${type}${motion}${pace}. Use these when you draft the brief.`;
  return text.trim() ? `${text.trim()}\n\n${line}` : line;
}

export function describeType(t: VisualFormat): string {
  return FORMAT_INFO[t].label;
}
export type { MotionLevel, VisualFormat, VoicePace };
