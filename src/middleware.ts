import { NextResponse, type NextRequest } from 'next/server';

import { checkEmail } from '@/lib/auth/allowed';
import { readAuthConfig, type RequiredVar } from '@/lib/auth/config';
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
 * 0. Fail closed means deny, not crash
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before either gate, the configuration is read *as a result*, and a missing variable
 * produces a 503 naming what is absent. It used to throw. A throw in middleware takes down
 * every route it fronts — including `/login`, the only one that could have helped — and
 * makes a half-configured deploy present exactly like a bug in the code, so the person
 * debugging it has neither a way in nor a way to tell the two apart. Both gates below are
 * refusals; a crash is not a refusal, it is the absence of an answer.
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
 * 2. Onboarding — reads the profile's completed steps
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

/**
 * A deployment that cannot read its own configuration.
 *
 * Fail closed means **deny**, not crash. An uncaught throw in middleware takes down every
 * route it fronts — including `/login`, the one route that could have helped — and turns a
 * missing environment variable into an opaque 500 that is indistinguishable from a bug in
 * the code. The person debugging it has neither a way in nor a way to tell which problem
 * they have.
 *
 * So: 503, no session touched, nothing served, and the *names* of what is absent. Names
 * only. A misconfiguration report that quotes values is a credential leak with a helpful
 * tone.
 */
function misconfigured(missing: readonly RequiredVar[]): NextResponse {
  const list = missing.map((v) => `<li><code>${v}</code></li>`).join('');
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiln — not configured</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center;
         background:#0c0e0f; color:#e6e8e9;
         font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
  main { max-width:44rem; padding:2.5rem 1.5rem }
  h1 { font-size:1.15rem; font-weight:500; margin:0 0 .75rem; letter-spacing:-.01em }
  p { margin:0 0 1rem; color:#a3aaad }
  ul { margin:0 0 1.25rem; padding-left:1.1rem }
  li { margin:.2rem 0 }
  code { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:#e6e8e9 }
  a { color:#4db6ac }
  .note { font-size:12.5px; color:#6e7679; border-top:1px solid #1e2325; padding-top:1rem }
</style></head><body><main>
<h1>Kiln is not configured</h1>
<p>The gate decides who may sign in and whether setup is finished. It cannot answer either
question, so it is refusing every request rather than serving them. These variables are
not set on this deployment:</p>
<ul>${list}</ul>
<p>Set them and redeploy. Values are inlined into the Edge bundle at build time, so
changing them in the dashboard does not affect a build that already shipped.</p>
<p><a href="/login">/login</a> stays reachable, but signing in will not work until the
above is fixed.</p>
<p class="note">Names only — this page never shows a value.</p>
</main></body></html>`;

  return new NextResponse(body, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached. A cached 503 outlives the fix.
      'cache-control': 'no-store, must-revalidate',
      'retry-after': '60',
    },
  });
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

  // Public first, and before the configuration read. `/login` and `/api/webhooks/*` must
  // survive every state this function can be in, including "this deployment has no
  // configuration at all" — otherwise the misconfiguration report has nowhere to point
  // and a vendor callback gets an HTML error page it will not retry.
  if (matches(pathname, PUBLIC_PATHS)) return NextResponse.next();

  const config = readAuthConfig();
  if (!config.ok) return misconfigured(config.missing);

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
    .select('onboarding_completed_steps, onboarding_completed_at')
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
