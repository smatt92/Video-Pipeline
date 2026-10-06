import { z } from 'zod';

import charactersJson from '../../../channels/bureau-of-reality/characters.json';
import policyJson from '../../../channels/bureau-of-reality/policy.json';
import archive from '../../../channels/bureau-of-reality/series/archive.json';
import complaint from '../../../channels/bureau-of-reality/series/complaint.json';
import deep from '../../../channels/bureau-of-reality/series/deep.json';
import deskTour from '../../../channels/bureau-of-reality/series/desk_tour.json';
import incident from '../../../channels/bureau-of-reality/series/incident.json';
import longForm from '../../../channels/bureau-of-reality/series/long_form.json';
import myth from '../../../channels/bureau-of-reality/series/myth.json';
import pip from '../../../channels/bureau-of-reality/series/pip.json';
import { bureauSeries, hookPattern } from '../db/enums';
import { ROUTE_PROVIDERS } from '../drivers/jobs';
import { CharacterVoiceFields, voiceKey, voiceRouteFor } from '../drivers/voice-route';

/**
 * The channel bible, parsed once and typed.
 *
 * The JSON under `channels/bureau-of-reality/` is the source of truth — Sahil edits it, the
 * MCP resources serve it, the brief checks enforce it. Parsing it with Zod at import means a
 * malformed edit fails the build (and `verify:bureau`) instead of failing a 6am Routine.
 */

export const BUREAU_CHANNEL_ID = 'b0000000-0000-4000-8000-000000000001';
export const BUREAU_CHANNEL_SLUG = 'bureau-of-reality';

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const CharacterSchema = z.object({
  id: z.string().regex(/^[a-z_]+$/),
  name: z.string().min(1),
  role: z.string().min(1),
  desk: z.string().min(1),
  on_screen: z.boolean(),
  season_introduced: z.number().int().positive(),
  personality: z.string().min(1),
  speech_rules: z.array(z.string().min(1)).min(1),
  catchphrase: z.object({ text: z.string().min(1), max_per_week: z.number().int().min(0) }),
  accent_hex: Hex,
  visual_lock: z.object({
    line: z.string(),
    props: z.array(z.string()),
    head_body_ratio: z.string(),
    line_weight: z.string(),
    silhouette: z.string(),
  }),
  reference_frame_ids: z.array(z.string().min(1)).min(1),
  // Vendor-shaped, so the schema lives in the driver layer (rule 1). See voice-route.ts.
  ...CharacterVoiceFields,
  voice_brief: z.string().min(1),
  never_do: z.array(z.string().min(1)).min(1),
});
export type Character = z.infer<typeof CharacterSchema>;

export const BibleSchema = z.object({
  version: z.number().int(),
  channel: z.literal(BUREAU_CHANNEL_SLUG),
  world: z.object({
    name: z.string(),
    premise: z.string(),
    palette: z.object({ paper: Hex, grid: Hex, chalk: Hex }),
    style_rules: z.array(z.string()).min(1),
    negative_prompt: z.string().min(1),
  }),
  characters: z.array(CharacterSchema).min(1),
});
export type Bible = z.infer<typeof BibleSchema>;

const OverlaySpec = z.object({
  kind: z.string().min(1),
  elements: z.array(z.string()),
  camera: z.string(),
  notes: z.string().optional(),
  palette: z.string().optional(),
  max_labels: z.number().int().optional(),
});
export type OverlaySpecTemplate = z.infer<typeof OverlaySpec>;

const Beat = z.object({
  id: z.string().min(1),
  start_s: z.number().min(0),
  end_s: z.number().positive(),
  purpose: z.string().min(1),
  render_route_hint: z.string().optional(),
  overlay: OverlaySpec.optional(),
  loop_anchor: z.boolean().optional(),
  loop_line: z.boolean().optional(),
});

export const SeriesSchema = z.object({
  id: bureauSeries,
  name: z.string().min(1),
  day: z.string().min(1),
  lead: z.array(z.string().min(1)).min(1),
  template: z.string().min(1),
  runtime_s: z.object({ min: z.number(), target: z.number(), max: z.number() }),
  beat_sheet: z.array(Beat).min(1),
  structure_variants: z.array(z.object({ id: z.string().min(1), shape: z.string().min(1) })).min(3),
  ending_types: z.array(z.string().min(1)).min(1),
  premise_types: z.array(z.string().min(1)).min(1),
  desks: z.array(z.string().min(1)).min(1),
  music_bed_pool: z.array(z.string().min(1)).min(1),
  music_policy: z.string().min(1),
  serialised: z.boolean(),
  comment_sourced: z.boolean(),
  money_shot_allowed: z.boolean(),
  rules: z.array(z.string().min(1)).min(1),
});
export type Series = z.infer<typeof SeriesSchema>;

