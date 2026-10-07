import { z } from 'zod';

import { CHANNEL_FOLDERS } from '../channels/registry.generated';
import type { Db } from '../db/server';
import { bureauSeries, hookPattern } from '../db/enums';
import { ROUTE_PROVIDERS } from '../drivers/jobs';
import { CharacterVoiceFields, storedVoiceOf, voiceFieldsFromStored, voiceKey, voiceRouteFor, type VoiceOverride, type VoiceRoute } from '../drivers/voice-route';
import type { Json } from '../db/types';
import { VisualFormatSchema, VoicePaceSchema } from './formats';

/**
 * Channel bibles, typed — from the database first, the folder second (decision 0022).
 *
 * `getBible(db, channelId)` is the one way a caller holding a channel id reaches its cast,
 * series, policy and trend sources. It reads `channel_bibles` + `channel_characters`, and only
 * when the channel has no row there falls back to the folder `channels/<slug>/` from the build,
 * with a log line saying so. Both sources go through the same Zod schemas below, so a DB edit
 * is held to exactly the rules a folder edit is.
 *
 * The folders: each channel's JSON under `channels/<slug>/` was the source of truth until
 * 0022, and is now the import source and the fallback. The folders reach the
 * bundles through `src/lib/channels/registry.generated.ts` (static imports, see
 * `scripts/channels-registry.mjs`), and every folder is parsed with Zod at import, so a
 * malformed edit to ANY channel fails the build instead of failing a 6am Routine.
 *
 * Nothing here knows which channel is "the" channel. A caller holds a channel id — from the
 * episode, brief or slot row it is acting on, from an MCP token, or from the active-channel
 * cookie — and asks for that channel's bible with `getBible`. (Until 07-Oct-2026 this
 * module exported the Bureau's bible as module constants and 55 call sites read the Bureau's
 * id from here; that is what multichannel removed. The seed id survives only in
 * `src/lib/fixtures/seed-channel.ts`, for migrations' fixtures and harnesses.)
 */

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
  /** Locked frames (storage:<key> or https), placeholders, or none yet — a cast member made in
   *  the app has none until frame:lock. syncCast copies only usable ones. */
  reference_frame_ids: z.array(z.string().min(1)),
  // Vendor-shaped, so the schema lives in the driver layer (rule 1). See voice-route.ts.
  ...CharacterVoiceFields,
  voice_brief: z.string().min(1),
  never_do: z.array(z.string().min(1)).min(1),
});
export type Character = z.infer<typeof CharacterSchema>;

