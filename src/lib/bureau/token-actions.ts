'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { BUREAU_CHANNEL_ID } from './bible';
import { mintBureauToken, revokeBureauToken, type BureauScope } from './tokens';

/**
 * Mint and revoke control-plane tokens from Settings → MCP tokens.
 *
 * Signed-in and allow-listed only. An approver token is bound to the signed-in person's
 * profile — that is whose name goes on every review it records. The plaintext is returned
 * exactly once, to this response, and never stored.
 */

export type MintState =
  | { status: 'idle' }
  | { status: 'ok'; plaintext: string; prefix: string; scope: BureauScope }
  | { status: 'error'; message: string };

async function signedIn() {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, message: 'Not signed in.' };
  if (!checkEmail(user.email).ok) return { ok: false as const, message: 'Not permitted.' };
  return { ok: true as const, user };
}

export async function mintTokenAction(_prev: MintState, form: FormData): Promise<MintState> {
  try {
    const who = await signedIn();
    if (!who.ok) return { status: 'error', message: who.message };
    const scope = form.get('scope') === 'approver' ? 'approver' : 'agent';
    const name = String(form.get('name') ?? '').trim();
    if (name.length < 2) return { status: 'error', message: 'Give the token a name you will recognise in the list.' };
    const db = serverClient();
    const { data: profile } = await db.from('profiles').select('id').eq('id', who.user.id).maybeSingle();
    if (scope === 'approver' && !profile) {
      return { status: 'error', message: 'Your profile row does not exist yet — finish onboarding first.' };
    }
    const minted = await mintBureauToken(db, {
      name,
      scope,
      channelId: BUREAU_CHANNEL_ID,
      profileId: scope === 'approver' ? profile!.id : null,
    });
    revalidatePath('/settings/mcp');
    return { status: 'ok', plaintext: minted.plaintext, prefix: minted.prefix, scope };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function revokeTokenAction(id: string): Promise<{ ok: boolean; message?: string }> {
  const who = await signedIn();
  if (!who.ok) return { ok: false, message: who.message };
  await revokeBureauToken(serverClient(), id);
  revalidatePath('/settings/mcp');
  return { ok: true };
}
