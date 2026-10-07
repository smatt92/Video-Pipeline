import 'server-only';

import { z } from 'zod';

import { routeForCharacter, type ChannelBible } from '../bureau/bible';
import type { Db } from '../db/server';
import { overrideProblem, voiceKey, type VoiceOverride, type VoiceRoute } from '../drivers/voice-route';
import { isMissingTable, NEEDS_0046 } from './missing';

/**
 * The Voices screen's data, and its two writes.
 *
 * What the screen shows as "the voice" is computed by `routeForCharacter` — the same
 * predicate the voice stage calls (episode-steps passes `voiceOverrides` into it). A screen
 * that worked out "which wins" for itself would be a second module for one concept, and the
 * day the two disagreed the screen would show a voice the stage does not use.
 *
 * Pure enough for a harness: a Db and a ChannelBible in, rows out. Presigning the take is
 * the page's job, because a URL is not data.
 */

export interface StoredOverride {
  readonly provider: string;
  readonly voiceId: string;
  readonly note: string | null;
  readonly setAt: string;
}

export interface LatestTake {
  readonly storageKey: string;
  /** "<provider>:<id>" as the voice stage wrote it. */
  readonly voiceKey: string;
  readonly text: string;
  readonly createdAt: string;
  /** Whether this take was spoken by the voice the stage would use now. */
  readonly matchesRoute: boolean;
}

export interface VoiceRow {
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly accentHex: string;
  readonly voiceBrief: string;
  /** The bible's lock: provider and preset (null preset = not locked yet). */
  readonly bible: { readonly provider: string; readonly presetId: string | null };
  readonly override: StoredOverride | null;
  /** Why the stored override is unusable, or null. An unusable override is a refusal, not a fallback. */
  readonly overrideProblem: string | null;
  /** Exactly what the voice stage will use, or its refusal. */
  readonly route: VoiceRoute;
  readonly source: 'override' | 'bible';
  readonly take: LatestTake | null;
}

export interface VoicesScreen {
  /** Set when channel_voice_overrides does not exist: the bible stands, and the screen says why. */
  readonly tableMissing: string | null;
  readonly rows: readonly VoiceRow[];
}

/** Recent concepts searched for a stored take. Bounded so the `in` list stays a sane URL. */
const TAKE_CONCEPT_WINDOW = 200;

export async function readOverrides(
  db: Db,
  channelId: string,
): Promise<{ tableMissing: string | null; rows: Map<string, StoredOverride> }> {
  const { data, error } = await db
    .from('channel_voice_overrides')
    .select('character_slug, voice_provider, voice_id, note, set_at')
    .eq('channel_id', channelId);
  if (error) {
    if (isMissingTable(error)) return { tableMissing: NEEDS_0046, rows: new Map() };
    throw new Error(`Reading voice overrides: ${error.message}`);
  }
  return {
    tableMissing: null,
    rows: new Map(
      (data ?? []).map((r) => [
        r.character_slug,
        { provider: r.voice_provider, voiceId: r.voice_id, note: r.note, setAt: r.set_at },
      ]),
    ),
  };
}

/**
 * The most recent stored take per character on this channel.
 *
 * vo_takes carries no speaker; the asset it points at does (`assets.meta.speaker`, written by
 * the voice stage). Channel comes from the script's concept. Flat queries only — each one is
 * a filter the harness shim and PostgREST both implement.
 */
