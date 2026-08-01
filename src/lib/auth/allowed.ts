import { readAuthConfig } from './config';

/**
 * The single address permitted to sign in.
 *
 * Reads through `readAuthConfig()`, which is where the note lives about why this whole
 * corner of the codebase reads `process.env` literally instead of going through
 * `src/lib/env.ts`. Read that note before changing either file — the short version is that
 * middleware runs on the Edge runtime, where a Proxy over the environment resolves to
 * `undefined` and an allowlist compared against `undefined` admits everyone.
 *
 * `ALLOWED_EMAIL` holds a comma-separated list — see `parseAllowlist` for why it stopped
 * being one address. Membership is exact after trimming and lower-casing; there is no
 * domain matching, because `@company.com` as an allowlist entry is how a workspace holding
 * live vendor credentials acquires users nobody chose.
 *
 * ── Why an allowlist and not "is authenticated" ──────────────────────────────
 *
 * Settings holds every vendor credential in the product. A Supabase project accepts
 * signups from anyone by default, so "has a session" is a gate that any stranger can pass
 * by typing their own email. The check is per-request and not only at sign-in: a session
 * minted before the allowlist changed must stop working the moment it does.
 */

export type AuthDecision =
  | { ok: true; email: string }
  | { ok: false; reason: 'unconfigured' | 'not_allowed' };

/**
 * Whether this address may sign in.
 *
 * An unset `ALLOWED_EMAIL` returns `unconfigured`, and every caller treats that as a
 * refusal. An allowlist that admits everyone when nobody filled it in is not an allowlist
 * — it is the absence of one, wearing the name.
 */
export function checkEmail(email: string | null | undefined): AuthDecision {
  const config = readAuthConfig();
  if (!config.ok) return { ok: false, reason: 'unconfigured' };

  const candidate = email?.trim().toLowerCase();
  if (!candidate || !config.config.allowedEmails.includes(candidate)) {
    return { ok: false, reason: 'not_allowed' };
  }

  return { ok: true, email: candidate };
}

/** Message for a refused sign-in. Deliberately identical for both reasons. */
export const SIGN_IN_REFUSED =
  'That address cannot sign in to this workspace. Kiln is single-tenant and the ' +
  'permitted address is set at deploy time.';
