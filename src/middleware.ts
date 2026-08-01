import { NextResponse, type NextRequest } from 'next/server';

/**
 * The onboarding gate.
 *
 * A redirect, not a dismissible banner. The app should be unusable until it is usable —
 * a banner is read once and ignored, and the failure it warns about costs money when it
 * lands mid-pipeline.
 *
 * Two paths stay open: `/onboarding/*` obviously, `/settings/*` because the wizard's
 * steps are settings screens underneath and locking them would deadlock the gate, and
 * `/api/webhooks/*` because vendors call it without a session and must never be
 * redirected — a 307 to an HTML page is a delivery the vendor will not retry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This gate fails CLOSED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The real answer lives in `profiles.onboarding_step`, and there is no reachable database
 * to ask yet. There are two ways to handle not knowing, and only one of them is safe:
 *
 *   fail open  — assume setup is complete, serve everything. Forgetting to wire the
 *                real check leaves the app permanently unguarded, and nothing ever
 *                surfaces the omission. This is what it used to do.
 *   fail closed — refuse. Forgetting locks the app, which is loud, immediate, and
 *                 impossible to ship past by accident.
 *
 * A setup gate that defaults open when unconfigured is backwards. So without an explicit
 * `ONBOARDING_GATE_BYPASS=1`, this throws.
 *
 * Set the bypass in local development only. **Never on Vercel.** A deployment with it set
 * has no gate at all, which is the state this inversion exists to make impossible to
 * reach silently.
 *
 * Consequence worth knowing before it surprises you: until 1c wires the real check, a
 * deployed preview will 500 on every app route. That is the gate working, not a
 * regression — `/onboarding` and `/settings` still serve, which is exactly the surface
 * someone who has not finished setup should have.
 */

const ALWAYS_OPEN = [
  '/onboarding',
  '/settings',
  '/_next',
  '/favicon.ico',
  '/api/webhooks',
];

function isOpen(pathname: string): boolean {
  return ALWAYS_OPEN.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Whether the required onboarding steps have passed.
 *
 * TODO(1c): read `profiles.onboarding_step` for the signed-in user and compare against
 * REQUIRED_STEPS in src/lib/onboarding/steps.ts. When that lands, delete the bypass
 * branch entirely rather than leaving it as a fallback — a bypass that outlives its
 * reason is a backdoor with a comment on it.
 */
function onboardingComplete(): boolean {
  if (process.env.ONBOARDING_GATE_BYPASS === '1') return true;

  throw new Error(
    'Onboarding gate is not wired and ONBOARDING_GATE_BYPASS is not set, so this request ' +
      'is refused.\n\n' +
      'The gate cannot tell whether setup is complete — profiles.onboarding_step is not ' +
      'readable yet — and it fails closed rather than open. An unconfigured setup gate ' +
      'that serves traffic is worse than one that refuses: nothing ever surfaces the ' +
      'omission.\n\n' +
      'Local development: set ONBOARDING_GATE_BYPASS=1 in .env.local.\n' +
      'Deployments: do not set it. Wire the real check in src/middleware.ts instead.\n\n' +
      '/onboarding and /settings remain reachable either way.',
  );
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
  // Everything except static assets. Broad on purpose: a gate that has to be extended
  // every time a route is added is a gate that will be forgotten.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
