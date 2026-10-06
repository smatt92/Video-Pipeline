'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { youtubeVideoId } from '../publish/yt-analytics';
import { BUREAU_CHANNEL_ID } from './bible';
import { approveBrief, decideCut, markScheduled, rejectBrief, setKillSwitch } from './control';
import { productionEffects } from './effects';
import { queueDubs, regenerateShot, type DubLanguage } from './episodes';
import { importStudioCsv } from './studio-csv';
import { mintBureauToken, type BureauToken } from './tokens';

/**
 * The control room's decisions. Every one goes through the SAME functions the MCP tools call
 * (control.ts → the 0040 decision functions), so a decision made on the phone page and one
 * made in Claude chat are the same row shapes, the same scope checks and the same
 * authorship_log entries.
 *
 * The web session acts through an approver token minted for the signed-in person and named
 * "Control room (web)". Its plaintext is discarded at mint — only its id is ever used, here,
 * server-side — so it can never be pasted anywhere; it exists so authorship_log can say
 * "this was decided on the web" as precisely as it says "this was decided in Claude".
 */

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

async function webToken(): Promise<BureauToken | { error: string }> {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Not signed in.' };
  if (!checkEmail(user.email).ok) return { error: 'Not permitted.' };
  const db = serverClient();
  const name = 'Control room (web)';
  const { data: existing } = await db
    .from('mcp_tokens')
    .select('id, name, scope, channel_id, profile_id, revoked_at')
    .eq('profile_id', user.id)
    .eq('name', name)
    .is('revoked_at', null)
    .maybeSingle();
  if (existing) return { id: existing.id, name, scope: 'approver', channelId: existing.channel_id, profileId: existing.profile_id };
  const minted = await mintBureauToken(db, { name, scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId: user.id });
  return { id: minted.id, name, scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId: user.id };
}

async function run(path: string, f: (t: BureauToken) => Promise<string>): Promise<ActionResult> {
  try {
    const t = await webToken();
    if ('error' in t) return { ok: false, message: t.error };
    const message = await f(t);
    revalidatePath(path);
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function approveBriefAction(briefId: string, punchline: string, premise?: string): Promise<ActionResult> {
  return run('/bureau/approvals', async (t) => {
    const db = serverClient();
    const r = await approveBrief(db, t, productionEffects(db), { brief_id: briefId, punchline, edits: premise ? { premise } : {} });
    return r.start_error ? `Approved; the run did not start: ${r.start_error}` : `Approved with "${r.punchline}". Episode started.`;
  });
}

export async function rejectBriefAction(briefId: string, reason: string): Promise<ActionResult> {
  return run('/bureau/approvals', async (t) => {
    await rejectBrief(serverClient(), t, { brief_id: briefId, reason });
    return 'Rejected. The slot is open again.';
  });
}

export async function cutAction(episodeId: string, approve: boolean, note: string): Promise<ActionResult> {
  return run('/bureau/cuts', async (t) => {
    const db = serverClient();
    const r = await decideCut(db, t, productionEffects(db), { episode_id: episodeId, approve, note });
    return approve ? `Cut approved${r.run_woken ? '; the bundle is being built' : ''}.` : 'Cut sent back.';
  });
}

export async function regenerateAction(episodeId: string, shotIdx: number, note: string): Promise<ActionResult> {
  return run('/bureau/cuts', async (t) => {
    const r = await regenerateShot(serverClient(), t, { episode_id: episodeId, shot: shotIdx, note });
    return `Shot ${r.shot_idx} queued for re-roll ${r.reroll_index} of ${r.rerolls_max}. Reject the cut to rebuild it.`;
  });
}

export async function markScheduledAction(publicationId: string, at: string, videoUrl: string): Promise<ActionResult> {
  return run('/bureau/ready', async (t) => {
    const videoId = videoUrl ? youtubeVideoId(videoUrl) : null;
    if (videoUrl && !videoId) throw new Error('That link has no YouTube video id in it.');
    await markScheduled(serverClient(), t, { publication_id: publicationId, at: new Date(at).toISOString(), videoId, videoUrl: videoUrl || null });
    return 'Marked scheduled.';
  });
}

export async function killSwitchAction(on: boolean, reason: string): Promise<ActionResult> {
  return run('/bureau/monitor', async (t) => {
    const db = serverClient();
    await setKillSwitch(db, t, productionEffects(db), { on, reason });
    return on ? 'Kill switch ON: no new generation, no publishing.' : 'Kill switch off.';
  });
}

export async function queueDubsAction(episodeId: string, languages: DubLanguage[]): Promise<ActionResult> {
  return run('/bureau/ready', async (t) => {
    const r = await queueDubs(serverClient(), t, { episode_id: episodeId, languages });
    return `Queued ${r.queued.length} dub(s).`;
  });
}

export async function importCsvAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('/bureau/metrics', async () => {
    const file = form.get('csv');
    const text = typeof file === 'string' ? file : file instanceof File ? await file.text() : '';
    const r = await importStudioCsv(serverClient(), BUREAU_CHANNEL_ID, text);
    return `${r.updated + r.inserted} row(s) imported; ${r.unmatched.length} not ours${r.problems.length ? `; ${r.problems.join('; ')}` : ''}.`;
  });
}
