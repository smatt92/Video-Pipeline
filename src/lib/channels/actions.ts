'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { addChannel } from './add';
import { ACTIVE_CHANNEL_COOKIE, listChannels } from './list';

async function signedIn(): Promise<string | null> {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 'Not signed in.';
  if (!checkEmail(user.email).ok) return 'Not permitted.';
  return null;
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

export async function addChannelAction(_prev: AddChannelState, form: FormData): Promise<AddChannelState> {
  try {
    const denied = await signedIn();
    if (denied) return { status: 'error', message: denied };
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' ? v : undefined;
    };
    const r = await addChannel(serverClient(), {
      name: str('name') ?? '',
      slug: str('slug') ?? '',
      handle: str('handle'),
      niche: str('niche'),
      youtube_channel_id: str('youtube_channel_id'),
      instagram_account_id: str('instagram_account_id'),
      instagram_handle: str('instagram_handle'),
      targets: form.getAll('targets').filter((v): v is 'youtube' | 'instagram' => v === 'youtube' || v === 'instagram'),
    });
    if (!r.ok) return { status: 'error', message: r.refused };
    await setCookie(r.channelId);
    revalidatePath('/', 'layout');
    return {
      status: 'ok',
      message: `Added and switched to it: ${r.cast} cast member(s) synced, publishing to ${r.targets.join(' + ')}.${r.warnings.length ? ` Warnings: ${r.warnings.join('; ')}.` : ''}`,
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
