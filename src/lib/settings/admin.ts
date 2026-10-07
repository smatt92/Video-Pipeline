import { z } from 'zod';

import { getBible, type Series } from '../bureau/bible';
import { composeStillPrompt } from '../bureau/stills';
import { VisualFormatSchema, VoicePaceSchema } from '../bureau/formats';
import { updateSeries, type AdminResult, type BibleActor } from '../channels/bible-admin';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { findOrphans } from './orphans';
import { readTuning, TUNING_COLUMNS, TuningSchema, type Tuning } from './tuning';

/**
 * The writes behind Settings → Generation, Assembly, Publishing and Danger zone.
 *
 * Same contract as the channel-bible actions (`channels/bible-admin.ts`), and the same actor
 * type: approver only, refused by name otherwise; validated with Zod (the 0049 ranges);
 * every change in `authorship_log` with what it was and what it became. Pure of the
 * framework — `actions.ts` turns a session into an actor, and `verify:settings` calls these
 * directly against a database.
 */

export type SettingsActor = BibleActor;
export type { AdminResult };

const refuse = (refused: string) => ({ ok: false as const, refused });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
const actorScope = (a: SettingsActor) => (a.via === 'ui' ? 'ui' : a.via.startsWith('script') ? 'system' : 'approver');

function approverOnly(actor: SettingsActor): string | null {
  return actor.scope === 'approver' ? null : 'Only the approver can change settings.';
}

