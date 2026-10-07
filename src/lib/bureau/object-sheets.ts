import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { STILL_PROMPT_MAX, STILL_RATIO } from '../drivers/still-image';
import { OBJECT_SHEET_PROMPT_REF, objectSheetPrompt } from '../prompts/22-object-sheet.v1';
import { getBible, STORAGE_REF_PREFIX } from './bible';
import { requireApprover } from './control';
import { engineeredLook, heroObjectsOf, type HeroObject } from './engineered';
import { makeSheetImage, type SheetDeps, type SheetResult } from './sheet-core';
import type { BureauToken } from './tokens';

/**
 * Hero-object reference sheets — the engineered format's counterpart of character sheets
 * (0052; character-sheets.ts is decision 0024).
 *
 * A character is the same person in every episode, so its sheet is made once and locked by
 * Sahil. A hero object is the topic of ONE episode (the airbag, the lift brake), so its sheet is
 * made per episode, by the run, before the first picture: one image per object, ledgered
 * through the shared sheet path (sheet-core.ts). There is no lock step to wait on — the first
 * good sheet is locked automatically and every picture of the episode is given it as a tagged
 * reference (`@Airbag`). Cuts shows each sheet and offers Redraw: a redraw makes a new sheet
 * (approver only, logged, on the worker) and locks it for every picture drawn after it.
 *
 * Where the lock lives: `episodes.qc.plan.objects` — [{tag, name, generation_id, storage_key}].
 * The episode's plan is where Cuts already reads what the run decided; no migration.
 * An object whose sheet could not be made is recorded in `qc.plan.objects_missing` with the
 * reason, and its pictures name it by description instead of by reference — never silently.
 */

export const OBJECT_SHEET_PURPOSE = 'object_sheet';
export const OBJECT_SHEET_STAGE = '05-object-sheet';
/** Attempts per object per episode the key space allows (the first plus redraws). */
export const OBJECT_SHEET_MAX_ATTEMPTS = 10;

export interface LockedObject {
  tag: string;
  name: string;
  generation_id: string;
  storage_key: string;
  attempt: number;
}

const keyOf = (episodeId: string, tag: string, attempt: number) => `objsheet:${episodeId}:${tag}:${attempt}`;

type Plan = { objects?: LockedObject[]; objects_missing?: { tag: string; reason: string }[] } & Record<string, unknown>;

async function readPlan(db: Db, episodeId: string): Promise<{ qc: Record<string, unknown>; plan: Plan }> {
  const { data } = await db.from('episodes').select('qc').eq('id', episodeId).single();
  const qc = ((data?.qc ?? {}) as Record<string, unknown>) ?? {};
  return { qc, plan: ((qc.plan ?? {}) as Plan) ?? {} };
}

/** The sheets locked for this episode, by tag. Read by the stills step, the redraw and Cuts. */
export async function lockedObjects(db: Db, episodeId: string): Promise<LockedObject[]> {
  return (await readPlan(db, episodeId)).plan.objects ?? [];
}

async function lock(db: Db, episodeId: string, o: LockedObject) {
  const { qc, plan } = await readPlan(db, episodeId);
  const objects = [...(plan.objects ?? []).filter((x) => x.tag !== o.tag), o];
  const missing = (plan.objects_missing ?? []).filter((x) => x.tag !== o.tag);
  await db.from('episodes').update({ qc: { ...qc, plan: { ...plan, objects, objects_missing: missing } } as unknown as Json, updated_at: new Date().toISOString() }).eq('id', episodeId);
}

async function recordMissing(db: Db, episodeId: string, tag: string, reason: string) {
  const { qc, plan } = await readPlan(db, episodeId);
  const missing = [...(plan.objects_missing ?? []).filter((x) => x.tag !== tag), { tag, reason }];
  await db.from('episodes').update({ qc: { ...qc, plan: { ...plan, objects_missing: missing } } as unknown as Json }).eq('id', episodeId);
}

