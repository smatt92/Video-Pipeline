import { z } from 'zod';

import type { Db } from '../db/server';
import { hookPattern } from '../db/enums';
import { STILL_TAG } from '../drivers/still-image';
import type { Bible, ChannelBible, Series } from './bible';
import { FactSchema } from './policy-lint';
import { ShotGraphicsSchema } from './graphics';

/**
 * The "3D explainer" — the engineered format (0052, format spec
 * `claude/format-engineered-explainer.md`). Everything here is pure except the availability
 * probe at the bottom.
 *
 *   EngineeredDraftSchema   what the writer model returns (prompts/23-engineered.v1.ts) —
 *                           beats with their narration, the picture, the view, whether it is
 *                           an action beat, and the graphics we draw over it
 *   evolutionProblems       the story shape, checked in code: hook → question → the rule →
 *                           numbered attempts each with a verdict → the mechanism with a meter
 *                           → a loop ending. A draft that breaks it is refused, by name
 *   engineeredBrief         the draft as a brief: narrator lines, a shot per beat
 *   (hedge.ts)              every numeric claim must be hedged ("≈", "about") or be the
 *                           sourced fact's own figure — policy_lint flags the rest
 *   engineeredLook          the picture style: the format's default unless the channel's bible
 *                           sets its own (`world.format_styles.engineered`) — the look lives
 *                           with the format and the channel, never in a prompt module
 */

// ═════════════════════════════════════════════════════════════════════════════
// Hero objects
// ═════════════════════════════════════════════════════════════════════════════

export const HeroObjectSchema = z.object({
  /** The `@Tag` the pictures name it by: the image model's tag shape (3–16, letter first). */
  tag: z.string().regex(STILL_TAG, 'a tag is 3–16 letters, digits or underscores, starting with a letter'),
  name: z.string().trim().min(2).max(60),
  /** What it looks like, in one sentence: shape, colour, material, decals. */
  look: z.string().trim().min(10).max(300),
});
export type HeroObject = z.infer<typeof HeroObjectSchema>;
export const HeroObjectsSchema = z.array(HeroObjectSchema).max(3);

/** A brief's hero objects, or [] — a malformed stored value is never half-used. */
export function heroObjectsOf(raw: unknown): HeroObject[] {
  const p = HeroObjectsSchema.safeParse(raw ?? []);
  return p.success ? p.data : [];
}

// ═════════════════════════════════════════════════════════════════════════════
// The look
// ═════════════════════════════════════════════════════════════════════════════

export interface EngineeredLook {
  /** A scene beat: the hero object in its world. */
  scene: string;
  /** A see-through cutaway: glass housing, the active part orange. */
  cutaway: string;
  /** A cross-section or technical view. */
  diagram: string;
  /** Appended to every engineered picture. Text is ours (graphics layer), never the model's. */
  negative: string;
}

/** The format's default look — the format spec's visual grammar. A channel may override any part. */
export const ENGINEERED_LOOK: EngineeredLook = {
  scene:
    'Clean photoreal 3D render, studio CG rather than a photograph: white test objects and vehicles with yellow-and-black circular target decals, spotless studio-clean surfaces, soft even daylight, gentle contact shadows, crisp detail.',
  cutaway:
    'Clean 3D cutaway render on a dark navy lab backdrop: the housing is translucent glass so the mechanism inside shows, the one active part glows orange, everything else neutral white and grey, soft rim light.',
  diagram:
    'Clean 3D technical render on a dark navy lab backdrop: a simple cross-section of the part in neutral white and grey with the one important area in orange.',
  negative: 'text, letters, numbers, labels, captions, logos, brand names, watermark, cartoon, line drawing, anime, human faces',
};

