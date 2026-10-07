import { z } from 'zod';

import {
  bibleForSlug,
  bibleRows,
  BIBLE_SLUGS,
  CharacterSchema,
  characterRow,
  getBible,
  PolicySchema,
  SeriesSchema,
  syncCast,
  templateBible,
  TrendsConfigSchema,
  voiceOverrides,
  type ChannelBible,
  type Character,
} from '../bureau/bible';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { DEFAULT_VOICE_PROVIDER, presetVoice, storedVoiceFromOverride, TTS_PRESET_IDS, VOICE_FIELD_MASK, type StoredVoice } from '../drivers/voice-route';

/**
 * Writing a channel's bible — the approver's actions behind "+ Add channel" and the
 * per-channel setup (decision 0022). Every write here:
 *
 *   1. refuses anyone but the approver, by name;
 *   2. validates with the SAME Zod schema the bible is read with (bible.ts), and then
 *      re-reads the whole bible through `getBible` after writing — a write that would leave
 *      the channel with a bible that does not parse is rolled back and refused;
 *   3. bumps `channel_bibles.version` and records who (`updated_by`);
 *   4. writes one `authorship_log` row with the exact change.
 *
 * Pure of the framework: a Db and an actor in, a result out. `actions.ts` is the 'use server'
 * wrapper that turns a signed-in session into an actor; harnesses call these directly.
 */

export interface BibleActor {
  /** Only 'approver' may write. An agent token reaching here is refused. */
  scope: 'approver' | 'agent';
  /** The signed-in person, when there is one. */
  profileId: string | null;
  /** Where the write came from, for authorship_log and updated_by: 'ui', 'script:voice-lock', … */
  via: string;
}

export type AdminResult<T = unknown> = ({ ok: true; message: string } & T) | { ok: false; refused: string };

const refuse = (refused: string) => ({ ok: false as const, refused });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
const actorScope = (a: BibleActor) => (a.via === 'ui' ? 'ui' : a.via.startsWith('script') || a.via.startsWith('import') ? 'system' : 'approver');
const updatedBy = (a: BibleActor) => (a.profileId ? `${a.via}:${a.profileId}` : a.via);

async function log(db: Db, actor: BibleActor, channelId: string, action: string, subjectType: string, subjectId: string, payload: unknown) {
  await db.from('authorship_log').insert({
    channel_id: channelId,
    actor_scope: actorScope(actor),
    profile_id: actor.profileId,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    payload: payload as Json,
  });
}

function approverOnly(actor: BibleActor): string | null {
  return actor.scope === 'approver' ? null : 'Only the approver can change a channel bible.';
}

/** The channel's database bible row, or a refusal saying how to get one. */
async function requireDbBible(db: Db, channelId: string): Promise<{ version: number } | string> {
  const { data, error } = await db.from('channel_bibles').select('version').eq('channel_id', channelId).maybeSingle();
  if (error) return `The channel bible tables are not readable (${error.message}) — paste the 0048 bundle.`;
  if (!data) return 'This channel has no database bible yet. Import its folder first (pnpm bible:import), or create the channel from the app.';
  return data;
}