/** How many sheet attempts an object already has on this episode (each a distinct key, rule 6). */
async function attemptsOf(db: Db, episodeId: string, tag: string): Promise<number> {
  const keys = Array.from({ length: OBJECT_SHEET_MAX_ATTEMPTS }, (_, i) => keyOf(episodeId, tag, i));
  const { data } = await db.from('generations').select('idempotency_key').in('idempotency_key', keys);
  return (data ?? []).length;
}

/** One sheet for one object of one episode, at the next attempt. Locks it when it succeeds. */
export async function generateObjectSheet(
  db: Db,
  input: { episodeId: string; channelId: string; object: HeroObject; note?: string | null; look: { scene: string; negative: string } },
  deps: SheetDeps,
): Promise<SheetResult> {
  const attempt = await attemptsOf(db, input.episodeId, input.object.tag);
  if (attempt >= OBJECT_SHEET_MAX_ATTEMPTS) return { ok: false, reason: `${input.object.name} already has ${attempt} sheets on this episode — the limit`, spent: false };
  const note = input.note?.trim() ? input.note.trim().replace(/\s+/g, ' ').slice(0, 200) : null;
  const p = objectSheetPrompt(input.object, input.look, note ?? undefined, STILL_PROMPT_MAX);
  if (!p.ok) return { ok: false, reason: p.reason, spent: false };
  const key = keyOf(input.episodeId, input.object.tag, attempt);
  const r = await makeSheetImage(
    db,
    {
      key,
      channelId: input.channelId,
      prompt: p.prompt,
      payload: { purpose: OBJECT_SHEET_PURPOSE, channel_id: input.channelId, episode_id: input.episodeId, object: input.object.tag, name: input.object.name, attempt, note, prompt: p.prompt, prompt_ref: OBJECT_SHEET_PROMPT_REF, ratio: STILL_RATIO },
      stage: OBJECT_SHEET_STAGE,
      storageKeyFor: (genId, ext) => `objects/${input.episodeId}/${input.object.tag}-${attempt}-${genId.slice(0, 8)}.${ext}`,
      assetMeta: { purpose: OBJECT_SHEET_PURPOSE, episode_id: input.episodeId, object: input.object.tag, prompt_ref: OBJECT_SHEET_PROMPT_REF },
      noun: 'object sheet',
    },
    deps,
  );
  if (r.ok) await lock(db, input.episodeId, { tag: input.object.tag, name: input.object.name, generation_id: r.generationId, storage_key: r.storageKey, attempt });
  return r;
}

/**
 * The run's step: every hero object of the episode gets a locked sheet, or is recorded as
 * missing with the reason. Replayable — an object already locked is not paid for again.
 * Sequential: each sheet re-reads the cap after the previous one's ledger row.
 */
export async function prepareObjectSheets(db: Db, episodeId: string, deps: SheetDeps): Promise<{ made: number; reused: number; missing: { tag: string; reason: string }[]; costInr: number }> {
  const { data: e } = await db.from('episodes').select('id, channel_id, brief_id').eq('id', episodeId).single();
  if (!e) throw new Error(`episode ${episodeId} not found`);
  const { data: b } = await db.from('briefs').select('hero_objects').eq('id', e.brief_id).single();
  const objects = heroObjectsOf((b as { hero_objects?: unknown } | null)?.hero_objects);
  const cb = await getBible(db, e.channel_id);
  const look = engineeredLook(cb.bible.world);
  const have = new Set((await lockedObjects(db, episodeId)).map((o) => o.tag));
  let made = 0;
  let reused = 0;
  let costInr = 0;
  const missing: { tag: string; reason: string }[] = [];
  for (const o of objects) {
    if (have.has(o.tag)) {
      reused++;
      continue;
    }
    const r = await generateObjectSheet(db, { episodeId, channelId: e.channel_id, object: o, look }, deps);
    if (r.ok) {
      made++;
      costInr += r.costInr;
    } else {
      missing.push({ tag: o.tag, reason: r.reason });
      await recordMissing(db, episodeId, o.tag, r.reason);
      deps.log?.error('object sheet not made', { tag: o.tag, reason: r.reason });
    }
  }
  return { made, reused, missing, costInr: Math.round(costInr * 100) / 100 };
}

