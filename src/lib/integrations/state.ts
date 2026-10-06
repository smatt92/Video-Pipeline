/**
 * Has this integration verified? One predicate, two readers that must never disagree.
 *
 *   the Settings banner   integrations/page.tsx → "N have never verified. Generation, dispatch,
 *                         voice, dubs and embeddings refuse those" — the claim.
 *   the pipeline          `usability()` → `verifiedCredentials()` → dispatch, voice, dubs,
 *                         embeddings, submit — the refusal.
 *
 * They used to be two predicates. The banner said tasks refuse an unverified integration;
 * dispatch, voice, dubs and embeddings asked only whether a key *existed*. So the screen
 * promised a refusal the code did not make — CLAUDE.md's guard whose message names an outcome
 * its accepting branch delivers. Sharing the function keeps the promise true the next time
 * either side changes.
 *
 * ── Two questions, deliberately ──────────────────────────────────────────────
 *
 *   hasVerified        may a task spend through it?   `last_verified_at` is set.
 *   integrationState   what does the pill show?        never_run / failed / verified.
 *
 * They differ in one case: verified once, failed the latest check. The pill says *failed*
 * (a green tick over a check that just failed would be a lie), and tasks still use it —
 * `rotateIntegration` deliberately leaves a previously working integration enabled when a
 * re-check fails, because a failure is at least as likely a network blip as a dead key, and
 * refusing would take the pipeline down on a transient. The banner says both numbers, each
 * with what it means, so neither is a claim about the other.
 */

export type CheckState = 'never_run' | 'failed' | 'verified';

export interface VerificationTimes {
  last_checked_at: string | Date | null;
  last_verified_at: string | Date | null;
}

/** The refusal predicate: has a real call ever accepted this integration? */
export function hasVerified(row: Pick<VerificationTimes, 'last_verified_at'>): boolean {
  return row.last_verified_at !== null && row.last_verified_at !== undefined;
}

const ms = (t: string | Date) => new Date(t).getTime();

/**
 * The display state. `last_verified_at >= last_checked_at`, compared as instants (PostgREST
 * hands back ISO text, the harness shim Dates). A verified time with no checked time — rows
 * from before 0007 added the column, and harness seeds — is verified: the only writer of
 * either, `verifyIntegration`, writes both together.
 */
export function integrationState(row: VerificationTimes): CheckState {
  if (row.last_verified_at && (!row.last_checked_at || ms(row.last_verified_at) >= ms(row.last_checked_at))) {
    return 'verified';
  }
  return row.last_checked_at ? 'failed' : 'never_run';
}