const RejectCategory = z.object({
  id: z.string().min(1),
  why: z.string().min(1),
  patterns: z.array(z.string().min(1)).min(1),
  judge: z.string().optional(),
  styling_fields: z.array(z.string()).optional(),
});

export const PolicySchema = z.object({
  version: z.number().int(),
  summary: z.string(),
  required: z.object({
    sourced_facts_exactly: z.literal(1),
    fact_source_classes: z.array(z.string().min(1)).min(1),
    script_max_words: z.number().int().positive(),
    punchlines: z.literal(3),
    titles: z.literal(3),
    titles_distinct_hook_archetypes: z.boolean(),
  }),
  hook_archetypes: z.array(hookPattern).min(1),
  reject_categories: z.array(RejectCategory).min(1),
  myth_interpretation_markers: z.array(z.string().min(1)).min(1),
  realistic_scene_disclosure: z.string(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const BIBLE: Bible = BibleSchema.parse(charactersJson);
export const POLICY: Policy = PolicySchema.parse(policyJson);
export const SERIES: Readonly<Record<z.infer<typeof bureauSeries>, Series>> = Object.fromEntries(
  [incident, deskTour, pip, archive, myth, deep, complaint, longForm].map((raw) => {
    const s = SeriesSchema.parse(raw);
    return [s.id, s];
  }),
) as Record<z.infer<typeof bureauSeries>, Series>;

for (const id of bureauSeries.options) {
  if (!SERIES[id]) throw new Error(`Series "${id}" has no file under channels/bureau-of-reality/series/.`);
}

export const CHARACTER_SLUGS = BIBLE.characters.map((c) => c.id);

export function characterBySlug(slug: string): Character | undefined {
  return BIBLE.characters.find((c) => c.id === slug);
}

/** Calendar leads like "pip+marlo", "marlo|iyer" or "rotating_desk_head" → known slugs. */
export function leadsFromCalendar(lead: string | null): string[] {
  if (!lead) return [];
  return lead
    .split(/[+|]/)
    .map((s) => s.trim())
    .filter((s) => CHARACTER_SLUGS.includes(s));
}

/**
 * How a locked reference frame held in our own bucket is written in `reference_frame_ids`:
 * `storage:<key>`. Written only by `pnpm frame:lock`; resolved to a short-lived URL by the
 * dispatcher at submit time and by QC, never stored resolved.
 */
export const STORAGE_REF_PREFIX = 'storage:';

/** A reference frame the generator can actually be given: one of ours, or an https URL. */
export function isUsableReference(ref: string): boolean {
  return ref.startsWith(STORAGE_REF_PREFIX) ? ref.length > STORAGE_REF_PREFIX.length : /^https:\/\//.test(ref);
}

/**
 * Mirror the bible's cast into `characters` — idempotent, keyed on (channel, slug).
 *
 * Reference frames: the JSON carries placeholders until `pnpm frame:lock` (or Prompt B)
 * locks the cast. Only a usable reference — `storage:<key>` or an https URL — is copied into
 * `external_ref_id`, because a row that claims a reference which does not exist is the
 * "guard that permits what its message forbids" shape: the character-beat route checks that
 * column before it will submit, and the generator needs a frame it can fetch.
 */
export async function syncCast(db: {
  from: (t: 'characters') => {
    upsert: (
      rows: Record<string, unknown>[],
      opts: { onConflict: string },
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
}): Promise<{ synced: number; withReference: number; withVoice: number }> {
  const now = new Date().toISOString();
  const rows = BIBLE.characters.map((c) => {
    const real = c.reference_frame_ids.filter(isUsableReference);
    // `voice_id` holds the routed voice ("<provider>:<id>") or null while unlocked — never a
    // stand-in, because the voice stage reads null as "refuse this line".
    const route = voiceRouteFor(c);
    return {
      channel_id: BUREAU_CHANNEL_ID,
      slug: c.id,
      name: c.name,
      role: c.role,
      accent_hex: c.accent_hex,
      voice_id: route.ok ? voiceKey(route) : null,
      on_screen: c.on_screen,
      season_introduced: c.season_introduced,
      bible: c,
      reference_urls: real.filter((r) => /^https:\/\//.test(r)),
      external_ref_id: real[0] ?? null,
      driver: real[0] ? ROUTE_PROVIDERS.character_beat.primary : null,
      notes: c.personality,
      synced_at: now,
    };
  });
  const { error } = await db.from('characters').upsert(rows, { onConflict: 'channel_id,slug' });
  if (error) throw new Error(`Syncing the cast failed: ${error.message}`);
  return {
    synced: rows.length,
    withReference: rows.filter((r) => r.external_ref_id).length,
    withVoice: rows.filter((r) => r.voice_id).length,
  };
}
