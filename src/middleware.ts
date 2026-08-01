import { NextResponse, type NextRequest } from 'next/server';

/**
 * The onboarding gate.
 *
 * A redirect, not a dismissible banner. The whole point is that the app is unusable until
 * it is usable — a banner is read once and ignored, and the failure it is warning about
 * costs money when it lands mid-pipeline.
 *
 * Two routes stay open: `/onboarding/*` obviously, and `/settings/*` because the wizard's
 * steps are settings screens underneath and locking them would deadlock the gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Currently inert, and deliberately so
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `onboardingComplete()` returns true unconditionally, because the real answer lives in
 * `profiles.onboarding_step` and there is no reachable database to ask. Wiring it to a
 * fixture that says "incomplete" would lock the board behind a wizard whose steps cannot
 * pass — a gate with no key.
 *
 * The redirect logic is written, ordered and typed so that turning it on in 1c is
 * replacing one function body. That is the point of it existing now rather than later:
 * middleware added after forty routes exist has to be reasoned about against all of them.
 *
 * Auth is a separate concern that lands with it. The gate is ALLOWED_EMAIL, not merely
 * "is authenticated" — anyone can sign themselves up against a public Supabase project,
 * and this app's settings page holds every vendor credential.
 */

const ALWAYS_OPEN = [
  '/onboarding',
  '/settings',
  '/_next',
  '/favicon.ico',
  '/api/webhooks', // vendors call this without a session and must not be redirected
];

function isOpen(pathname: string): boolean {
  return ALWAYS_OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Whether the required onboarding steps have passed.
 *
 * TODO(1c): read `profiles.onboarding_step` for the signed-in user and compare against
 * REQUIRED_STEPS in src/lib/onboarding/steps.ts. Until a database is reachable this
 * cannot be answered, and answering it wrongly in either direction is worse than not
 * gating: `false` deadlocks the app, `true` is what we have — an honest no-op.
 */
function onboardingComplete(): boolean {
  return true;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isOpen(pathname)) return NextResponse.next();
  if (onboardingComplete()) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/onboarding';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except static assets. The matcher is broad on purpose: a gate that has to
  // be extended every time a route is added is a gate that will be forgotten.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
