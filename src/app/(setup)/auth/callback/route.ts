import { NextResponse, type NextRequest } from 'next/server';

import { checkEmail } from '@/lib/auth/allowed';
import { serverClient } from '@/lib/db/server';
import { reconcileSeen, SEEN_COOKIE } from '@/lib/onboarding/entry';
import { routeHandlerClient } from '@/lib/auth/supabase';

/**
 * Where every sign-in lands — magic link and Google alike.
 *
 * ── One route, deliberately ──────────────────────────────────────────────────
 *
 * Both flows are PKCE and both come back as `?code=`, so `exchangeCodeForSession` is
 * identical for each. What follows the exchange — check the allowlist, refuse and destroy
 * the session if it fails — is the security-critical part, and it is the same for both.
 *
 * A sibling route would mean two copies of that refusal path. One of them would be edited
 * without the other within a month, and the one that drifted would be the one nobody tests
 * because it only runs for the provider you use less. A single route is not a convenience
 * here; it is the reason the refusal cannot be half-fixed.
 *
 * The provider is not consulted anywhere below, which is the other half of the argument:
 * an address Google vouched for and an address that clicked a link in an inbox get exactly
 * the same scrutiny. Neither is trusted more than the allowlist.
 *
 * ── Refusal has to leave nothing behind ──────────────────────────────────────
 *
 * `exchangeCodeForSession` *succeeds* for a Google-authenticated stranger — Google
 * authenticated them; that was never in question. The session cookies are set by that call.
 * So the refusal path has to actively destroy what the exchange just created, and it has to
 * do so on the response that is actually returned. That is why this uses
 * `routeHandlerClient`, which writes cookies onto a response object we hold, and why the
 * cookies are also expired explicitly below.
 *
 * A Google-authenticated user who is not on the allowlist is the exact shape of an
 * accidentally-open app.
 */

/** Supabase names its session cookies `sb-<project-ref>-auth-token`, sometimes chunked. */
const SESSION_COOKIE = /^sb-.*-auth-token(\.\d+)?$/;

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  /**
   * A refusal, with every session cookie destroyed on the way out.
   *
   * Belt and braces on purpose: `signOut()` is asked to clear the session *and* every
   * cookie matching the session pattern is expired directly on this response. The two
   * mechanisms fail differently — signOut needs the network, the sweep does not — and the
   * cost of either failing alone is a stranger holding a live session.
   */
  const refuse = async (
    reason: string,
    supabase?: ReturnType<typeof routeHandlerClient>,
  ) => {
    const response = NextResponse.redirect(
      `${origin}/login?denied=${encodeURIComponent(reason)}`,
    );

    if (supabase) {
      // May fail if the auth host is unreachable. The sweep below does not depend on it.
      await supabase.auth.signOut().catch(() => undefined);
    }

    for (const cookie of request.cookies.getAll()) {
      if (SESSION_COOKIE.test(cookie.name)) {
        response.cookies.set(cookie.name, '', { path: '/', maxAge: 0 });
      }
    }

    return response;
  };

  if (!code) return refuse('no_code');

  // The success response is created up front so the exchange's cookies land on the object
  // that gets returned — the same reason middleware does it.
  const success = NextResponse.redirect(`${origin}${safeNext}`);
  const supabase = routeHandlerClient(request, success);

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return refuse('exchange_failed', supabase);

  // The only check that matters. Google authenticated them; that is not the question.
  const decision = checkEmail(data.user?.email);
  if (!decision.ok) return refuse('not_allowed', supabase);

  // ── Carry the anonymous tour across the account boundary ──────────────────
  //
  // Someone who takes the whole tour and *then* signs up must not be shown it again on the
  // very next screen. The cookie is the only record they had; this is where it becomes a
  // fact about a person rather than about a browser.
  //
  // Deliberately best-effort. A failure here means the tour is shown once more than it
  // needed to be, which is mild; refusing a valid sign-in because a preference write failed
  // is not. Any error is logged and swallowed.
  if (data.user && request.cookies.get(SEEN_COOKIE)?.value === '1') {
    try {
      const db = serverClient();
      const { data: profile } = await db
        .from('profiles')
        .select('onboarding_seen_at')
        .eq('id', data.user.id)
        .maybeSingle();

      const patch = reconcileSeen({
        seenOnRecord: profile?.onboarding_seen_at != null,
        seenCookie: true,
        now: new Date(),
      });

      // Null when the record already says so — skipped rather than written, because
      // `onboarding_seen_at` is "when did this person first understand what this is" and
      // refreshing it on every login turns a fact into a last-seen counter nothing reads.
      if (patch && profile) {
        await db.from('profiles').update(patch).eq('id', data.user.id);
      }
    } catch (err) {
      console.error('[auth] could not reconcile the onboarding cookie:', err);
    }
  }

  return success;
}
