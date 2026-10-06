'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { checkEmail } from '@/lib/auth/allowed';
import { routeClient } from '@/lib/auth/supabase';
import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import { serverClient } from '@/lib/db/server';
import { fetchClientDocument } from '@/lib/oauth/clients';
import { originFromHeaders, type McpDoor } from '@/lib/oauth/policy';
import { authorizeParamsFrom, checkAuthorize, decideConsent } from '@/lib/oauth/flow';

/**
 * The Approve / Deny buttons on the consent screen.
 *
 * Re-checks everything the page checked. A Server Action is an HTTP endpoint anyone can
 * POST to, and the hidden fields are the client's own request coming round a second time —
 * so identity is read from the session again, the person must be on ALLOWED_EMAIL again,
 * and the authorize request is validated again before a code exists.
 *
 * One action per door, with the door fixed in code rather than read from a hidden field —
 * the door decides what may be granted, so it must not be something the form says.
 */
async function originOf(): Promise<string> {
  const h = await headers();
  return originFromHeaders((n) => h.get(n));
}

async function decide(door: McpDoor, formData: FormData): Promise<void> {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !checkEmail(user.email).ok) {
    throw new Error('Only the Kiln owner, signed in, can approve a connection.');
  }

  const origin = await originOf();
  const db = serverClient();
  const params = authorizeParamsFrom((n) => {
    const v = formData.get(n);
    return typeof v === 'string' ? v : null;
  });
  const check = await checkAuthorize(db, params, origin, fetchClientDocument, door);
  if (!check.ok) {
    if (check.redirectTo) redirect(check.redirectTo);
    throw new Error(check.error.description);
  }

  const url = await decideConsent(db, {
    request: check.request,
    approve: formData.get('decision') === 'approve',
    scope: String(formData.get('grant_scope') ?? ''),
    profileId: user.id,
    channelId: BUREAU_CHANNEL_ID,
    origin,
  });
  redirect(url);
}

export async function decideOwnerAction(formData: FormData): Promise<void> {
  return decide('owner', formData);
}

export async function decideAgentAction(formData: FormData): Promise<void> {
  return decide('agent', formData);
}
