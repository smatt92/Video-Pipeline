import 'server-only';

import type { Db } from '../db/server';

/**
 * Approving a concept — the pipeline lane's entry point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this is the smallest gap worth closing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `03-script` is a complete, replayable Trigger task with a concurrency limit and a cost
 * path that has run against the real model. Nothing calls it. Not because the wiring was
 * forgotten, but because the event it waits for — a concept being approved — **did not
 * exist anywhere in this codebase**. `grep` for it found the enum value and nothing else.
 *
 * So the whole pipeline lane had no entry point. Stage 3 was unreachable, and with the
 * stage 3 → 4 → 5 chain now in place, one missing function was holding four complete stages
 * out of reach. That is the smallest change with the largest unlock available, which is
 * what makes it the pick.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Approval is a transition, not a field write
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The status is set with `where status = 'draft'` rather than read-then-write, for the same
 * reason `confirm_generation_once` is a compare-and-set: approving spends money, and two
 * clicks — a double-submit, a retried action, two people — must produce one script and one
 * charge. The database decides who wins; a check in this function cannot.
 *
 * `killed` is deliberately not approvable. A concept that was killed and is now wanted is a
 * new concept, because the kill is editorial evidence and overwriting it loses the record
 * of a judgement that was made.
 */

export type ApproveOutcome =
  | { ok: true; conceptId: string; enqueued: boolean; runId?: string; detail?: string }
  | { ok: false; code: 'not_found' | 'not_draft'; detail: string };

export async function approveConcept(db: Db, conceptId: string): Promise<ApproveOutcome> {
  // The compare-and-set. `select` after `update` returns the row only if the update matched,
  // which is how "was it a draft" is answered without a separate read.
  const { data: updated } = await db
    .from('concepts')
    .update({ status: 'approved' })
    .eq('id', conceptId)
    .eq('status', 'draft')
    .select('id')
    .maybeSingle();

  if (!updated) {
    // Distinguish the two, because they mean different things to whoever clicked. "Already
    // approved" is a no-op and fine; "no such concept" is a broken link or a deleted row.
    const { data: exists } = await db
      .from('concepts')
      .select('id, status')
      .eq('id', conceptId)
      .maybeSingle();

    if (!exists) {
      return { ok: false, code: 'not_found', detail: `no concept with id ${conceptId}` };
    }
    return {
      ok: false,
      code: 'not_draft',
      detail:
        `this concept is "${exists.status}", not a draft. Approving is a one-way transition ` +
        'out of draft — a killed concept that is wanted again is a new concept, because the ' +
        'kill is editorial evidence and overwriting it loses the judgement.',
    };
  }

  // ── Hand it to stage 3 ────────────────────────────────────────────────────
  //
  // Dynamically imported, like every other enqueue in this codebase: a Server Action that
  // statically imports `src/trigger/` pulls the SDK and every registered task into the
  // route's bundle. The action needs to *queue* a draft, not to be able to run one.
  //
  // A failed enqueue does not undo the approval. The approval is a human decision and it
  // has been recorded; the draft can be started again from the board. Rolling it back would
  // discard the decision because of a transport failure, and would race anything that read
  // the row in between.
  try {
    const { scriptTask } = await import('@/trigger/03-script');
    const handle = await scriptTask.trigger({ conceptId });
    return { ok: true, conceptId, enqueued: true, runId: handle.id };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[concepts] approved, but stage 3 could not be enqueued', {
      conceptId,
      detail,
    });
    return { ok: true, conceptId, enqueued: false, detail };
  }
}
