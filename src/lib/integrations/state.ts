/**
 * Has this integration verified? One predicate, two readers that must never disagree.
 *
 *   the Settings banner   `step-view.ts` → "N integrations are unverified. A pipeline task
 *                         refuses …" — the claim.
 *   the pipeline          `usability()` → `verifiedCredentials()` → dispatch, voice, dubs,
 *                         embeddings, submit — the refusal.
 *
 * They used to be two predicates. The banner asked `last_verified_at >= last_checked_at`; the
 * stages asked whether a key *existed*, and four of them never asked about verification at
 * all. So the screen promised a refusal the code did not make — the fourth guard shape in
 * CLAUDE.md, a message naming an outcome its accepting branch delivers. Sharing the function
 * is what keeps the promise true the next time either side changes.
 *
 * The states:
 *
 *   never_run   nothing has been attempted
 *   failed      attempted, and not verified since
 *   verified    accepted by the latest attempt
 *
 * `last_verified_at >= last_checked_at` rather than "verified is not null": an integration
 * that worked in March and failed this morning is *failed*, and a check that only asked
 * whether it had ever worked would show a green tick — and let a task spend — over a broken
 * credential. A verified time with no checked time (rows written before 0007 added the
 * column, and harness seeds) counts as verified: the only writer of either column,
 * `verifyIntegration`, writes both together.
 *
 * Timestamps are compared as instants, not as strings: PostgREST hands back ISO text and the
 * harness shim hands back Dates, and a lexical comparison across those would be a coin toss.
 */

export type CheckState = 'never_run' | 'failed' | 'verified';

export interface VerificationTimes {
  last_checked_at: string | Date | null;
  last_verified_at: string | Date | null;
}

const ms = (t: string | Date) => new Date(t).getTime();

export function integrationState(row: VerificationTimes): CheckState {
  if (row.last_verified_at && (!row.last_checked_at || ms(row.last_verified_at) >= ms(row.last_checked_at))) {
    return 'verified';
  }
  return row.last_checked_at ? 'failed' : 'never_run';
}