/** Re-read through the one loader; a write that breaks the bible is reported, never left silent. */
async function proveReadable(db: Db, channelId: string): Promise<ChannelBible | string> {
  try {
    const cb = await getBible(db, channelId);
    if (cb.source !== 'db') return 'the database bible was not read back';
    return cb;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function bump(db: Db, channelId: string, actor: BibleActor, patch: Record<string, unknown> = {}) {
  const cur = await requireDbBible(db, channelId);
  const version = typeof cur === 'string' ? 1 : cur.version + 1;
  const { error } = await db
    .from('channel_bibles')
    .update({ ...patch, version, updated_at: new Date().toISOString(), updated_by: updatedBy(actor) })
    .eq('channel_id', channelId);
  return error ? error.message : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Import — a folder bible into the tables (idempotent)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Copy a folder bible into the tables for a channel. Idempotent: an existing database bible
 * or cast row is left exactly as it is (insert … on conflict do nothing), so re-running it
 * can never undo an edit made in the app. Voice overrides set on the Voices screen (0046) are
 * folded into the cast and their rows removed — one place for a voice, not two.
 */
export async function importFolderBible(
  db: Db,
  input: { channelId: string; slug: string; by: string },
): Promise<{ bible: 'inserted' | 'kept'; characters: number; foldedOverrides: string[] }> {
  const cb = bibleForSlug(input.slug);
  const rows = bibleRows(cb, input.channelId, input.by);
  const { data: had } = await db.from('channel_bibles').select('channel_id').eq('channel_id', input.channelId).maybeSingle();
  if (!had) {
    const { error } = await db.from('channel_bibles').insert(rows.bible);
    if (error && !/duplicate key|unique/i.test(error.message)) throw new Error(`importing the bible of ${input.slug}: ${error.message}`);
  }
  const { data: existing } = await db.from('channel_characters').select('slug').eq('channel_id', input.channelId);
  const have = new Set((existing ?? []).map((r) => r.slug));
  const fresh = rows.characters.filter((c) => !have.has(c.slug));
  if (fresh.length) {
    const { error } = await db.from('channel_characters').insert(fresh);
    if (error && !/duplicate key|unique/i.test(error.message)) throw new Error(`importing the cast of ${input.slug}: ${error.message}`);
  }
  const folded = await foldVoiceOverrides(db, input.channelId);
  return { bible: had ? 'kept' : 'inserted', characters: fresh.length, foldedOverrides: folded };
}

/** channel_voice_overrides → channel_characters.voice, then delete the folded rows. */
export async function foldVoiceOverrides(db: Db, channelId: string): Promise<string[]> {
  const overrides = await voiceOverrides(db, channelId);
  const folded: string[] = [];
  for (const [slug, o] of overrides) {
    const { data: c } = await db.from('channel_characters').select('voice').eq('channel_id', channelId).eq('slug', slug).maybeSingle();
    if (!c) continue;
    const cur = c.voice as StoredVoice;
    const next = storedVoiceFromOverride(o, cur);
    if (!next) continue; // an unusable override is left where the Voices screen shows its problem
    await db.from('channel_characters').update({ voice: next as unknown as Json, updated_at: new Date().toISOString() }).eq('channel_id', channelId).eq('slug', slug);
    await db.from('channel_voice_overrides').delete().eq('channel_id', channelId).eq('character_slug', slug);
    folded.push(slug);
  }
  return folded;
}

// ═════════════════════════════════════════════════════════════════════════════
// createChannel
// ═════════════════════════════════════════════════════════════════════════════

const Handle = z.string().trim().max(60).optional().transform((v) => (v ? v.replace(/^@?/, '@') : null));

export const CreateChannelSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and hyphens'),
  handle: Handle,
  niche: z.string().trim().max(200).optional(),
  accent_hex: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, 'a colour like #22D3EE').optional().or(z.literal('').transform(() => undefined)),
  youtube_channel_id: z.string().trim().regex(/^UC[A-Za-z0-9_-]{22}$/, 'a YouTube channel id starts UC and is 24 characters').optional().or(z.literal('').transform(() => undefined)),
  instagram_account_id: z.string().trim().regex(/^\d{5,25}$/, 'an Instagram professional account id is digits').optional().or(z.literal('').transform(() => undefined)),
  instagram_handle: Handle,
  targets: z.array(z.enum(['youtube', 'instagram'])).min(1, 'pick at least one platform'),
  /** Which bible to start from: the template (default) or a folder in the build, copied. */
  template: z.string().trim().optional(),
});
export type CreateChannelInput = z.input<typeof CreateChannelSchema>;

/**
 * Add a channel from the app: the row, its policy, its publish targets, and its bible in the
 * database, started from a template — no folder, no commit, no deploy. The cast is synced so
 * the first episode run finds it; a template cast member has no locked voice, so the voice
 * stage refuses it by name until `lockVoice` is called.
 */
