import { NextResponse, type NextRequest } from 'next/server';

import { checkEmail } from '@/lib/auth/allowed';
import { routeClient } from '@/lib/auth/supabase';

/**
 * Where the sign-in link lands.
 *
 * Exchanges the one-time code for a session and sets the cookies. Lives in the `(setup)`
 * route group for filing purposes only — route groups do not appear in the URL, so this
 * is `/auth/callback`, which is what the link points at.
 *
 * The allowlist is re-checked here even though `requestSignInLink` already checked it.
 * The two checks guard different things: that one stops a link being *sent*, this one
 * stops a link being *used*. A link is a bearer token sitting in an inbox, and the
 * allowlist can change between the two moments.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/login?denied=${encodeURIComponent(reason)}`);

  if (!code) return fail('no_code');

  const supabase = await routeClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) return fail('exchange_failed');

  if (!checkEmail(data.user?.email).ok) {
    await supabase.auth.signOut();
    return fail('not_allowed');
  }

  return NextResponse.redirect(`${origin}${safeNext}`);
}
