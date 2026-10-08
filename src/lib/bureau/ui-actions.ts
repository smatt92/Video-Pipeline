'use server';

import { revalidatePath } from 'next/cache';

import { markAllRead } from '../notifications/centre';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { youtubeVideoId } from '../publish/yt-analytics';
import { acceptFormatFallback, approveBrief, decideCut, markScheduled, rejectBrief, restartHaltedEpisode, setKillSwitch, startQueuedEpisode } from './control';
import { lockVoice } from '../channels/bible-admin';
import { productionEffects, productionObjectSheetEffects, productionSheetEffects } from './effects';
import { applyRecutNotes } from './recut';
import { MotionLevelSchema, VisualFormatSchema, VoicePaceSchema } from './formats';
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

/**
 * The channel an action acts for is read from the row it acts on — the brief, the episode, the
 * publication — never from the sidebar's active channel, so a decision cannot be re-targeted
 * by switching channels in another tab. The two actions with no row (kill switch, CSV import)
 * take the channel id the page rendered for, checked to exist.
 */
type Subject = { table: 'briefs' | 'episodes' | 'publications'; id: string } | { channelId: string };

async function channelOf(subject: Subject): Promise<string> {
  const db = serverClient();
  if ('channelId' in subject) {
    const { data } = await db.from('channels').select('id').eq('id', subject.channelId).maybeSingle();
    if (!data) throw new Error('No such channel.');
    return data.id;
  }
  const { data } = await db.from(subject.table).select('channel_id').eq('id', subject.id).maybeSingle();
  if (!data) throw new Error(`No such ${subject.table.replace(/s$/, '')}.`);
  return data.channel_id;
}

async function webToken(channelId: string): Promise<BureauToken | { error: string }> {
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
    .eq('channel_id', channelId)
    .eq('name', name)
    .is('revoked_at', null)
    .maybeSingle();
  if (existing) return { id: existing.id, name, scope: 'approver', channelId: existing.channel_id, profileId: existing.profile_id };
  // One web token per (person, channel): the database's decision functions check the token's
  // channel against the row's, so a token for one channel can never decide on another.
  const minted = await mintBureauToken(db, { name, scope: 'approver', channelId, profileId: user.id });
  return { id: minted.id, name, scope: 'approver', channelId, profileId: user.id };
}