export async function createChannel(
  db: Db,
  actor: BibleActor,
  raw: CreateChannelInput,
): Promise<AdminResult<{ channelId: string; slug: string; cast: number; targets: string[]; warnings: string[] }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = CreateChannelSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const input = parsed.data;

  const from = input.template && input.template !== '_template' ? input.template : null;
  if (from && !BIBLE_SLUGS.includes(from)) return refuse(`No template "${from}". Start from the default template, or one of: ${BIBLE_SLUGS.join(', ') || 'none'}.`);
  const tmpl = from ? bibleForSlug(from) : templateBible();

  const { data: taken } = await db.from('channels').select('id, name').eq('slug', input.slug).maybeSingle();
  if (taken) return refuse(`The slug "${input.slug}" already belongs to channel "${taken.name}".`);
  const probe = await db.from('channel_bibles').select('channel_id').limit(1);
  if (probe.error) return refuse(`The channel bible tables are not readable (${probe.error.message}) — paste the 0048 bundle first.`);

  const world = { ...tmpl.bible.world, name: from ? tmpl.bible.world.name : input.name, premise: input.niche || tmpl.bible.world.premise };
  const characters: Character[] = tmpl.bible.characters.map((c, i) => (i === 0 && input.accent_hex ? { ...c, accent_hex: input.accent_hex } : c));
  const seeded = { bible: { ...tmpl.bible, channel: input.slug, world, characters }, policy: tmpl.policy, series: tmpl.series, trends: tmpl.trends };

  const primary = input.targets.includes('youtube') ? 'youtube' : 'instagram';
  const { data: ch, error } = await db
    .from('channels')
    .insert({
      name: input.name,
      slug: input.slug,
      handle: input.handle,
      niche: input.niche || world.premise,
      platform: primary,
      external_id: primary === 'youtube' ? (input.youtube_channel_id ?? null) : (input.instagram_account_id ?? null),
      is_active: true,
    })
    .select('id')
    .single();
  if (error || !ch) return refuse(`Creating the channel failed: ${error?.message ?? 'no row'}`);

  const warnings: string[] = [];
  const { error: polErr } = await db.from('channel_policy').insert({ channel_id: ch.id });
  if (polErr) warnings.push(`channel policy: ${polErr.message}`);
  const { error: tErr } = await db.from('channel_publish_targets').insert(
    input.targets.map((p) => ({
      channel_id: ch.id,
      platform: p,
      enabled: true,
      handle: p === 'instagram' ? input.instagram_handle : input.handle,
      external_id: p === 'instagram' ? (input.instagram_account_id ?? null) : (input.youtube_channel_id ?? null),
    })),
  );
  if (tErr) warnings.push(`publish targets were not recorded (${tErr.message})`);

  const rows = bibleRows(seeded, ch.id, updatedBy(actor));
  const { error: bErr } = await db.from('channel_bibles').insert(rows.bible);
  const { error: cErr } = bErr ? { error: null } : await db.from('channel_characters').insert(rows.characters);
  if (bErr || cErr) {
    // Nothing half-made: a channel row with no bible would be refused by every screen.
    await db.from('channels').delete().eq('id', ch.id);
    return refuse(`Writing the bible failed: ${(bErr ?? cErr)!.message}`);
  }
  const cb = await proveReadable(db, ch.id);
  if (typeof cb === 'string') {
    await db.from('channels').delete().eq('id', ch.id);
    return refuse(`The new bible does not read back: ${cb}`);
  }
  const cast = await syncCast(db as unknown as Parameters<typeof syncCast>[0], ch.id, cb);
  await log(db, actor, ch.id, 'channel_create', 'channel', ch.id, { slug: input.slug, template: from ?? '_template', targets: input.targets, accent_hex: input.accent_hex ?? null });
  return {
    ok: true,
    message: `Created ${input.name} from ${from ? `the ${from} bible` : 'the template'}: ${cast.synced} cast member(s); lock their voices before the first episode.`,
    channelId: ch.id,
    slug: input.slug,
    cast: cast.synced,
    targets: input.targets,
    warnings,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Cast
// ═════════════════════════════════════════════════════════════════════════════

/** A character as the app edits it. Voice is set with lockVoice; frames with frame:lock. */
export const CharacterInputSchema = CharacterSchema.omit({ ...VOICE_FIELD_MASK, reference_frame_ids: true }).extend({
  sort: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
});
export type CharacterInput = z.input<typeof CharacterInputSchema>;

export async function upsertCharacter(db: Db, actor: BibleActor, channelId: string, raw: CharacterInput): Promise<AdminResult<{ slug: string; created: boolean }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = CharacterInputSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const has = await requireDbBible(db, channelId);
  if (typeof has === 'string') return refuse(has);
  const { sort, active, ...c } = parsed.data;

  const { data: cur } = await db.from('channel_characters').select('id, voice, reference_frame, sort, active').eq('channel_id', channelId).eq('slug', c.id).maybeSingle();
  const { count } = await db.from('channel_characters').select('id', { count: 'exact', head: true }).eq('channel_id', channelId);
  const full: Character = {
    ...c,
    voice: cur ? (cur.voice as Character['voice']) : { provider: DEFAULT_VOICE_PROVIDER, preset_id: null },
    reference_frame_ids: cur ? (cur.reference_frame as string[]) : [],
  };
  const row = { ...characterRow(full, channelId, sort ?? cur?.sort ?? count ?? 0), active: active ?? cur?.active ?? true, updated_at: new Date().toISOString() };
  if (cur) row.voice = cur.voice as Json; // the stored voice, untouched (it may carry a direct id)
  const { error } = cur
    ? await db.from('channel_characters').update(row).eq('id', cur.id)
    : await db.from('channel_characters').insert(row);
  if (error) return refuse(`Saving ${c.name} failed: ${error.message}`);
  const back = await proveReadable(db, channelId);
  if (typeof back === 'string') return refuse(`Saved, but the bible no longer reads: ${back}`);
  await bump(db, channelId, actor);
  await syncCast(db as unknown as Parameters<typeof syncCast>[0], channelId, back);
  await log(db, actor, channelId, cur ? 'character_update' : 'character_create', 'character', c.id, { character: c, sort: row.sort, active: row.active });
  return { ok: true, message: `${c.name} ${cur ? 'updated' : 'added'}.`, slug: c.id, created: !cur };
}