export async function latestTakes(db: Db, channelId: string): Promise<Map<string, Omit<LatestTake, 'matchesRoute'>>> {
  const out = new Map<string, Omit<LatestTake, 'matchesRoute'>>();
  const { data: concepts } = await db
    .from('concepts')
    .select('id')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(TAKE_CONCEPT_WINDOW);
  const conceptIds = (concepts ?? []).map((c) => c.id);
  if (conceptIds.length === 0) return out;

  const { data: scripts } = await db.from('scripts').select('id').in('concept_id', conceptIds);
  const scriptIds = (scripts ?? []).map((s) => s.id);
  if (scriptIds.length === 0) return out;

  const { data: takes } = await db
    .from('vo_takes')
    .select('asset_id, voice_id, text_in, created_at')
    .in('script_id', scriptIds)
    .not('asset_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(2000);
  const assetIds = [...new Set((takes ?? []).map((t) => t.asset_id).filter((a): a is string => !!a))];
  if (assetIds.length === 0) return out;

  const { data: assets } = await db.from('assets').select('id, storage_key, meta').in('id', assetIds);
  const byId = new Map((assets ?? []).map((a) => [a.id, a]));

  for (const t of takes ?? []) {
    const a = t.asset_id ? byId.get(t.asset_id) : undefined;
    if (!a) continue;
    const meta = a.meta && typeof a.meta === 'object' && !Array.isArray(a.meta) ? (a.meta as Record<string, unknown>) : {};
    const speaker = typeof meta.speaker === 'string' ? meta.speaker : null;
    // Newest first, so the first one seen per speaker is the most recent.
    if (!speaker || out.has(speaker)) continue;
    out.set(speaker, { storageKey: a.storage_key, voiceKey: t.voice_id, text: t.text_in, createdAt: t.created_at });
  }
  return out;
}

export async function voicesScreen(db: Db, channelId: string, cb: ChannelBible): Promise<VoicesScreen> {
  const [overrides, takes] = await Promise.all([readOverrides(db, channelId), latestTakes(db, channelId)]);
  const asRouting = new Map<string, VoiceOverride>(
    [...overrides.rows].map(([slug, o]) => [slug, { provider: o.provider, voiceId: o.voiceId }]),
  );

  const rows = cb.bible.characters.map((c): VoiceRow => {
    const override = overrides.rows.get(c.id) ?? null;
    const route = routeForCharacter(cb, c.id, asRouting);
    const take = takes.get(c.id);
    return {
      slug: c.id,
      name: c.name,
      role: c.role,
      accentHex: c.accent_hex,
      voiceBrief: c.voice_brief,
      bible: { provider: c.voice.provider, presetId: c.voice.preset_id },
      override,
      overrideProblem: override ? overrideProblem(override) : null,
      route,
      source: override ? 'override' : 'bible',
      take: take ? { ...take, matchesRoute: route.ok && voiceKey(route) === take.voiceKey } : null,
    };
  });
  return { tableMissing: overrides.tableMissing, rows };
}

// ═════════════════════════════════════════════════════════════════════════════
// Writes
// ═════════════════════════════════════════════════════════════════════════════

export const OverrideInputSchema = z.object({
  slug: z.string().regex(/^[a-z_]+$/, 'character slug must be lowercase letters and underscores'),
  provider: z.string().trim().min(1, 'choose a provider'),
  voiceId: z.string().trim().min(1, 'a voice id is required').max(200),
  note: z.string().trim().max(500).optional(),
});
export type OverrideInput = z.infer<typeof OverrideInputSchema>;

export type WriteResult = { ok: true; message: string } | { ok: false; problem: string };

/**
 * Set (or replace) the override for one character of one channel.
 *
 * Refuses, writing nothing: a malformed input, a slug not in this channel's cast, and any
 * override `overrideProblem` rejects — the same predicate the router applies, so nothing this
 * accepts can be refused by the voice stage for being malformed.
 */
export async function setVoiceOverride(
  db: Db,
  args: { channelId: string; cb: ChannelBible; input: OverrideInput; setBy: string | null },
): Promise<WriteResult> {
  const parsed = OverrideInputSchema.safeParse(args.input);
  if (!parsed.success) {
    return { ok: false, problem: `Not saved: ${parsed.error.issues.map((i) => i.message).join('; ')}.` };
  }
  const { slug, provider, voiceId, note } = parsed.data;
  const c = args.cb.characterBySlug(slug);
  if (!c) return { ok: false, problem: `Not saved: "${slug}" is not in the ${args.cb.slug} cast.` };

  const problem = overrideProblem({ provider, voiceId });
  if (problem) return { ok: false, problem: `Not saved: ${problem}.` };

  if (args.cb.source === 'db') {
    // A database bible (0022) holds the voice itself; an override row would be a second place.
    const { setCharacterVoice } = await import('../channels/bible-admin');
    const r = await setCharacterVoice(db, { scope: 'approver', profileId: args.setBy, via: 'ui' }, args.channelId, slug, { provider, voiceId });
    return r.ok ? { ok: true, message: r.message } : { ok: false, problem: `Not saved: ${r.refused}` };
  }

  const { error } = await db.from('channel_voice_overrides').upsert(
    {
      channel_id: args.channelId,
      character_slug: slug,
      voice_provider: provider,
      voice_id: voiceId,
      note: note || null,
      set_by: args.setBy,
      set_at: new Date().toISOString(),
    },
    { onConflict: 'channel_id,character_slug' },
  );
  if (error) return { ok: false, problem: isMissingTable(error) ? `Not saved: ${NEEDS_0046}.` : `Not saved: ${error.message}` };
  return { ok: true, message: `${c.name} now speaks as ${provider}:${voiceId}. The next voice run uses it; earlier takes keep the voice they were spoken in.` };
}

/** Delete the override; the bible's lock applies again. Clearing an absent override is a no-op, said so. */
export async function clearVoiceOverride(
  db: Db,
  args: { channelId: string; cb: ChannelBible; slug: string },
): Promise<WriteResult> {
  const c = args.cb.characterBySlug(args.slug);
  if (!c) return { ok: false, problem: `Not cleared: "${args.slug}" is not in the ${args.cb.slug} cast.` };
  const { data, error } = await db
    .from('channel_voice_overrides')
    .delete()
    .eq('channel_id', args.channelId)
    .eq('character_slug', args.slug)
    .select('character_slug');
  if (error) return { ok: false, problem: isMissingTable(error) ? `Not cleared: ${NEEDS_0046}.` : `Not cleared: ${error.message}` };
  return {
    ok: true,
    message: (data ?? []).length > 0 ? `${c.name} falls back to the bible's voice.` : `${c.name} had no override; the bible's voice already applies.`,
  };
}
