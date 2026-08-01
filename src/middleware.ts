import { NextResponse, type NextRequest } from 'next/server';

import { checkEmail } from '@/lib/auth/allowed';
import { middlewareClient } from '@/lib/auth/supabase';
import { isOnboardingComplete } from '@/lib/onboarding/gate';

/**
 * Two gates, in order: who you are, then whether setup is finished.
 *
 * A redirect, not a dismissible banner. The app should be unusable until it is usable — a
 * banner is read once and ignored, and the failure it warns about costs money when it
 * lands in the middle of a pipeline run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Auth — allowlist, not "is authenticated"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Settings holds every vendor credential in the product, and a Supabase project accepts
 * signups from anyone by default. "Has a session" is therefore a gate any stranger can
 * pass by typing their own address. The check is against ALLOWED_EMAIL and it runs on
 * every request, not only at sign-in, so a session minted before the allowlist changed
 * stops working the moment it does.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. Onboarding — reads profiles.onboarding_step
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This replaces the fail-closed placeholder that threw unless ONBOARDING_GATE_BYPASS=1.
 * The bypass is deleted rather than kept as a fallback: a bypass that outlives its reason
 * is a backdoor with a comment on it, and this one would have been the only thing standing
 * in front of a public preview URL with live vendor credentials behind it.
 *
 * It still fails closed, now for a better reason. No profile row, an unreadable database,
 * a query that errors — all of them mean "cannot confirm setup is complete", and all of
 * them route to the wizard rather than to the app. The difference from the placeholder is
 * that a *correct* answer now exists and is reachable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What stays open, and why each one
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   /api/webhooks/*   Vendors call these with no session and must never be redirected. A
 *                     307 to an HTML page is a delivery most vendors will not retry, and
 *                     the generation it was reporting hangs until it times out — after
 *                     the money was spent.
 *   /login, /auth/*   Otherwise signing in requires being signed in.
 *   /onboarding/*     The gate's own destination.
 *   /settings/*       The wizard's steps are settings screens underneath. Locking them
 *                     would deadlock the gate: setup could never complete, so the gate
 *                     could never open.
 *
 * The last two are open past the *onboarding* gate only. Both still require an allowed
 * session — they are where the credentials live.
 */

/** Reachable with no session at all. */
const PUBLIC_PATHS = ['/login', '/auth', '/api/webhooks', '/_next', '/favicon.ico'];

/** Reachable with an allowed session but incomplete setup. */
const SETUP_PATHS = ['/onboarding', '/settings'];

function matches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function redirect(request: NextRequest, pathname: string, params?: Record<string, string>) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = '';
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (matches(pathname, PUBLIC_PATHS)) return NextResponse.next();

  // The response is created up front and handed to the client so that a token refresh
  // during getUser() writes its cookies somewhere that actually gets returned.
  const response = NextResponse.next({ request });
  const supabase = middlewareClient(request, response);

  // getUser(), never getSession(). getSession() reads the cookie and trusts it; getUser()
  // verifies it with the auth server. A gate that trusts a cookie the client controls is
  // not a gate.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirect(request, '/login', { next: pathname });
  }

  const decision = checkEmail(user.email);
  if (!decision.ok) {
    // Sign the session out on the way past. Leaving a refused session alive means the
    // same rejected round trip on every subsequent request, and a cookie that looks
    // valid to anyone debugging it.
    await supabase.auth.signOut();
    return redirect(request, '/login', { denied: decision.reason });
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('onboarding_step, onboarding_completed_at')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    // Cannot answer the question, so refuse — the wizard is the honest destination for
    // "setup state unknown". Logged rather than swallowed: this is the branch that means
    // the database is unreachable, and it should be visible in the platform logs rather
    // than presenting only as an unexplained redirect loop out of the app.
    console.error('[gate] profiles read failed, treating setup as incomplete:', error.message);
    if (matches(pathname, SETUP_PATHS)) return response;
    return redirect(request, '/onboarding');
  }

  if (isOnboardingComplete(profile)) return response;

  if (matches(pathname, SETUP_PATHS)) return response;
  return redirect(request, '/onboarding');
}

export const config = {
  // Everything except static assets. Broad on purpose: a gate that has to be extended
  // every time a route is added is a gate that will be forgotten.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
