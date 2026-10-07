'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import {
  requestOrphanPurge,
  unstickEpisode,
  updateSeriesDefaults,
  updateSlot,
  updateStillStyle,
  updateTuning,
  type AdminResult,
  type SettingsActor,
} from './admin';
import { findOrphans, type OrphanReport } from './orphans';
import type { Tuning } from './tuning';

/**
 * Server Actions for Settings → Generation, Assembly, Publishing and Danger zone. Each turns
 * the signed-in session into an actor and calls the lib function, which decides everything
 * (and which `verify:settings` drives directly). Never throws to the client.
 */

async function approver(): Promise<{ denied: string; actor: null } | { denied: null; actor: SettingsActor }> {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { denied: 'Not signed in.', actor: null };
  if (!checkEmail(user.email).ok) return { denied: 'Not permitted.', actor: null };
  return { denied: null, actor: { scope: 'approver', profileId: user.id, via: 'ui' } };
}

async function asApprover<T>(f: (actor: SettingsActor) => Promise<AdminResult<T>>, path: string): Promise<AdminResult<T>> {
  try {
    const a = await approver();
    if (a.denied !== null) return { ok: false, refused: a.denied };
    const r = await f(a.actor);
    if (r.ok) revalidatePath(path);
    return r;
  } catch (err) {
    return { ok: false, refused: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateTuningAction(channelId: string, patch: Partial<Tuning>, path: string) {
  return asApprover((actor) => updateTuning(serverClient(), actor, channelId, patch), path);
}

export async function updateSlotAction(channelId: string, input: { slotTime: string; timezone: string }) {
  return asApprover((actor) => updateSlot(serverClient(), actor, channelId, input), '/settings/publishing');
}

export async function updateSeriesDefaultsAction(channelId: string, seriesId: string, input: { visual_format?: string; voice_pace?: string }) {
  return asApprover((actor) => updateSeriesDefaults(serverClient(), actor, channelId, seriesId, input as never), '/settings/generation');
}

export async function updateStillStyleAction(channelId: string, style: string) {
  return asApprover((actor) => updateStillStyle(serverClient(), actor, channelId, style), '/settings/generation');
}

export async function unstickEpisodeAction(channelId: string, input: { episodeId: string; reason: string; confirm: string }) {
  return asApprover((actor) => unstickEpisode(serverClient(), actor, channelId, input), '/settings/danger');
}

/** Dry run: the orphan list. Read-only, approver only — it lists storage keys. */
export async function findOrphansAction(): Promise<{ ok: true; report: OrphanReport } | { ok: false; refused: string }> {
  try {
    const a = await approver();
    if (a.denied !== null) return { ok: false, refused: a.denied };
    return { ok: true, report: await findOrphans(serverClient()) };
  } catch (err) {
    return { ok: false, refused: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete: the request is checked and recorded here; the bytes are deleted by the worker. */
export async function requestOrphanPurgeAction(channelId: string, input: { confirm: string; count: number; assetIds: string[] }): Promise<AdminResult<{ runId: string | null }>> {
  return asApprover(async (actor) => {
    const r = await requestOrphanPurge(serverClient(), actor, channelId, input);
    if (!r.ok) return r;
    try {
      // Dynamic, like every enqueue here: a static import pulls the SDK into the route bundle.
      const { purgeOrphansTask } = await import('@/trigger/99-purge-orphans');
      const handle = await purgeOrphansTask.trigger({ channelId, assetIds: r.assetIds, profileId: actor.profileId });
      return { ok: true, message: `${r.message} Worker run ${handle.id}; the result is in Authorship as “orphans_purged”.`, runId: handle.id };
    } catch (err) {
      return { ok: false, refused: `Recorded, but the worker could not be reached: ${err instanceof Error ? err.message : String(err)}. Nothing was deleted.` };
    }
  }, '/settings/danger');
}
