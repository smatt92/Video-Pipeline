/**
 * The single address permitted to sign in.
 *
 * Deliberately not read through `src/lib/env.ts`. That module validates the entire
 * environment — driver credentials, storage keys, the FX rate — behind a Proxy, and it is
 * imported by middleware, which Next compiles for the Edge runtime where `process.env` is
 * populated only for statically-analysable member expressions. A Proxy over the whole
 * environment is by definition not statically analysable, so `env.ALLOWED_EMAIL` in
 * middleware would read `undefined` on Vercel and the gate would be deciding on nothing.
 *
 * Literal `process.env.ALLOWED_EMAIL` is inlined at build. That is the reason for the
 * duplication, and the reason it should stay a literal.
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

function allowedEmail(): string | null {
  const raw = process.env.ALLOWED_EMAIL;
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Whether this address may sign in.
 *
 * An unset `ALLOWED_EMAIL` returns `unconfigured`, and every caller treats that as a
 * refusal. An allowlist that admits everyone when nobody filled it in is not an allowlist
 * — it is the absence of one, wearing the name.
 */
export function checkEmail(email: string | null | undefined): AuthDecision {
  const allowed = allowedEmail();
  if (!allowed) return { ok: false, reason: 'unconfigured' };

  const candidate = email?.trim().toLowerCase();
  if (!candidate || candidate !== allowed) return { ok: false, reason: 'not_allowed' };

  return { ok: true, email: candidate };
}

/** Message for a refused sign-in. Deliberately identical for both reasons. */
export const SIGN_IN_REFUSED =
  'That address cannot sign in to this workspace. Kiln is single-tenant and the ' +
  'permitted address is set at deploy time.';
