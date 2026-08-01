import { readAuthConfig } from './config';

/**
 * Which sign-in providers the Supabase project actually has enabled.
 *
 * Exists so that a missing Google button has a *reason* on the page instead of being
 * absent. The same principle as the disabled sidebar routes and the malformed-allowlist
 * warning: a control that is present and explains why it cannot be used is diagnosable; a
 * control that is not rendered is indistinguishable from a build that never shipped it.
 *
 * `/auth/v1/settings` is unauthenticated by design — it tells a browser which buttons to
 * draw — so reading it costs nothing and leaks nothing.
 *
 * ── Three states, not two ────────────────────────────────────────────────────
 *
 * `unknown` is the important one. If the probe cannot reach the auth host, reporting
 * "Google is not configured" would be a confident wrong diagnosis about the one thing the
 * person is trying to diagnose. Unknown says the button may or may not work and names why
 * we cannot tell, which is worse to look at and better to act on.
 */
export type ProviderState = 'enabled' | 'disabled' | 'unknown';

export interface ProviderStatus {
  google: ProviderState;
  detail: string | null;
}

/** Short: this runs on a page render, and a hanging probe would hold the sign-in page. */
const TIMEOUT_MS = 2_500;

export async function probeProviders(): Promise<ProviderStatus> {
  const config = readAuthConfig();
  if (!config.ok) {
    return { google: 'unknown', detail: 'Supabase is not configured on this deployment.' };
  }

  try {
    const response = await fetch(`${config.config.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: config.config.supabaseAnonKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        google: 'unknown',
        detail: `The auth host answered ${response.status} when asked which providers are enabled.`,
      };
    }

    const body: unknown = await response.json();
    const external =
      typeof body === 'object' && body !== null && 'external' in body ? body.external : null;

    if (typeof external !== 'object' || external === null || !('google' in external)) {
      return {
        google: 'unknown',
        detail: 'The auth host did not report a provider list in the documented shape.',
      };
    }

    return external.google === true
      ? { google: 'enabled', detail: null }
      : {
          google: 'disabled',
          detail:
            'Google sign-in is not enabled on this Supabase project. Authentication → ' +
            'Sign In / Providers → Google, with the client ID and secret from the Google ' +
            'Cloud Console.',
        };
  } catch (err) {
    return {
      google: 'unknown',
      detail: `Could not reach the auth host to ask: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