/** The hero objects a picture shows, as tagged references (≤ 3): the locked ones only. */
export function objectRefs(locked: readonly LockedObject[], wanted: readonly string[] | undefined): { tag: string; name: string; ref: string }[] {
  const tags = wanted && wanted.length ? wanted : locked.map((o) => o.tag);
  return tags
    .map((t) => locked.find((o) => o.tag === t))
    .filter((o): o is LockedObject => !!o)
    .slice(0, 3)
    .map((o) => ({ tag: o.tag, name: o.name, ref: `${STORAGE_REF_PREFIX}${o.storage_key}` }));
}

export interface ObjectSheetEffects {
  /** Start `28-object-sheet`; returns the run id. */
  startObjectSheet?(input: { episodeId: string; tag: string; note: string | null; requestId: string }): Promise<string | null>;
}

/** Cuts → "Redraw sheet": approver only, logged, then the worker. Pictures drawn after it use the new sheet. */
export async function requestObjectSheetRedraw(db: Db, token: BureauToken, effects: ObjectSheetEffects, input: { episodeId: string; tag: string; note?: string | null }) {
  requireApprover(token, 'redraw an object sheet');
  const { data: e } = await db.from('episodes').select('id, channel_id, brief_id, status').eq('id', input.episodeId).maybeSingle();
  if (!e || e.channel_id !== token.channelId) throw new Error('No such episode on this channel.');
  const { data: b } = await db.from('briefs').select('hero_objects').eq('id', e.brief_id).single();
  const o = heroObjectsOf((b as { hero_objects?: unknown } | null)?.hero_objects).find((x) => x.tag === input.tag);
  if (!o) throw new Error(`This episode has no hero object @${input.tag}.`);
  if (!effects.startObjectSheet) throw new Error('This deployment cannot start a sheet (no Trigger.dev secret key).');
  const note = input.note?.trim() ? input.note.trim().replace(/\s+/g, ' ').slice(0, 200) : null;
  const { randomUUID } = await import('node:crypto');
  const requestId = randomUUID();
  await db.from('authorship_log').insert({
    channel_id: token.channelId,
    actor_scope: token.scope,
    token_id: token.id,
    profile_id: token.profileId,
    action: 'object_sheet_redraw',
    subject_type: 'episode',
    subject_id: e.id,
    exact_text: note,
    payload: { request_id: requestId, object: o.tag, prompt_ref: OBJECT_SHEET_PROMPT_REF } as Json,
  });
  const runId = await effects.startObjectSheet({ episodeId: e.id, tag: o.tag, note, requestId });
  return { ok: true as const, requestId, runId, name: o.name };
}

/** The worker's body for a redraw: the next attempt for that object, locked when it succeeds. */
export async function redrawObjectSheet(db: Db, input: { episodeId: string; tag: string; note: string | null }, deps: SheetDeps): Promise<SheetResult> {
  const { data: e } = await db.from('episodes').select('id, channel_id, brief_id').eq('id', input.episodeId).single();
  if (!e) return { ok: false, reason: 'no such episode', spent: false };
  const { data: b } = await db.from('briefs').select('hero_objects').eq('id', e.brief_id).single();
  const o = heroObjectsOf((b as { hero_objects?: unknown } | null)?.hero_objects).find((x) => x.tag === input.tag);
  if (!o) return { ok: false, reason: `no hero object @${input.tag}`, spent: false };
  const cb = await getBible(db, e.channel_id);
  return generateObjectSheet(db, { episodeId: e.id, channelId: e.channel_id, object: o, note: input.note, look: engineeredLook(cb.bible.world) }, deps);
}