async function log(db: Db, actor: SettingsActor, channelId: string, action: string, subjectType: string, subjectId: string, payload: unknown, exactText?: string) {
  const { error } = await db.from('authorship_log').insert({
    channel_id: channelId,
    actor_scope: actorScope(actor),
    profile_id: actor.profileId,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    payload: payload as Json,
    ...(exactText ? { exact_text: exactText } : {}),
  });
  if (error) throw new Error(`authorship_log: ${error.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Generation · Assembly · Publishing numbers (channel_policy, 0049)
// ═════════════════════════════════════════════════════════════════════════════

/** Change any of a channel's tuning values. Only what is passed changes. Next render only. */
export async function updateTuning(db: Db, actor: SettingsActor, channelId: string, raw: Partial<Tuning>): Promise<AdminResult<{ changed: string[] }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = TuningSchema.partial().strict().safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const keys = Object.keys(parsed.data) as (keyof Tuning)[];
  if (!keys.length) return refuse('Nothing to change.');
  const before = await readTuning(db, channelId);
  if (before.source === 'defaults') return refuse(before.reason);
  const changes = keys.filter((k) => before.values[k] !== parsed.data[k]);
  if (!changes.length) return { ok: true, message: 'Nothing changed — those are the current values.', changed: [] };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actor.profileId ? `${actor.via}:${actor.profileId}` : actor.via };
  for (const k of changes) patch[TUNING_COLUMNS[k]] = parsed.data[k];
  const { error } = await db.from('channel_policy').update(patch as never).eq('channel_id', channelId);
  if (error) return refuse(`Saving failed: ${error.message}`);
  await log(db, actor, channelId, 'settings_update', 'channel_policy', channelId, {
    before: Object.fromEntries(changes.map((k) => [TUNING_COLUMNS[k], before.values[k]])),
    after: Object.fromEntries(changes.map((k) => [TUNING_COLUMNS[k], parsed.data[k]])),
  });
  return { ok: true, message: `Saved ${changes.length} value${changes.length === 1 ? '' : 's'}. The next render uses ${changes.length === 1 ? 'it' : 'them'}; nothing already rendered changes.`, changed: changes.map((k) => TUNING_COLUMNS[k]) };
}

/** IANA zones this runtime knows. Postgres reads the same tz database for `at time zone`. */
function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz === 'UTC' || (Intl.supportedValuesOf?.('timeZone') ?? []).includes(tz);
  } catch {
    return false;
  }
}

export const SlotSchema = z.object({
  slotTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time, HH:MM'),
  timezone: z.string().refine(knownZone, 'not a time zone this runtime knows (an IANA name, e.g. Asia/Kolkata)'),
});

/**
 * The publish slot time and zone (channel_policy.default_slot_time / slot_timezone — 0037, no
 * migration needed). `v_slot_status.publish_at` is computed from both, so every bundle made
 * after this carries the new time; the daily publish cap counts days in the new zone.
 */
export async function updateSlot(db: Db, actor: SettingsActor, channelId: string, raw: z.input<typeof SlotSchema>): Promise<AdminResult> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = SlotSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const { data: cur, error: rErr } = await db.from('channel_policy').select('default_slot_time, slot_timezone').eq('channel_id', channelId).maybeSingle();
  if (rErr || !cur) return refuse(rErr ? rErr.message : 'This channel has no policy row.');
  const { error } = await db.from('channel_policy').update({ default_slot_time: `${parsed.data.slotTime}:00`, slot_timezone: parsed.data.timezone }).eq('channel_id', channelId);
  if (error) return refuse(`Saving failed: ${error.message}`);
  await log(db, actor, channelId, 'settings_update', 'channel_policy', channelId, {
    before: { default_slot_time: cur.default_slot_time, slot_timezone: cur.slot_timezone },
    after: { default_slot_time: `${parsed.data.slotTime}:00`, slot_timezone: parsed.data.timezone },
  });
  return { ok: true, message: `Slot time is ${parsed.data.slotTime} ${parsed.data.timezone}. Bundles made from now on carry it.` };
}

// ═════════════════════════════════════════════════════════════════════════════
// Generation · per-series defaults and the picture style (the channel bible)
// ═════════════════════════════════════════════════════════════════════════════

export const SeriesDefaultsSchema = z
  .object({ visual_format: VisualFormatSchema.optional(), voice_pace: VoicePaceSchema.optional() })
  .refine((v) => v.visual_format !== undefined || v.voice_pace !== undefined, 'pass a video type, a voice pace, or both');

/**
 * A series' default video type and voice pace, written into its bible document through the
 * existing `updateSeries` path (validation, version bump, read-back, authorship). Approvals
 * can still override either per episode (`briefs.approved_edits`).
 */
export async function updateSeriesDefaults(
  db: Db,
  actor: SettingsActor,
  channelId: string,
  seriesId: string,
  raw: z.input<typeof SeriesDefaultsSchema>,
): Promise<AdminResult<{ seriesId: string }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = SeriesDefaultsSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const cb = await getBible(db, channelId);
  const series = cb.series[seriesId as Series['id']];
  if (!series) return refuse(`This channel does not run a series "${seriesId}".`);
  if (cb.source !== 'db') return refuse('This channel’s bible is still the folder in the build. Paste the 0048 bundle (the Bureau import is inside it) to edit series from the app.');
  return updateSeries(db, actor, channelId, { ...series, ...parsed.data });
}

export const STILL_STYLE_MAX = 400;
export const StillStyleSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'the picture style cannot be empty').max(STILL_STYLE_MAX, `at most ${STILL_STYLE_MAX} characters`));

/** The prompt a still would be sent with, for a sample scene — the Settings preview. Pure. */
export function stillPromptPreview(world: Parameters<typeof composeStillPrompt>[0]['world'], accent: string, scene = 'A tidal bulge drawn on both sides of the Earth, the Moon above'): string {
  return composeStillPrompt({ scene, world, accent });
}

/**
 * The bible's `world.still_style` — the look of every generated picture. Written to
 * channel_bibles.world with the version bumped, then read back through `getBible`: a value
 * that leaves the bible unreadable is rolled back and refused.
 */
export async function updateStillStyle(db: Db, actor: SettingsActor, channelId: string, raw: string): Promise<AdminResult<{ style: string }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = StillStyleSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const { data: row, error } = await db.from('channel_bibles').select('world, version').eq('channel_id', channelId).maybeSingle();
  if (error) return refuse(`The channel bible tables are not readable (${error.message}) — paste the 0048 bundle.`);
  if (!row) return refuse('This channel has no database bible yet, so its picture style is the folder’s. Paste the 0048 bundle to edit it here.');
  const world = row.world as Record<string, unknown>;
  const before = typeof world.still_style === 'string' ? world.still_style : null;
  if (before === parsed.data) return { ok: true, message: 'Nothing changed — that is the current style.', style: parsed.data };
  const by = actor.profileId ? `${actor.via}:${actor.profileId}` : actor.via;
  const write = (w: Record<string, unknown>, version: number) =>
    db.from('channel_bibles').update({ world: w as Json, version, updated_at: new Date().toISOString(), updated_by: by }).eq('channel_id', channelId);
  const { error: wErr } = await write({ ...world, still_style: parsed.data }, row.version + 1);
  if (wErr) return refuse(`Saving failed: ${wErr.message}`);
  try {
    const back = await getBible(db, channelId);
    if (back.bible.world.still_style !== parsed.data) throw new Error('the style did not read back');
  } catch (err) {
    await write(world, row.version + 2);
    return refuse(`Not saved — the bible would not read with it: ${err instanceof Error ? err.message : String(err)}`);
  }
  await log(db, actor, channelId, 'still_style_update', 'channel_bible', channelId, { before, after: parsed.data }, parsed.data);
  return { ok: true, message: 'Picture style saved. Pictures drawn from now on use it; stored ones are not redrawn.', style: parsed.data };
}

// ═════════════════════════════════════════════════════════════════════════════
// Danger zone — every action needs the channel's slug typed back
// ═════════════════════════════════════════════════════════════════════════════

/** The phrase the person must type to confirm: the channel's slug, or its name without one. */
export async function confirmPhrase(db: Db, channelId: string): Promise<string | null> {
  const { data } = await db.from('channels').select('slug, name').eq('id', channelId).maybeSingle();
  return data ? (data.slug ?? data.name) : null;
}

async function confirmed(db: Db, channelId: string, typed: string): Promise<string | null> {
  const phrase = await confirmPhrase(db, channelId);
  if (!phrase) return 'No such channel.';
  return typed.trim() === phrase ? null : `Type the channel’s slug exactly (${phrase}) to confirm.`;
}

/** Running statuses an episode can be stuck in, beyond `failed`. */
const RUNNING = ['queued', 'scripting', 'shotlisting', 'estimating', 'generating', 'qc', 'voicing', 'assembling'] as const;
export const UNSTICK_QUIET_MS = 30 * 60_000;

/** Episodes Unstick can act on, newest first: failed, or running with no write for 30 min. */
export async function stuckEpisodes(db: Db, channelId: string, now = Date.now()) {
  const { data, error } = await db
    .from('episodes')
    .select('id, slot_id, status, status_detail, updated_at, brief_id')
    .eq('channel_id', channelId)
    .in('status', [...RUNNING, 'failed'])
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).filter((e) => e.status === 'failed' || now - Date.parse(e.updated_at) > UNSTICK_QUIET_MS);
}

export const UnstickSchema = z.object({ episodeId: z.uuid(), reason: z.string().trim().min(3, 'say why, in a few words').max(300), confirm: z.string() });

/**
 * Set a stalled or failed episode to `halted`, with the reason, so Restart run appears on the
 * Board. Nothing is deleted and nothing is spent: Restart re-uses everything already paid for.
 * Refuses an episode that is still writing (updated in the last 30 minutes) — that is a run.
 */
export async function unstickEpisode(db: Db, actor: SettingsActor, channelId: string, raw: z.input<typeof UnstickSchema>, now = Date.now()): Promise<AdminResult<{ episodeId: string }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = UnstickSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const bad = await confirmed(db, channelId, parsed.data.confirm);
  if (bad) return refuse(bad);
  const { data: ep, error } = await db.from('episodes').select('id, status, status_detail, updated_at, channel_id').eq('id', parsed.data.episodeId).maybeSingle();
  if (error) return refuse(error.message);
  if (!ep || ep.channel_id !== channelId) return refuse('No such episode on this channel.');
  const quiet = now - Date.parse(ep.updated_at) > UNSTICK_QUIET_MS;
  if (ep.status !== 'failed' && !((RUNNING as readonly string[]).includes(ep.status) && quiet)) {
    return refuse(
      (RUNNING as readonly string[]).includes(ep.status)
        ? `Episode is ${ep.status} and wrote ${Math.round((now - Date.parse(ep.updated_at)) / 60_000)} min ago — that is a run in progress. Unstick only acts after 30 quiet minutes.`
        : `Episode is ${ep.status}; only a failed or stalled episode can be unstuck.`,
    );
  }
  const detail = `unstuck from Settings: ${parsed.data.reason}`;
  const { error: uErr } = await db.from('episodes').update({ status: 'halted', status_detail: detail, updated_at: new Date(now).toISOString() }).eq('id', ep.id);
  if (uErr) return refuse(`Saving failed: ${uErr.message}`);
  await log(db, actor, channelId, 'episode_unstick', 'episode', ep.id, { before: { status: ep.status, status_detail: ep.status_detail, updated_at: ep.updated_at }, after: { status: 'halted', status_detail: detail } }, parsed.data.reason);
  return { ok: true, message: 'Halted. Restart run is on the Board for it now; nothing was deleted.', episodeId: ep.id };
}

export const PurgeRequestSchema = z.object({ confirm: z.string(), count: z.number().int().positive(), assetIds: z.array(z.uuid()).min(1).max(5000) });

/**
 * The approver's request to delete orphans: the slug typed back AND the count they were shown
 * (the second confirmation). Re-runs the finder here so a stale page cannot ask for more than
 * is orphaned now, records the request, and returns what the worker task should delete. The
 * task itself (`99-purge-orphans`) checks again before each delete.
 */
export async function requestOrphanPurge(db: Db, actor: SettingsActor, channelId: string, raw: z.input<typeof PurgeRequestSchema>): Promise<AdminResult<{ assetIds: string[] }>> {
  const denied = approverOnly(actor);
  if (denied) return refuse(denied);
  const parsed = PurgeRequestSchema.safeParse(raw);
  if (!parsed.success) return refuse(issues(parsed.error));
  const bad = await confirmed(db, channelId, parsed.data.confirm);
  if (bad) return refuse(bad);
  if (parsed.data.count !== parsed.data.assetIds.length) return refuse(`You confirmed ${parsed.data.count} but ${parsed.data.assetIds.length} were sent. Reload and look again.`);
  const report = await findOrphans(db);
  const now = new Set(report.orphans.map((o) => o.id));
  const assetIds = parsed.data.assetIds.filter((id) => now.has(id));
  if (assetIds.length !== parsed.data.count) {
    return refuse(`${parsed.data.count - assetIds.length} of those are no longer orphans (something references them now). Run Find orphans again.`);
  }
  await log(db, actor, channelId, 'orphans_purge_requested', 'assets', `${assetIds.length} assets`, { asset_ids: assetIds, known_bytes: report.orphans.filter((o) => now.has(o.id)).reduce((n, o) => n + (o.bytes ?? 0), 0) });
  return { ok: true, message: `${assetIds.length} orphan${assetIds.length === 1 ? '' : 's'} sent to the worker to delete.`, assetIds };
}