export const BibleSchema = z.object({
  version: z.number().int(),
  channel: z.string().regex(/^_?[a-z0-9-]+$/),
  world: z.object({
    name: z.string(),
    premise: z.string(),
    palette: z.object({ paper: Hex, grid: Hex, chalk: Hex }),
    style_rules: z.array(z.string()).min(1),
    negative_prompt: z.string().min(1),
    /** The look of a scene still (0021), in one sentence with no people in it. Optional:
     *  without it the still style is built from the palette. */
    still_style: z.string().min(1).optional(),
  }),
  /** What every upload of this channel carries: hashtag pool (no '#'), base tags, category. */
  publishing: z
    .object({
      hashtags: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).min(1).max(30),
      tags: z.array(z.string().min(1)).max(15),
      category: z.string().min(1),
    })
    .optional(),
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
  /** The series' default visual format (formats.ts); absent → illustrated. The approver can override per episode. */
  visual_format: VisualFormatSchema.optional(),
  /** The series' default voice pace (formats.ts); absent → brisk. */
  voice_pace: VoicePaceSchema.optional(),
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

export const TrendsConfigSchema = z.object({
  subreddits: z.array(z.string().regex(/^[A-Za-z0-9_]{2,40}$/)).max(20),
  youtube: z
    .object({
      region_code: z.string().regex(/^[A-Z]{2}$/),
      category_ids: z.array(z.string().regex(/^\d+$/)).max(10),
      queries: z.array(z.string().min(2).max(100)).max(10),
    })
    .nullable()
    .optional(),
  /**
   * Google Trends "Trending now" countries (ISO 3166 alpha-2). Absent → DEFAULT_GOOGLE_TRENDS_GEOS
   * (IN and US); null → this channel does not read Google Trends.
   */
  google_trends: z
    .object({ geo: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(5) })
    .nullable()
    .optional(),
});
export type TrendsConfig = z.infer<typeof TrendsConfigSchema>;

export type SeriesId = z.infer<typeof bureauSeries>;

/** One channel's bible: cast, policy, series and trend sources, with the lookups callers need. */
export interface ChannelBible {
  readonly slug: string;
  /** Where this bible was read from: the database (0022) or the folder in the build. */
  readonly source: 'db' | 'file';
  readonly bible: Bible;
  readonly policy: Policy;
  /** The series this channel runs. Not every channel runs every series. */
  readonly series: Readonly<Partial<Record<SeriesId, Series>>>;
  readonly trends: TrendsConfig;
  readonly characterSlugs: readonly string[];
  characterBySlug(slug: string): Character | undefined;
  /** Calendar leads like "pip+marlo", "marlo|iyer" or "rotating_desk_head" → known slugs. */
  leadsFromCalendar(lead: string | null): string[];
  /** The series, or a refusal naming the channel and the series it does not run. */
  seriesFor(id: string): Series;
}

type RawBible = { characters: unknown; policy: unknown; trends: unknown; series: readonly unknown[] };

function build(slug: string, raw: RawBible, source: 'db' | 'file' = 'file'): ChannelBible {
  const where = (f: string) => (source === 'db' ? `the database bible of ${slug} (${f})` : `channels/${slug}/${f}`);
  const parse = <T>(schema: z.ZodType<T>, v: unknown, f: string): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw new Error(`${where(f)} is malformed: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return r.data;
  };
  const bible = parse(BibleSchema, raw.characters, 'characters.json');
  if (bible.channel !== slug) throw new Error(`${where('characters.json')} names channel "${bible.channel}", not "${slug}".`);
  const policy = parse(PolicySchema, raw.policy, 'policy.json');
  const trends = raw.trends === null ? { subreddits: [], youtube: null } : parse(TrendsConfigSchema, raw.trends, 'trends.json');
  const series: Partial<Record<SeriesId, Series>> = {};
  for (const r of raw.series) {
    const s = parse(SeriesSchema, r, 'series/*.json');
    series[s.id] = s;
  }
  const characterSlugs = bible.characters.map((c) => c.id);
  return {
    slug,
    source,
    bible,
    policy,
    series,
    trends,
    characterSlugs,
    characterBySlug: (s) => bible.characters.find((c) => c.id === s),
    leadsFromCalendar: (lead) =>
      lead
        ? lead
            .split(/[+|]/)
            .map((s) => s.trim())
            .filter((s) => characterSlugs.includes(s))
        : [],
    seriesFor(id) {
      const s = series[id as SeriesId];
      if (!s) throw new Error(`Channel "${slug}" runs no series "${id}" — its bible has ${Object.keys(series).join(', ') || 'none'}.`);
      return s;
    },
  };
}

/** Every folder, parsed at import. `_template` is parsed too, so the template cannot rot. */
const BIBLES: ReadonlyMap<string, ChannelBible> = new Map(Object.entries(CHANNEL_FOLDERS).map(([slug, raw]) => [slug, build(slug, raw)]));

/** Slugs a channel can use: every folder except the template. */
export const BIBLE_SLUGS: readonly string[] = [...BIBLES.keys()].filter((s) => !s.startsWith('_'));

export function hasBible(slug: string): boolean {
  return BIBLE_SLUGS.includes(slug);
}

/** The template's bible, for tests of the template itself. Never a channel's. */
export function templateBible(): ChannelBible {
  return BIBLES.get('_template')!;
}

export function bibleForSlug(slug: string): ChannelBible {
  if (slug.startsWith('_') || !BIBLES.has(slug)) {
    throw new Error(
      `No bible folder channels/${slug}/ in this build, and this caller asked for the folder. A channel added from the app ` +
        `has its bible in the database — read it with getBible(db, channelId). Folders in this build: ${BIBLE_SLUGS.join(', ') || 'none'}.`,
    );
  }
  return BIBLES.get(slug)!;
}

// ═════════════════════════════════════════════════════════════════════════════
// The database bible (0022)
// ═════════════════════════════════════════════════════════════════════════════

/** A `channel_bibles` row as read. */
export interface BibleRow {
  world: unknown;
  publishing: unknown;
  series: unknown;
  policy: unknown;
  trend_sources: unknown;
  version: number;
}
/** A `channel_characters` row as read. */
export interface CharacterRow {
  slug: string;
  name: string;
  role: string;
  desk: string;
  on_screen: boolean;
  season_introduced: number;
  personality: string;
  accent_hex: string;
  voice: unknown;
  voice_brief: string;
  visual_lock: unknown;
  catchphrase: unknown;
  speech_rules: unknown;
  never_do: unknown;
  reference_frame: unknown;
  sort: number;
  active: boolean;
}

/** The character the bible schema expects, from its row. Pure. */
export function characterFromRow(r: CharacterRow): unknown {
  return {
    id: r.slug,
    name: r.name,
    role: r.role,
    desk: r.desk,
    on_screen: r.on_screen,
    season_introduced: r.season_introduced,
    personality: r.personality,
    speech_rules: r.speech_rules,
    catchphrase: r.catchphrase,
    accent_hex: r.accent_hex,
    visual_lock: r.visual_lock,
    reference_frame_ids: r.reference_frame,
    ...voiceFieldsFromStored(r.voice),
    voice_brief: r.voice_brief,
    never_do: r.never_do,
  };
}

/** A ChannelBible from its rows, through the same schemas a folder passes. Throws by field. */
export function bibleFromRows(slug: string, row: BibleRow, chars: readonly CharacterRow[]): ChannelBible {
  const active = [...chars].filter((c) => c.active).sort((a, b) => a.sort - b.sort || a.slug.localeCompare(b.slug));
  const series = row.series && typeof row.series === 'object' ? Object.values(row.series as Record<string, unknown>) : [];
  return build(
    slug,
    {
      characters: { version: row.version, channel: slug, world: row.world, ...(row.publishing ? { publishing: row.publishing } : {}), characters: active.map(characterFromRow) },
      policy: row.policy,
      trends: row.trend_sources ?? null,
      series,
    },
    'db',
  );
}

/** The rows a bible becomes — the ONE row builder, used by the import, the SQL bundle and the actions. Pure. */
export function bibleRows(cb: Pick<ChannelBible, 'bible' | 'policy' | 'series' | 'trends'>, channelId: string, updatedBy: string) {
  const { characters, publishing, version, world } = cb.bible;
  return {
    bible: {
      channel_id: channelId,
      world: world as unknown as Json,
      publishing: (publishing ?? null) as unknown as Json,
      series: Object.fromEntries(Object.entries(cb.series)) as unknown as Json,
      policy: cb.policy as unknown as Json,
      trend_sources: cb.trends as unknown as Json,
      version,
      updated_by: updatedBy,
    },
    characters: characters.map((c, i) => characterRow(c, channelId, i)),
  };
}

export function characterRow(c: Character, channelId: string, sort: number) {
  return {
    channel_id: channelId,
    slug: c.id,
    name: c.name,
    role: c.role,
    desk: c.desk,
    on_screen: c.on_screen,
    season_introduced: c.season_introduced,
    personality: c.personality,
    accent_hex: c.accent_hex,
    voice: storedVoiceOf(c) as unknown as Json,
    voice_brief: c.voice_brief,
    visual_lock: c.visual_lock as unknown as Json,
    catchphrase: c.catchphrase as unknown as Json,
    speech_rules: c.speech_rules as unknown as Json,
    never_do: c.never_do as unknown as Json,
    reference_frame: c.reference_frame_ids as unknown as Json,
    sort,
    active: true,
  };
}

const fellBack = new Set<string>();

/**
 * The bible for a channels row — THE way a caller holding a channel id reaches its cast.
 *
 * Database first (`channel_bibles` + active `channel_characters`); the folder in the build
 * only when the channel has no database bible, with one log line per process saying so. A
 * database bible that fails its schema throws by field — it never falls back silently to a
 * folder that may say something else.
 */
export async function getBible(db: Db, channelId: string): Promise<ChannelBible> {
  const { data, error } = await db.from('channels').select('name, slug').eq('id', channelId).maybeSingle();
  if (error) throw new Error(`Reading channel ${channelId}: ${error.message}`);
  if (!data) throw new Error(`No channel ${channelId}.`);
  const slug = data.slug;
  const { data: row, error: bErr } = await db.from('channel_bibles').select('world, publishing, series, policy, trend_sources, version').eq('channel_id', channelId).maybeSingle();
  if (!bErr && row) {
    if (!slug) throw new Error(`Channel "${data.name}" has a database bible but no slug.`);
    const { data: chars, error: cErr } = await db
      .from('channel_characters')
      .select('slug, name, role, desk, on_screen, season_introduced, personality, accent_hex, voice, voice_brief, visual_lock, catchphrase, speech_rules, never_do, reference_frame, sort, active')
      .eq('channel_id', channelId);
    if (cErr) throw new Error(`Reading the cast of ${slug}: ${cErr.message}`);
    return bibleFromRows(slug, row, chars ?? []);
  }
  if (!slug) throw new Error(`Channel "${data.name}" has no slug and no database bible.`);
  if (!fellBack.has(slug)) {
    fellBack.add(slug);
    console.info(`[bible] ${slug}: ${bErr ? `channel_bibles unreadable (${bErr.message}; is 0048 pasted?)` : 'no bible in the database'} — using channels/${slug}/ from the build`);
  }
  return bibleForSlug(slug);
}

/** Channel ids with a database bible. A missing table reads as none (0048 not pasted). */
export async function channelsWithDbBible(db: Db): Promise<Set<string>> {
  const { data, error } = await db.from('channel_bibles').select('channel_id');
  return new Set(error ? [] : (data ?? []).map((r) => r.channel_id));
}

/**
 * Voice overrides set on the Voices screen (channel_voice_overrides), keyed by character slug.
 * A missing table (0046 not pasted yet) reads as no overrides — the bible stands, which is
 * what it meant before the table existed.
 */
export async function voiceOverrides(db: Db, channelId: string): Promise<Map<string, VoiceOverride>> {
  const { data, error } = await db.from('channel_voice_overrides').select('character_slug, voice_provider, voice_id').eq('channel_id', channelId);
  const out = new Map<string, VoiceOverride>();
  if (error) return out;
  for (const r of data ?? []) out.set(r.character_slug, { provider: r.voice_provider, voiceId: r.voice_id });
  return out;
}

/** The voice route for one character of a channel: an override wins, else the bible. */
export function routeForCharacter(cb: ChannelBible, slug: string, overrides: ReadonlyMap<string, VoiceOverride>): VoiceRoute {
  const c = cb.characterBySlug(slug);
  if (!c) return { ok: false, code: 'voice_not_locked', detail: `${slug}: not in the ${cb.slug} cast` };
  return voiceRouteFor(c, overrides.get(slug));
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
export async function syncCast(
  db: {
    from: (t: 'characters') => {
      upsert: (
        rows: Record<string, unknown>[],
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  },
  channelId: string,
  cb: ChannelBible,
  overrides: ReadonlyMap<string, VoiceOverride> = new Map(),
): Promise<{ synced: number; withReference: number; withVoice: number }> {
  const now = new Date().toISOString();
  const rows = cb.bible.characters.map((c) => {
    const real = c.reference_frame_ids.filter(isUsableReference);
    // `voice_id` holds the routed voice ("<provider>:<id>") or null while unlocked — never a
    // stand-in, because the voice stage reads null as "refuse this line".
    const route = voiceRouteFor(c, overrides.get(c.id));
    return {
      channel_id: channelId,
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