async function run(path: string, subject: Subject, f: (t: BureauToken) => Promise<string>): Promise<ActionResult> {
  try {
    const t = await webToken(await channelOf(subject));
    if ('error' in t) return { ok: false, message: t.error };
    const message = await f(t);
    revalidatePath(path);
    // And the shell: the rail's and the tab bar's badges are read in the root layout, which a
    // soft navigation never re-renders — without this an approved cut left "Cuts 1" on the
    // rail until a full reload.
    revalidatePath('/', 'layout');
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function approveBriefAction(briefId: string, punchline: string, premise?: string, visualFormat?: string, voicePace?: string, motionLevel?: string): Promise<ActionResult> {
  return run('/bureau/approvals', { table: 'briefs', id: briefId }, async (t) => {
    const db = serverClient();
    // Format and pace travel in the approval's edits (formats.ts): stored and logged with the decision.
    const format = visualFormat === undefined ? undefined : VisualFormatSchema.parse(visualFormat);
    const pace = voicePace === undefined ? undefined : VoicePaceSchema.parse(voicePace);
    // The 3D explainer's motion (formats.ts, 0052): stored beside the pace, only with that format.
    const motion = motionLevel === undefined || format !== 'engineered' ? undefined : MotionLevelSchema.parse(motionLevel);
    const r = await approveBrief(db, t, productionEffects(db), { brief_id: briefId, punchline, edits: { ...(premise ? { premise } : {}), ...(format ? { visual_format: format } : {}), ...(pace ? { voice_pace: pace } : {}), ...(motion ? { motion } : {}) } });
    return r.start_error ? `Approved; the run did not start: ${r.start_error}` : `Approved with "${r.punchline}". Episode started.`;
  });
}

/**
 * Re-cut a sent-back episode with the approver's notes: a pace, new voices for some speakers.
 * Voices are locked on the channel (every later episode uses them — the Voices screen shows
 * it); the pace belongs to this episode. Then the run restarts as a re-cut.
 */
export async function recutAction(episodeId: string, notes: { pace?: string; voices?: Record<string, string> }): Promise<ActionResult> {
  return run('/bureau/cuts', { table: 'episodes', id: episodeId }, async (t) => {
    const db = serverClient();
    const changed: string[] = [];
    for (const [slug, presetId] of Object.entries(notes.voices ?? {})) {
      const r = await lockVoice(db, { scope: t.scope === 'approver' ? 'approver' : 'agent', profileId: t.profileId, via: 'ui:recut' }, t.channelId, { characterSlug: slug, presetId: presetId as never });
      if (!r.ok) throw new Error(`Voice for ${slug} not changed: ${r.refused}`);
      changed.push(`${slug} → ${presetId}`);
    }
    const applied = await applyRecutNotes(db, { channelId: t.channelId, tokenId: t.id, profileId: t.profileId }, episodeId, { pace: notes.pace, voicesChanged: changed });
    if (!applied.ok) throw new Error(applied.reason);
    const r = await restartHaltedEpisode(db, t, productionEffects(db), { episode_id: episodeId });
    if (!r.ok) throw new Error(`Notes saved, but the run did not restart: ${r.start_error}`);
    return `Re-cutting with ${applied.summary.length ? applied.summary.join(', ') : 'new pictures'}. It returns to Cuts when ready.`;
  });
}

export async function startRunAction(episodeId: string): Promise<ActionResult> {
  return run('/bureau/board', { table: 'episodes', id: episodeId }, async (t) => {
    const db = serverClient();
    const r = await startQueuedEpisode(db, t, productionEffects(db), { episode_id: episodeId });
    if (!r.ok) throw new Error(`The run did not start: ${r.start_error}`);
    return 'Run started.';
  });
}

export async function acceptFallbackAction(episodeId: string): Promise<ActionResult> {
  return run('/notifications', { table: 'episodes', id: episodeId }, async (t) => {
    const db = serverClient();
    const r = await acceptFormatFallback(db, t, productionEffects(db), { episode_id: episodeId });
    if (!r.ok) throw new Error(`Accepted, but the run did not restart: ${r.start_error}`);
    revalidatePath('/bureau/approvals');
    return 'Running as illustrated. It returns to Cuts when ready.';
  });
}

/** The notification centre was looked at: every unread alert of the channel becomes read (0053). */
export async function markNotificationsReadAction(channelId: string): Promise<ActionResult> {
  return run('/notifications', { channelId }, async () => {
    const r = await markAllRead(serverClient(), channelId);
    if (!r.ok) throw new Error(`Not marked read: ${r.detail}`);
    return 'Marked read.';
  });
}

export async function restartRunAction(episodeId: string): Promise<ActionResult> {
  return run('/bureau/board', { table: 'episodes', id: episodeId }, async (t) => {
    const db = serverClient();
    const r = await restartHaltedEpisode(db, t, productionEffects(db), { episode_id: episodeId });
    if (!r.ok) throw new Error(`The run did not restart: ${r.start_error}`);
    return 'Run restarted.';
  });
}

export async function rejectBriefAction(briefId: string, reason: string): Promise<ActionResult> {
  return run('/bureau/approvals', { table: 'briefs', id: briefId }, async (t) => {
    await rejectBrief(serverClient(), t, { brief_id: briefId, reason });
    return 'Rejected. The slot is open again.';
  });
}

export async function cutAction(episodeId: string, approve: boolean, note: string): Promise<ActionResult> {
  return run('/bureau/cuts', { table: 'episodes', id: episodeId }, async (t) => {
    const db = serverClient();
    const r = await decideCut(db, t, productionEffects(db), { episode_id: episodeId, approve, note });
    return approve ? `Cut approved${r.run_woken ? '; the bundle is being built' : ''}.` : 'Cut sent back.';
  });
}

export async function regenerateAction(episodeId: string, shotIdx: number, note: string): Promise<ActionResult> {
  return run('/bureau/cuts', { table: 'episodes', id: episodeId }, async (t) => {
    const r = await regenerateShot(serverClient(), t, { episode_id: episodeId, shot: shotIdx, note });
    return `Shot ${r.shot_idx} queued for re-roll ${r.reroll_index} of ${r.rerolls_max}. Reject the cut to rebuild it.`;
  });
}

/** Cuts → Redraw under one picture: approver only, logged, starts 25-redraw (redraw.ts). */
export async function redrawAction(episodeId: string, shotIdx: number, part: number | null, note: string): Promise<ActionResult> {
  return run('/bureau/cuts', { table: 'episodes', id: episodeId }, async (t) => {
    const db = serverClient();
    const { requestRedraw } = await import('./redraw');
    const r = await requestRedraw(db, t, productionEffects(db), { episode_id: episodeId, shot: shotIdx, part: part ?? undefined, note });
    return `Redrawing shot ${r.shot_idx}, ${r.parts.length === 1 ? `picture ${r.parts[0] + 1}` : `${r.parts.length} pictures`}. The cut can be decided once the new one is in.`;
  });
}

export async function markScheduledAction(publicationId: string, at: string, videoUrl: string): Promise<ActionResult> {
  return run('/bureau/ready', { table: 'publications', id: publicationId }, async (t) => {
    const videoId = videoUrl ? youtubeVideoId(videoUrl) : null;
    if (videoUrl && !videoId) throw new Error('That link has no YouTube video id in it.');
    await markScheduled(serverClient(), t, { publication_id: publicationId, at: new Date(at).toISOString(), videoId, videoUrl: videoUrl || null });
    return 'Marked scheduled.';
  });
}

export async function killSwitchAction(channelId: string, on: boolean, reason: string): Promise<ActionResult> {
  return run('/bureau/monitor', { channelId }, async (t) => {
    const db = serverClient();
    await setKillSwitch(db, t, productionEffects(db), { on, reason });
    return on ? 'Kill switch ON: no new generation, no publishing.' : 'Kill switch off.';
  });
}

export async function queueDubsAction(episodeId: string, languages: DubLanguage[]): Promise<ActionResult> {
  return run('/bureau/ready', { table: 'episodes', id: episodeId }, async (t) => {
    const r = await queueDubs(serverClient(), t, { episode_id: episodeId, languages });
    return `Queued ${r.queued.length} dub(s).`;
  });
}

export async function importCsvAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  return run('/bureau/metrics', { channelId: String(form.get('channel_id') ?? '') }, async (t) => {
    const file = form.get('csv');
    const text = typeof file === 'string' ? file : file instanceof File ? await file.text() : '';
    const r = await importStudioCsv(serverClient(), t.channelId, text);
    return `${r.updated + r.inserted} row(s) imported; ${r.unmatched.length} not ours${r.problems.length ? `; ${r.problems.join('; ')}` : ''}.`;
  });
}

/** Ready to schedule: build the Instagram variant for a YouTube bundle that predates it. */
export async function buildInstagramDraftAction(youtubePublicationId: string): Promise<ActionResult> {
  return run('/bureau/ready', { table: 'publications', id: youtubePublicationId }, async () => {
    const { buildInstagramDraft } = await import('./instagram-draft');
    const r = await buildInstagramDraft(serverClient(), youtubePublicationId);
    if (!r.ok) throw new Error(r.refused);
    return r.created ? 'Instagram variant built. The cover is a frame time here; the worker extracts a still only for new bundles.' : 'The Instagram variant already exists.';
  });
}

/** Ready to schedule: a Reel posted by hand, recorded with its permalink so metrics can find it. */
export async function markPostedAction(publicationId: string, permalink: string, postedAt: string): Promise<ActionResult> {
  return run('/bureau/ready', { table: 'publications', id: publicationId }, async (t) => {
    const { markInstagramPosted } = await import('./instagram-draft');
    const r = await markInstagramPosted(serverClient(), t, { publication_id: publicationId, permalink, posted_at: new Date(postedAt).toISOString() });
    return `Marked posted (${r.shortcode}).`;
  });
}

/** Ready → "Publish to Instagram now" / "at the slot" (decision 0023): approver only, gated in the database. */
export async function publishInstagramAction(publicationId: string, when: 'now' | 'slot'): Promise<ActionResult> {
  return run('/bureau/ready', { table: 'publications', id: publicationId }, async (t) => {
    const db = serverClient();
    const { requestInstagramPublish } = await import('./instagram-draft');
    const r = await requestInstagramPublish(db, t, productionEffects(db), { publication_id: publicationId, when });
    return when === 'now' ? 'Posting to Instagram now — the permalink appears here when Meta has published it (a few minutes).' : `Scheduled for ${new Date(r.at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST; posted automatically at the slot.`;
  });
}

/**
 * Library → Characters → "Generate sheet" (character-sheets.ts): approver only, logged, starts
 * 27-character-sheet. Spends one image (the one-time sheet price shown on the screen).
 */
export async function requestSheetAction(channelId: string, slug: string, note: string): Promise<ActionResult> {
  return run('/library/characters', { channelId }, async (t) => {
    const { requestCharacterSheet } = await import('./character-sheets');
    const r = await requestCharacterSheet(serverClient(), t, productionSheetEffects(), { slug, note });
    return `Drawing a sheet for ${r.name}. It appears here in about a minute — look at it before you lock it.`;
  });
}

/**
 * Cuts → a hero object's "Redraw sheet" (3D explainer, 0052): approver only, logged, starts
 * 28-object-sheet. Spends one image. Pictures drawn after it use the new sheet; Redraw a picture
 * to bring one up to date.
 */
export async function redrawObjectSheetAction(episodeId: string, tag: string, note: string): Promise<ActionResult> {
  return run('/bureau/cuts', { table: 'episodes', id: episodeId }, async (t) => {
    const { requestObjectSheetRedraw } = await import('./object-sheets');
    const r = await requestObjectSheetRedraw(serverClient(), t, productionObjectSheetEffects(), { episodeId, tag, note });
    return `Drawing a new sheet for ${r.name}. It appears here in about a minute; pictures drawn after it use it.`;
  });
}

/** Library → Characters → "Lock": this sheet becomes the character's reference frame. */
export async function lockSheetAction(channelId: string, slug: string, generationId: string): Promise<ActionResult> {
  return run('/library/characters', { channelId }, async (t) => {
    const { lockCharacterSheet } = await import('./character-sheets');
    const r = await lockCharacterSheet(serverClient(), t, { slug, generationId });
    return r.message;
  });
}

/** Library → Characters → "Figure": who the character is, said in every sheet and picture prompt. */
export async function setFigureAction(channelId: string, slug: string, figure: string): Promise<ActionResult> {
  return run('/library/characters', { channelId }, async (t) => {
    const { setCharacterFigure } = await import('../channels/bible-admin');
    const r = await setCharacterFigure(serverClient(), { scope: t.scope === 'approver' ? 'approver' : 'agent', profileId: t.profileId, via: 'ui:characters' }, t.channelId, slug, figure);
    if (!r.ok) throw new Error(r.refused);
    return r.message;
  });
}