export const LockVoiceSchema = z.object({
  characterSlug: z.string().regex(/^[a-z_]+$/),
  presetId: z.enum(TTS_PRESET_IDS, { message: `not a preset the voice vendor offers (${TTS_PRESET_IDS.length} known)` }),
});

/**
 * Lock a character's voice to a preset — what `pnpm voice:lock` wrote into characters.json,
 * now a row, read by the voice stage on its next run with no deploy. Validated against the
 * vendor's preset list (TTS_PRESET_IDS), the same list the router checks.
 */
export async function lockVoice(db: Db, actor: BibleActor, channelId: string, raw: z.input<typeof LockVoiceSchema>): Promise<AdminResult<{ slug: string; presetId: string }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = LockVoiceSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const has = await requireDbBible(db, channelId);
  if (typeof has === 'string') return refuse(has);
  const { characterSlug, presetId } = parsed.data;
  const { data: cur } = await db.from('channel_characters').select('id, name, voice').eq('channel_id', channelId).eq('slug', characterSlug).maybeSingle();
  if (!cur) return refuse(`No character "${characterSlug}" in this channel's cast.`);
  const prev = cur.voice as StoredVoice;
  const voice = presetVoice(presetId, prev);
  const { error } = await db.from('channel_characters').update({ voice: voice as unknown as Json, updated_at: new Date().toISOString() }).eq('id', cur.id);
  if (error) return refuse(`Locking the voice failed: ${error.message}`);
  // A Voices-screen override would still win over the lock; the lock is the newer decision.
  await db.from('channel_voice_overrides').delete().eq('channel_id', channelId).eq('character_slug', characterSlug);
  const back = await proveReadable(db, channelId);
  if (typeof back === 'string') return refuse(`Locked, but the bible no longer reads: ${back}`);
  await bump(db, channelId, actor);
  await syncCast(db as unknown as Parameters<typeof syncCast>[0], channelId, back);
  await log(db, actor, channelId, 'voice_lock', 'character', characterSlug, { from: prev, to: voice });
  return { ok: true, message: `${cur.name} now speaks as ${presetId}. The next voice run uses it — no deploy.`, slug: characterSlug, presetId };
}

/**
 * The Voices screen's "Change voice" on a channel whose bible is in the database: the choice
 * becomes the character's stored voice (one place for a voice — 0022), not an override row.
 * Any provider the router accepts; `overrideProblem` is the same predicate it applies.
 */
export async function setCharacterVoice(db: Db, actor: BibleActor, channelId: string, slug: string, o: { provider: string; voiceId: string }): Promise<AdminResult> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const { data: cur } = await db.from('channel_characters').select('id, name, voice').eq('channel_id', channelId).eq('slug', slug).maybeSingle();
  if (!cur) return refuse(`No character "${slug}" in this channel's cast.`);
  const next = storedVoiceFromOverride(o, cur.voice as StoredVoice);
  if (!next) return refuse(`"${o.provider}:${o.voiceId}" is not a voice the router can use.`);
  const { error } = await db.from('channel_characters').update({ voice: next as unknown as Json, updated_at: new Date().toISOString() }).eq('id', cur.id);
  if (error) return refuse(error.message);
  const back = await proveReadable(db, channelId);
  if (typeof back === 'string') return refuse(`Saved, but the bible no longer reads: ${back}`);
  await bump(db, channelId, actor);
  await syncCast(db as unknown as Parameters<typeof syncCast>[0], channelId, back);
  await log(db, actor, channelId, 'voice_set', 'character', slug, { from: cur.voice, to: next });
  return { ok: true, message: `${cur.name} now speaks as ${o.provider}:${o.voiceId}. The next voice run uses it; earlier takes keep the voice they were spoken in.` };
}

// ═════════════════════════════════════════════════════════════════════════════
// Series, policy, caps, trend sources
// ═════════════════════════════════════════════════════════════════════════════

