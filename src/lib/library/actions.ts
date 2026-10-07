'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { bibleOrNull, requireChannel } from '../channels/active';
import { serverClient } from '../db/server';
import { storage } from '../storage';
import { confirmBedUpload, planBedUpload, setSeriesDefault } from './music';
import { clearVoiceOverride, setVoiceOverride } from './voices';

/**
 * Library writes for the Voices and Music screens. Every one is an HTTP endpoint, so every one
 * re-checks the session and the allow-list, and acts on the channel active in this browser —
 * never on a channel id sent by the form. The decisions live in voices.ts and music.ts, where a
 * harness can reach them; this file resolves who and which channel, and hands down.
 */

export interface LibraryWriteState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
}

async function signedIn() {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, message: 'Not signed in.' };
  if (!checkEmail(user.email).ok) return { ok: false as const, message: 'Not permitted.' };
  return { ok: true as const, user };
}

async function channelWithBible() {
  const channel = await requireChannel();
  const cb = bibleOrNull(channel);
  if (!cb) return { ok: false as const, message: `${channel.name} has no bible folder in this build, so it has no cast or series.` };
  return { ok: true as const, channel, cb };
}

const fail = (message: string): LibraryWriteState => ({ status: 'error', message });

// ── Voices ───────────────────────────────────────────────────────────────────

export async function setVoiceOverrideAction(_prev: LibraryWriteState, form: FormData): Promise<LibraryWriteState> {
  try {
    const who = await signedIn();
    if (!who.ok) return fail(who.message);
    const ch = await channelWithBible();
    if (!ch.ok) return fail(ch.message);
    // The preset select and the free-text id are two inputs for one value; the free text wins
    // when filled, because it is the only way to name a voice the preset list does not hold.
    const voiceId = String(form.get('voice_id') ?? '').trim() || String(form.get('preset_id') ?? '').trim();
    const result = await setVoiceOverride(serverClient(), {
      channelId: ch.channel.id,
      cb: ch.cb,
      setBy: who.user.id,
      input: {
        slug: String(form.get('slug') ?? ''),
        provider: String(form.get('provider') ?? ''),
        voiceId,
        note: String(form.get('note') ?? '') || undefined,
      },
    });
    if (!result.ok) return fail(result.problem);
    revalidatePath('/library/voices');
    return { status: 'ok', message: result.message };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function clearVoiceOverrideAction(slug: string, _prev: LibraryWriteState): Promise<LibraryWriteState> {
  try {
    const who = await signedIn();
    if (!who.ok) return fail(who.message);
    const ch = await channelWithBible();
    if (!ch.ok) return fail(ch.message);
    const result = await clearVoiceOverride(serverClient(), { channelId: ch.channel.id, cb: ch.cb, slug });
    if (!result.ok) return fail(result.problem);
    revalidatePath('/library/voices');
    return { status: 'ok', message: result.message };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ── Music ────────────────────────────────────────────────────────────────────

export type PlanUploadResult = { ok: true; url: string; key: string } | { ok: false; message: string };

/**
 * Step 1 of 3: validate, build the key server-side, presign a PUT with the type and length
 * signed in. Returns a URL and the key; the bytes go browser → bucket and never through here.
 */
export async function planBedUploadAction(input: { bedId: string; contentType: string; bytes: number }): Promise<PlanUploadResult> {
  try {
    const who = await signedIn();
    if (!who.ok) return { ok: false, message: who.message };
    const ch = await channelWithBible();
    if (!ch.ok) return { ok: false, message: ch.message };
    const plan = planBedUpload({ channelId: ch.channel.id, cb: ch.cb, input });
    if (!plan.ok) return { ok: false, message: plan.problem };
    const signed = await storage().presignPut({
      key: plan.key,
      contentType: plan.upload.contentType,
      contentLength: plan.upload.bytes,
      expiresIn: 15 * 60,
    });
    return { ok: true, url: signed.url, key: signed.key };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Step 3 of 3, after the browser's PUT returned 2xx: record the row. Re-validates; rebuilds the key. */
export async function confirmBedUploadAction(input: { bedId: string; contentType: string; bytes: number }): Promise<LibraryWriteState> {
  try {
    const who = await signedIn();
    if (!who.ok) return fail(who.message);
    const ch = await channelWithBible();
    if (!ch.ok) return fail(ch.message);
    const result = await confirmBedUpload(serverClient(), { channelId: ch.channel.id, cb: ch.cb, input });
    if (!result.ok) return fail(result.problem);
    revalidatePath('/library/music');
    return { status: 'ok', message: result.message };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function setSeriesDefaultAction(_prev: LibraryWriteState, form: FormData): Promise<LibraryWriteState> {
  try {
    const who = await signedIn();
    if (!who.ok) return fail(who.message);
    const ch = await channelWithBible();
    if (!ch.ok) return fail(ch.message);
    const result = await setSeriesDefault(serverClient(), {
      channelId: ch.channel.id,
      cb: ch.cb,
      series: String(form.get('series') ?? ''),
      bedId: String(form.get('bed_id') ?? ''),
    });
    if (!result.ok) return fail(result.problem);
    revalidatePath('/library/music');
    return { status: 'ok', message: result.message };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
