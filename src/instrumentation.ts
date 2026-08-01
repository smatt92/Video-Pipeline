/**
 * Next.js calls this once per server process, before the first request is handled.
 *
 * Validating the environment here means a misconfigured deployment says so in the
 * deployment log, at boot, with a complete list — rather than serving traffic until
 * something happens to touch the missing variable and 401s four layers down.
 *
 * ── Why it reports instead of throwing ───────────────────────────────────────
 *
 * It used to throw. Next treats an exception from this hook as fatal, so the process
 * refused to start and every route returned 500 — including `/login` and `/onboarding`,
 * which are the two routes that exist to fix exactly this state. A deployment missing its
 * vendor credentials is the *normal* state before anyone has walked the wizard, because
 * the wizard is what puts them in Vault, so the check was guaranteeing a deadlock.
 *
 * The guarantee has not been given up, it has moved somewhere that can also act on it.
 * `src/middleware.ts` reads the same configuration and returns a 503 naming what is absent
 * — a refusal, with an explanation, on every route except the two that can help. That is
 * strictly more than a dead process provided, and this hook keeps the loud log entry.
 *
 * Fail closed means deny. Refusing to start is not denying; it is being unable to answer.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertEnv } = await import('./lib/env');

  try {
    assertEnv();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);

    // Deliberately noisy, and deliberately not a throw. This is the line someone greps a
    // platform log for; the running process still refuses requests through middleware.
    console.error(
      [
        '',
        '╔══════════════════════════════════════════════════════════════════════════╗',
        '║  KILN — ENVIRONMENT INCOMPLETE. The app booted and will refuse traffic.  ║',
        '╚══════════════════════════════════════════════════════════════════════════╝',
        '',
        detail,
        '',
        'App routes will receive 503 naming the missing variables. /login and',
        '/api/webhooks/* stay reachable — they have to, or there is no way in and no',
        'way for a vendor callback to land.',
        '',
      ].join('\n'),
    );
  }
}
