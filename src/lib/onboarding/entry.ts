import { STEPS } from './steps';

/**
 * Where a visit goes. A pure function, because the middleware is the worst possible place
 * to discover this logic is wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The flow this encodes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   splash (every visit — auth check, prefetch)
 *     ├─ signed in,  onboarding seen      → app
 *     ├─ signed in,  onboarding not seen  → onboarding → fork
 *     └─ not signed in                    → onboarding (PUBLIC) → sign in → fork
 *
 *   fork = "Set up account" → wizard → app,  or "Skip" → app
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What changed, and why the old shape was wrong
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Onboarding used to sit *behind* authentication, so the only people who saw the
 * explanation of what Kiln is were people who had already decided to sign up. The tour was
 * doing no work. Moving it in front is the whole amendment, and it has one consequence that
 * touches every layer: an anonymous visitor has no profile row, so "has this person seen
 * onboarding?" has to be answerable without one.
 *
 * ── Two sources for one fact, and which wins ─────────────────────────────────
 *
 * A cookie answers it before sign-in; `profiles.onboarding_seen_at` answers it after. The
 * rule is *authenticated state wins* — a cookie is per-browser and the column is per-person,
 * so someone who saw the tour on their laptop should not see it again on their phone.
 *
 * The reverse reconciliation matters just as much and is easier to forget: an anonymous
 * visitor who finishes the tour and *then* signs up must not be shown it again on the very
 * next screen. `reconcileSeen` is what carries the cookie onto the row at first sign-in.
 *
 * ── The allowlist is not this function's problem ─────────────────────────────
 *
 * A stranger can take the whole tour and then be refused at sign-in. That is deliberate and
 * `/login` already explains it. Putting an allowlist check in front of the tour would mean
 * the only people who can learn what Kiln is are people already permitted to use it, which
 * is the problem this amendment exists to fix, restated.
 */

export type EntryDestination =
  | { to: 'app'; why: string }
  | { to: 'onboarding'; why: string }
  | { to: 'login'; why: string };

export interface EntryState {
  /** A permitted, authenticated session. Not merely "has a session". */
  signedIn: boolean;
  /** `profiles.onboarding_seen_at is not null`. Null when there is no profile to read. */
  seenOnRecord: boolean | null;
  /** The anonymous cookie. Only consulted when there is no record. */
  seenCookie: boolean;
}

export function entryDestination(state: EntryState): EntryDestination {
  // Authenticated state wins wherever it exists: the column is per-person, the cookie is
  // per-browser, and a person is the thing we are trying not to bore twice.
  const seen = state.seenOnRecord ?? state.seenCookie;

  if (state.signedIn) {
    return seen
      ? { to: 'app', why: 'signed in, and has seen the tour' }
      : { to: 'onboarding', why: 'signed in, but has never seen the tour' };
  }

  return seen
    ? { to: 'login', why: 'not signed in, but has already seen the tour' }
    : { to: 'onboarding', why: 'not signed in and has never seen the tour — the public path' };
}

/**
 * What to write to the profile at first sign-in.
 *
 * Returns null when there is nothing to do, so the caller can skip the write rather than
 * issue an UPDATE on every single sign-in.
 *
 * The timestamp is *not* refreshed when a record already exists. `onboarding_seen_at` is
 * "when did this person first understand what this is", and overwriting it on every login
 * turns a fact into a last-seen counter that nothing reads.
 */
export function reconcileSeen(params: {
  seenOnRecord: boolean;
  seenCookie: boolean;
  now: Date;
}): { onboarding_seen_at: string } | null {
  if (params.seenOnRecord) return null;
  if (!params.seenCookie) return null;
  return { onboarding_seen_at: params.now.toISOString() };
}

/**
 * The cookie.
 *
 * A year, because the fact it records does not expire — somebody who understood Kiln in
 * August still understands it in November. Lax rather than Strict so arriving from a link
 * in an email does not re-trigger the tour. Not `httpOnly`: the onboarding screen sets it
 * from the client the moment the last step is dismissed, and a round trip to a route
 * handler to record "I read this" is latency for nothing.
 *
 * No personal data in it. It is one bit, and it is the bit the flow branches on.
 */
export const SEEN_COOKIE = 'kiln.onboarding-seen';
export const SEEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function seenCookieAttributes(): string {
  return `Path=/; Max-Age=${SEEN_COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * Every step may be deferred now.
 *
 * 0016 restricted this to the two whose vendor gates API access behind a paid plan, on the
 * grounds that "a gate that can be waved through entirely is not a gate". That was correct
 * while setup *was* a gate. It is not one any more, so the restriction stopped protecting
 * anything and only prevented someone recording why they skipped a step — which makes the
 * provenance worse without making any control stronger.
 *
 * What has not changed, and is the entire design: **deferring opens the app and makes
 * nothing runnable.** `usability()` still requires is_enabled AND last_verified_at. A
 * deferral changes the sentence a refusal gives back, never the answer.
 */
export const DEFERRABLE_STEPS: readonly number[] = STEPS.map((s) => s.n);

export function isDeferrable(step: number): boolean {
  return DEFERRABLE_STEPS.includes(step);
}