export function engineeredLook(world: Pick<Bible['world'], 'format_styles'>): EngineeredLook {
  const own = world.format_styles?.engineered ?? {};
  return {
    scene: own.scene ?? ENGINEERED_LOOK.scene,
    cutaway: own.cutaway ?? ENGINEERED_LOOK.cutaway,
    diagram: own.diagram ?? ENGINEERED_LOOK.diagram,
    negative: own.negative ?? ENGINEERED_LOOK.negative,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The draft the writer returns
// ═════════════════════════════════════════════════════════════════════════════

export const BEAT_KINDS = ['hook', 'question', 'rule', 'attempt', 'mechanism', 'loop'] as const;

export const EngineeredBeatSchema = z.object({
  kind: z.enum(BEAT_KINDS),
  /** One spoken line, 2–18 words — fast cutting needs short beats. */
  narration: z.string().trim().min(3).max(160),
  /** What the picture shows. Names hero objects by their @Tag. No text in the picture. */
  picture: z.string().trim().min(10).max(400),
  view: z.enum(['scene', 'cutaway', 'diagram']),
  /** Something physically happens here (an impact, a launch, a snap) — `key` motion animates these. */
  action: z.boolean(),
  objects: z.array(z.string()).max(3).default([]),
  graphics: ShotGraphicsSchema.default({}),
});
export type EngineeredBeat = z.infer<typeof EngineeredBeatSchema>;

export const EngineeredDraftSchema = z.object({
  premise: z.string().trim().min(10).max(300),
  hook_archetype: hookPattern,
  premise_type: z.string().min(1),
  structure_variant: z.string().min(1),
  ending_type: z.string().min(1),
  desk: z.string().min(1),
  music_bed: z.string().min(1),
  hero_objects: z.array(HeroObjectSchema).min(1).max(3),
  beats: z.array(EngineeredBeatSchema).min(9).max(24),
  /** Three candidate loop-ending lines — the approver picks one (it is the brief's punchline). */
  loop_endings: z.array(z.string().trim().min(3).max(160)).length(3),
  fact: FactSchema,
  titles: z.array(z.object({ text: z.string().min(3).max(100), hook_archetype: hookPattern })).length(3),
  pinned_comment: z.string().min(5).max(300),
});
export type EngineeredDraft = z.infer<typeof EngineeredDraftSchema>;

/**
 * The decode schema handed to the model: structure only — no lengths, ranges, regexes,
 * defaults or refinements, which structured output cannot all express. Every constraint is
 * applied after, by `EngineeredDraftSchema`, where a violation is a legible error rather than
 * an unterminated decode (the same split as the Bureau brief writer's DraftSchema).
 */
const DecodeGraphics = z.object({
  badge: z.object({ n: z.number(), label: z.string() }).nullable(),
  verdict: z.object({ pass: z.boolean(), text: z.string(), sub: z.string().nullable() }).nullable(),
  callouts: z.array(z.object({ label: z.string(), x: z.number().nullable(), y: z.number().nullable() })),
  meters: z.array(z.object({ label: z.string(), from: z.number().nullable(), to: z.number().nullable(), value: z.number().nullable(), unit: z.string() })),
  keyword: z.object({ word: z.string(), role: z.enum(['mechanism', 'danger', 'outcome']) }).nullable(),
});
export const EngineeredDecodeSchema = z.object({
  premise: z.string(),
  hook_archetype: hookPattern,
  premise_type: z.string(),
  structure_variant: z.string(),
  ending_type: z.string(),
  desk: z.string(),
  music_bed: z.string(),
  hero_objects: z.array(z.object({ tag: z.string(), name: z.string(), look: z.string() })),
  beats: z.array(z.object({ kind: z.enum(BEAT_KINDS), narration: z.string(), picture: z.string(), view: z.enum(['scene', 'cutaway', 'diagram']), action: z.boolean(), objects: z.array(z.string()), graphics: DecodeGraphics })),
  loop_endings: z.array(z.string()),
  fact: z.object({ claim: z.string(), source_url: z.string(), source_title: z.string() }),
  titles: z.array(z.object({ text: z.string(), hook_archetype: hookPattern })),
  pinned_comment: z.string(),
});

/**
 * A meter's from/to/value are bar fills, 0..1. The model sometimes writes the physical figure
 * instead (the first real draft, 08-Oct: `to` > 1) — the label and unit text carry the figure
 * anyway, so the fills are scaled by the largest of them, keeping their proportion. Fills that
 * are all within 0..1 are untouched; a negative one is left for the schema to refuse.
 */
export function barFill<M extends { from: number | null; to: number | null; value: number | null }>(m: M): M {
  const nums = [m.from, m.to, m.value].filter((x): x is number => typeof x === 'number');
  const top = Math.max(0, ...nums);
  if (top <= 1 || nums.some((x) => x < 0)) return m;
  const scale = (x: number | null) => (x === null ? null : Math.round((x / top) * 1000) / 1000);
  return { ...m, from: scale(m.from), to: scale(m.to), value: scale(m.value) };
}

/** A decoded draft with its nulls dropped (the decode says null; the draft schema says absent). */
export function draftFromDecoded(d: z.infer<typeof EngineeredDecodeSchema>): unknown {
  const drop = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
  return {
    ...d,
    beats: d.beats.map((b) => ({
      ...b,
      graphics: drop({
        badge: b.graphics.badge,
        verdict: b.graphics.verdict ? drop(b.graphics.verdict) : null,
        callouts: b.graphics.callouts.length ? b.graphics.callouts.map((c) => drop(c)) : null,
        meters: b.graphics.meters.length ? b.graphics.meters.map((m) => drop(barFill(m))) : null,
        keyword: b.graphics.keyword,
      }),
    })),
  };
}

/** The brief's word limit (briefs CHECK, policy.json script_max_words), labels included. */
export const ENGINEERED_MAX_WORDS = 150;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The evolution shape, checked in code rather than trusted to the prompt: every problem, in
 * words. Empty → the draft has the shape.
 */
export function evolutionProblems(d: Pick<EngineeredDraft, 'beats' | 'hero_objects'>): string[] {
  const p: string[] = [];
  const b = d.beats;
  if (b[0]?.kind !== 'hook') p.push('the first beat must be the hook (the danger, in the second person)');
  if (b[b.length - 1]?.kind !== 'loop') p.push('the last beat must be the loop ending that returns to the opening picture');
  const firstAttempt = b.findIndex((x) => x.kind === 'attempt');
  const q = b.findIndex((x) => x.kind === 'question');
  const rule = b.findIndex((x) => x.kind === 'rule');
  if (q < 0 || q > 3) p.push('a question beat must come within the first four beats');
  if (rule < 0 || (firstAttempt >= 0 && rule > firstAttempt)) p.push('the rule that makes it hard must come before the first attempt');
  if (firstAttempt < 0) p.push('there are no attempts');

  // Attempts: badges numbered 1..N in order, each attempt with at least one verdict; every
  // attempt but the last fails somewhere, the last passes.
  const groups: { n: number; verdicts: boolean[] }[] = [];
  for (const x of b) {
    if (x.kind !== 'attempt') continue;
    if (x.graphics.badge) groups.push({ n: x.graphics.badge.n, verdicts: [] });
    if (x.graphics.verdict) {
      if (!groups.length) p.push('a verdict comes before any numbered attempt');
      else groups[groups.length - 1].verdicts.push(x.graphics.verdict.pass);
    }
  }
  if (groups.length < 2) p.push(`at least two numbered attempts are needed (got ${groups.length})`);
  if (groups.length > 6) p.push(`at most six attempts (got ${groups.length})`);
  groups.forEach((g, i) => {
    if (g.n !== i + 1) p.push(`attempt badges must count 1, 2, 3… — badge ${i + 1} says ${g.n}`);
    if (!g.verdicts.length) p.push(`attempt ${g.n} has no verdict`);
    const last = i === groups.length - 1;
    if (!last && g.verdicts.length && !g.verdicts.includes(false)) p.push(`attempt ${g.n} must fail (✗) — only the last attempt works`);
    if (last && g.verdicts.length && g.verdicts[g.verdicts.length - 1] !== true) p.push(`the last attempt (${g.n}) must end on a pass (✓)`);
  });
  const mech = b.filter((x) => x.kind === 'mechanism');
  if (mech.length < 2) p.push('the final mechanism needs at least two step-by-step beats');
  if (!b.some((x) => (x.graphics.meters ?? []).length)) p.push('at least one meter is needed (the numeric fact, shown)');
  for (const x of b) if (x.kind !== 'attempt' && (x.graphics.badge || x.graphics.verdict)) p.push(`a ${x.kind} beat carries a badge or verdict — only attempts do`);

  // The brief's own limit counts every word of "Narrator: line" (briefs CHECK, 150): the
  // speaker's label is a word on every line, so the narration has that much less room.
  const total = b.reduce((n, x) => n + words(x.narration) + 1, 0);
  if (total > ENGINEERED_MAX_WORDS) p.push(`the script is ${total} words with the narrator's label on each line; the limit is ${ENGINEERED_MAX_WORDS}`);
  const tags = new Set(d.hero_objects.map((o) => o.tag));
  if (tags.size !== d.hero_objects.length) p.push('two hero objects share a tag');
  for (const [i, x] of b.entries()) {
    for (const t of x.objects) if (!tags.has(t.replace(/^@/, ''))) p.push(`beat ${i + 1} shows "${t}", which is not a hero object`);
    const n = words(x.narration);
    if (n > 18) p.push(`beat ${i + 1} narration is ${n} words; keep beats to 18 or fewer for fast cutting`);
  }
  return p;
}

/** Seconds a narrated beat is planned at before the voice times it: ~2.7 words a second at brisk. */
export function beatSeconds(narration: string): number {
  return Math.round(Math.min(6, Math.max(1.2, words(narration) / 2.7 + 0.35)) * 10) / 10;
}

/**
 * The draft as a brief candidate (still to pass `briefInputSchema` and the server's checks).
 * The narrator speaks every line; one shot per beat, in order, so the planner can bind shot i
 * to line i exactly (episode-steps.ts) and every graphic lands on its own words.
 */
export function engineeredBrief(d: EngineeredDraft, ctx: { narrator: { slug: string; name: string }; series: Pick<Series, 'id'> }) {
  // The script's last line IS the first loop ending; the approver may pick another (punchline).
  const beats = d.beats.map((x, i) => (i === d.beats.length - 1 ? { ...x, narration: d.loop_endings[0] } : x));
  const line = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    series: ctx.series.id,
    lead_character: ctx.narrator.slug,
    supporting_characters: [] as string[],
    desk: d.desk,
    premise: d.premise,
    premise_type: d.premise_type,
    structure_variant: d.structure_variant,
    ending_type: d.ending_type,
    music_bed: d.music_bed,
    hook_archetype: d.hook_archetype,
    catchphrase_used: null,
    punchlines: d.loop_endings,
    beat_sheet: beats.map((x, i) => ({ beat_id: `${x.kind}_${i + 1}`, summary: line(x.narration) })),
    script_text: beats.map((x) => `${ctx.narrator.name}: ${line(x.narration)}`).join('\n'),
    shot_list: beats.map((x, i) => ({
      beat_id: `${x.kind}_${i + 1}`,
      route: 'still' as const,
      description: x.picture,
      duration_s: beatSeconds(x.narration),
      characters: [] as string[],
      realistic: false,
      view: x.view,
      action: x.action,
      objects: x.objects.map((t) => t.replace(/^@/, '')),
      graphics: x.graphics,
    })),
    fact: d.fact,
    titles: d.titles,
    pinned_comment: d.pinned_comment,
    hero_objects: d.hero_objects,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Availability
// ═════════════════════════════════════════════════════════════════════════════

export type EngineeredAvailability = { available: true } | { available: false; reason: string };

/**
 * Can an engineered episode be planned on this database? Only once 0052 is applied — before
 * it the `picture_clip` route and the graphics column do not exist and the shots insert would
 * be refused. A probe, never a constant (CLAUDE.md): the day the bundle is pasted it says yes.
 */
export async function engineeredAvailability(db: Db): Promise<EngineeredAvailability> {
  const { error } = await db.from('shots').select('graphics').limit(1);
  if (error) return { available: false, reason: 'the 3D explainer needs migration 0052 — paste bundle 10' };
  return { available: true };
}

/** The narrator of a channel: the series' first lead, else the bible's first character. */
export function narratorOf(cb: Pick<ChannelBible, 'bible'>, series: Pick<Series, 'lead'>): { slug: string; name: string } {
  const c = cb.bible.characters.find((x) => x.id === series.lead[0]) ?? cb.bible.characters[0];
  return { slug: c.id, name: c.name };
}
