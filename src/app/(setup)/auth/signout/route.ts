import { NextResponse, type NextRequest } from 'next/server';
import { routeHandlerClient } from '@/lib/auth/supabase';

const SESSION_COOKIE = /^sb-.*-auth-token(\.\d+)?$/;

/**
 * Sign out — the rail's user row posts here (Sahil, 07-Oct: "no logout button").
 *
 * POST only, so a prefetch or a pasted link cannot end a session. Same belt and braces as the
 * refusal in /auth/callback: `signOut()` revokes the session server-side and writes expired
 * cookies, and the sweep expires every session cookie directly on this response — signOut needs
 * the network, the sweep does not. 303 so the browser follows with a GET to /login.
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/login', request.nextUrl.origin), 303);
  const supabase = routeHandlerClient(request, response);
  await supabase.auth.signOut().catch(() => undefined);
  for (const cookie of request.cookies.getAll()) {
    if (SESSION_COOKIE.test(cookie.name)) response.cookies.set(cookie.name, '', { path: '/', maxAge: 0 });
  }
  return response;
}