/** Add or replace one series document (validated by SeriesSchema). */
export async function updateSeries(db: Db, actor: BibleActor, channelId: string, raw: unknown): Promise<AdminResult<{ seriesId: string }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = SeriesSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const has = await requireDbBible(db, channelId);
  if (typeof has === 'string') return refuse(has);
  const { data } = await db.from('channel_bibles').select('series').eq('channel_id', channelId).single();
  const series = { ...((data?.series ?? {}) as Record<string, unknown>), [parsed.data.id]: parsed.data };
  const err = await bump(db, channelId, actor, { series: series as Json });
  if (err) return refuse(`Saving the series failed: ${err}`);
  const back = await proveReadable(db, channelId);
  if (typeof back === 'string') return refuse(`Saved, but the bible no longer reads: ${back}`);
  await log(db, actor, channelId, 'series_update', 'series', parsed.data.id, parsed.data);
  return { ok: true, message: `${parsed.data.name} saved.`, seriesId: parsed.data.id };
}

export const CapsSchema = z
  .object({
    per_short_cap_inr: z.number().positive().max(100_000),
    daily_cap_inr: z.number().positive().max(1_000_000),
    daily_longform_cap_inr: z.number().positive().max(1_000_000),
    monthly_cap_inr: z.number().positive().max(10_000_000),
    stills_enabled: z.boolean(),
  })
  .partial();

/**
 * The content policy (policy.json → channel_bibles.policy) and/or the money caps
 * (channel_policy). One action because the setup flow edits them on one screen; each half is
 * validated and written separately, and only what is passed changes.
 */
export async function updatePolicy(
  db: Db,
  actor: BibleActor,
  channelId: string,
  raw: { policy?: unknown; caps?: z.input<typeof CapsSchema> },
): Promise<AdminResult> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const changed: string[] = [];
  if (raw.policy !== undefined) {
    const p = PolicySchema.safeParse(raw.policy);
    if (!p.success) return refuse(`policy: ${issues(p.error)}`);
    const has = await requireDbBible(db, channelId);
    if (typeof has === 'string') return refuse(has);
    const err = await bump(db, channelId, actor, { policy: p.data as unknown as Json });
    if (err) return refuse(`Saving the policy failed: ${err}`);
    const back = await proveReadable(db, channelId);
    if (typeof back === 'string') return refuse(`Saved, but the bible no longer reads: ${back}`);
    changed.push('content policy');
    await log(db, actor, channelId, 'policy_update', 'channel', channelId, { policy: p.data });
  }
  if (raw.caps !== undefined) {
    const c = CapsSchema.safeParse(raw.caps);
    if (!c.success) return refuse(`caps: ${issues(c.error)}`);
    if (Object.keys(c.data).length) {
      const { error } = await db.from('channel_policy').update(c.data).eq('channel_id', channelId);
      if (error) return refuse(`Saving the caps failed: ${error.message}`);
      changed.push(Object.keys(c.data).join(', '));
      await log(db, actor, channelId, 'caps_update', 'channel', channelId, c.data);
    }
  }
  if (!changed.length) return refuse('Nothing to change: pass policy, caps, or both.');
  return { ok: true, message: `Saved: ${changed.join('; ')}.` };
}

export async function updateTrendSources(db: Db, actor: BibleActor, channelId: string, raw: unknown): Promise<AdminResult> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = TrendsConfigSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const has = await requireDbBible(db, channelId);
  if (typeof has === 'string') return refuse(has);
  const err = await bump(db, channelId, actor, { trend_sources: parsed.data as unknown as Json });
  if (err) return refuse(`Saving the trend sources failed: ${err}`);
  await log(db, actor, channelId, 'trend_sources_update', 'channel', channelId, parsed.data);
  return { ok: true, message: `Trend sources saved: ${parsed.data.subreddits.length} subreddit(s), ${parsed.data.youtube ? 'YouTube on' : 'YouTube off'}.` };
}

/** Field-by-field equality of two bibles, for the import proof. Empty = identical. */
export function bibleDiff(a: Pick<ChannelBible, 'bible' | 'policy' | 'series' | 'trends'>, b: Pick<ChannelBible, 'bible' | 'policy' | 'series' | 'trends'>): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return void out.push(`${path}: ${JSON.stringify(x)?.slice(0, 80)} ≠ ${JSON.stringify(y)?.slice(0, 80)}`);
      x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`));
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      return;
    }
    // A key absent on one side and null/undefined on the other is the same fact.
    if ((x ?? null) !== (y ?? null)) out.push(`${path}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`);
  };
  walk(a.bible, b.bible, 'bible');
  walk(a.policy, b.policy, 'policy');
  walk(a.series, b.series, 'series');
  walk(a.trends, b.trends, 'trends');
  return out;
}

