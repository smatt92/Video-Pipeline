/**
 * Next.js calls this once per server process, before the first request is handled.
 *
 * Validating the environment here means a misconfigured deployment fails at boot with a
 * complete list of what is wrong, rather than serving traffic until it happens to touch
 * the missing variable. On Vercel this surfaces in the deployment log instead of as a
 * 500 on whichever route got unlucky.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertEnv } = await import('./lib/env');
  assertEnv();
}
