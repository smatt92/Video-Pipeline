'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import {
  createChannel,
  lockVoice,
  updatePolicy,
  updateSeries,
  updateTrendSources,
  upsertCharacter,
  type AdminResult,
  type BibleActor,
  type CapsSchema,
  type CharacterInput,
  type CreateChannelInput,
} from './bible-admin';
import { setPublishTarget } from './add';
import type { z } from 'zod';
import { ACTIVE_CHANNEL_COOKIE, listChannels } from './list';

async function signedIn(): Promise<string | null> {
  return (await approver()).denied;
}

/**
 * The signed-in person as the approver (ALLOWED_EMAIL is the approver on this workspace), or
 * why not. Every bible write below goes through this; the lib functions refuse any other scope.
 */
async function approver(): Promise<{ denied: string; actor: null } | { denied: null; actor: BibleActor }> {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { denied: 'Not signed in.', actor: null };
  if (!checkEmail(user.email).ok) return { denied: 'Not permitted.', actor: null };
  return { denied: null, actor: { scope: 'approver', profileId: user.id, via: 'ui' } };
}

/** Run one bible write as the signed-in approver; never throws to the client. */
async function asApprover<T>(f: (actor: BibleActor) => Promise<AdminResult<T>>, revalidate: string[] = ['/', 'layout']): Promise<AdminResult<T>> {
  try {
    const a = await approver();
    if (a.denied !== null) return { ok: false, refused: a.denied };
    const r = await f(a.actor);
    if (r.ok) revalidatePath(revalidate[0], revalidate[1] === 'layout' ? 'layout' : undefined);
    return r;
  } catch (err) {
    return { ok: false, refused: err instanceof Error ? err.message : String(err) };
  }
}

const YEAR_S = 60 * 60 * 24 * 365;

async function setCookie(channelId: string) {
  const store = await cookies();
  store.set(ACTIVE_CHANNEL_COOKIE, channelId, { path: '/', maxAge: YEAR_S, sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production' });
}

/** Switch the active channel for this browser. Refuses an id that is not an active channel. */
export async function setActiveChannelAction(channelId: string): Promise<{ ok: boolean; message?: string }> {
  const denied = await signedIn();
  if (denied) return { ok: false, message: denied };
  const all = await listChannels(serverClient());
  if (!all.some((c) => c.id === channelId)) return { ok: false, message: 'No such active channel.' };
  await setCookie(channelId);
  revalidatePath('/', 'layout');
  return { ok: true };
}

export type AddChannelState = { status: 'idle' } | { status: 'ok'; message: string } | { status: 'error'; message: string };

// ═════════════════════════════════════════════════════════════════════════════
// The channel-bible actions (0022). Typed, object in → AdminResult out, approver only.
// The per-channel setup flow (Basics → Cast → Schedule → Caps) is built on these.
// ═════════════════════════════════════════════════════════════════════════════

/** Basics: create a channel from a template bible, and switch this browser to it. */
export async function createChannelAction(input: CreateChannelInput) {
  return asApprover(async (actor) => {
    const r = await createChannel(serverClient(), actor, input);
    if (r.ok) await setCookie(r.channelId);
    return r;
  });
}

/** Cast: add or edit one character (not its voice — lockVoiceAction — nor its frames). */
export async function upsertCharacterAction(channelId: string, input: CharacterInput) {
  return asApprover((actor) => upsertCharacter(serverClient(), actor, channelId, input));
}

/** Cast: lock a character's voice to a preset; the next voice run uses it, no deploy. */
export async function lockVoiceAction(channelId: string, characterSlug: string, presetId: string) {
  return asApprover((actor) => lockVoice(serverClient(), actor, channelId, { characterSlug, presetId: presetId as never }));
}

/** Schedule: add or replace one series document. */
export async function updateSeriesAction(channelId: string, series: unknown) {
  return asApprover((actor) => updateSeries(serverClient(), actor, channelId, series));
}

/** Caps: the content policy and/or the money caps and the stills switch. */
export async function updatePolicyAction(channelId: string, input: { policy?: unknown; caps?: z.input<typeof CapsSchema> }) {
  return asApprover((actor) => updatePolicy(serverClient(), actor, channelId, input));
}

/** Trend sources: subreddits and YouTube categories / queries for stage 1. */
export async function updateTrendSourcesAction(channelId: string, trends: unknown) {
  return asApprover((actor) => updateTrendSources(serverClient(), actor, channelId, trends));
}

export async function setPublishTargetAction(_prev: AddChannelState, form: FormData): Promise<AddChannelState> {
  try {
    const denied = await signedIn();
    if (denied) return { status: 'error', message: denied };
    const s = (k: string) => (typeof form.get(k) === 'string' ? String(form.get(k)) : undefined);
    const r = await setPublishTarget(serverClient(), s('channel_id') ?? '', {
      platform: s('platform') === 'instagram' ? 'instagram' : 'youtube',
      enabled: form.get('enabled') === 'on',
      handle: s('handle'),
      external_id: s('external_id'),
    });
    if (!r.ok) return { status: 'error', message: r.refused };
    revalidatePath('/channels');
    return { status: 'ok', message: 'Saved.' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
