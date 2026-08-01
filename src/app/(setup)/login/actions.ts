'use server';

import { checkEmail, SIGN_IN_REFUSED } from '@/lib/auth/allowed';
import { routeClient } from '@/lib/auth/supabase';

export interface SignInState {
  status: 'idle' | 'sent' | 'refused' | 'error';
  message?: string;
}

/**
 * Request a sign-in link.
 *
 * Magic link rather than a password: the only account is the operator's, and a password
 * here would be one more secret to store badly for no gain in security over an address
 * that already gates the workspace.
 *
 * The allowlist is checked *before* the link is requested, so a stranger's address never
 * reaches Supabase and no account is created for it. That is belt and braces — middleware
 * would refuse the resulting session anyway — but a Supabase project accumulating rows in
 * auth.users for everyone who typed their address into a public preview URL is its own
 * small problem.
 *
 * The refusal message does not say which of "not configured" and "not the permitted
 * address" happened, and does not confirm whether an account exists. Neither fact helps
 * the person who is allowed to sign in.
 */
export async function requestSignInLink(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get('email') ?? '');

  const decision = checkEmail(email);
  if (!decision.ok) {
    return { status: 'refused', message: SIGN_IN_REFUSED };
  }

  const next = String(formData.get('next') ?? '/');
  // Only same-origin paths. A `next` taken from the query string and pasted into a
  // redirect URL is an open redirect, and this one would arrive attached to a sign-in
  // link — the most convincing possible place to put one.
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const origin = process.env.APP_URL;
  if (!origin) {
    return {
      status: 'error',
      message:
        'APP_URL is not set, so there is no address to send you back to. The sign-in ' +
        'link would point at nothing.',
    };
  }

  const supabase = await routeClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: decision.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(safeNext)}`,
      // No self-signup. The one permitted account is created deliberately, once, in the
      // Supabase dashboard — not by whoever first loads the preview URL.
      shouldCreateUser: false,
    },
  });

  if (error) {
    return { status: 'error', message: error.message };
  }

  return { status: 'sent' };
}
