import { z } from 'zod';

/**
 * The graphics layer of an engineered episode (0052) — what WE draw over a beat, never the
 * image or video model: a numbered stage badge, a verdict pill, callout labels with a leader
 * line, horizontal meters, and the one caption keyword coloured by its role.
 *
 * Pure schema, shared by the brief (shot_list[].graphics), the shot row (`shots.graphics`), the
 * assembler and the Remotion composition. Every position is a fraction of the 9:16 frame and is
 * clamped into the platform's safe box at draw time (src/remotion/bureau/graphics-layer.tsx),
 * so a model-chosen coordinate can never put a label under the right rail or the caption bar.
 */

/** Which colour a caption keyword takes: yellow = mechanism, red = danger, cyan = outcome. */
export const KEYWORD_ROLES = ['mechanism', 'danger', 'outcome'] as const;
export const KeywordRoleSchema = z.enum(KEYWORD_ROLES);
export type KeywordRole = z.infer<typeof KeywordRoleSchema>;

const Frac = z.number().min(0).max(1);
const Short = (max: number) => z.string().trim().min(1).max(max);

export const BadgeSchema = z.object({
  /** The attempt number, drawn ① … ⑨ in a yellow ring. */
  n: z.number().int().min(1).max(9),
  label: Short(24),
});

export const VerdictSchema = z.object({
  pass: z.boolean(),
  /** Line one, e.g. "SPEARS CARS". */
  text: Short(24),
  /** Line two, smaller, e.g. "the end points at traffic". Optional. */
  sub: Short(40).optional(),
});

export const CalloutSchema = z.object({
  label: Short(22),
  /** Where the dot sits (the thing being named), fractions of the frame. Absent → a safe default. */
  x: Frac.optional(),
  y: Frac.optional(),
});

export const MeterSchema = z
  .object({
    label: Short(22),
    /** Bar fill at the start and end of the beat, 0..1 (animated). A static meter gives `value` only. */
    from: Frac.optional(),
    to: Frac.optional(),
    value: Frac.optional(),
    /** The text beside the bar — "≈ 5 tonnes", "falling". Numbers here are checked for a hedge (policy_lint). */
    unit: Short(40),
  })
  .refine((m) => m.value !== undefined || (m.from !== undefined && m.to !== undefined), 'a meter needs value, or from and to');

export const KeywordSchema = z.object({ word: Short(24), role: KeywordRoleSchema });

export const ShotGraphicsSchema = z.object({
  badge: BadgeSchema.optional(),
  verdict: VerdictSchema.optional(),
  callouts: z.array(CalloutSchema).max(3).optional(),
  meters: z.array(MeterSchema).max(2).optional(),
  keyword: KeywordSchema.optional(),
});
export type ShotGraphics = z.infer<typeof ShotGraphicsSchema>;

/** Stored graphics, or null — a malformed stored value is never drawn half-right. */
export function graphicsOf(raw: unknown): ShotGraphics | null {
  if (raw === null || raw === undefined) return null;
  const p = ShotGraphicsSchema.safeParse(raw);
  if (!p.success) return null;
  const g = p.data;
  return g.badge || g.verdict || g.callouts?.length || g.meters?.length || g.keyword ? g : null;
}

/** The circled numerals the badge draws. */
export const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'] as const;

/** Keyword colours (the format reference: yellow mechanism, red danger, cyan outcome). */
export const KEYWORD_COLOURS: Record<KeywordRole, string> = { mechanism: '#FFD23F', danger: '#FF4D3D', outcome: '#3DE0F5' };
