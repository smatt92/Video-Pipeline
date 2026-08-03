import 'server-only';

import type { Db } from '../db/server';
import { validateTrim } from './timeline';

/**
 * The review screen's writes, minus the framework.
 *
 * `actions.ts` is auth plus `revalidatePath` over this; `scripts/verify-review.mjs` runs
 * these functions directly against a real database. Same pattern as `studio/serve.ts` and
 * for the same reason: everything with a rule in it lives where something can execute it,
 * and the Server Action keeps only the parts that need Next.
 *
 * That split matters most for `recordReview`. It computes `structure_novel` rather than
 * accepting it, and freezes `human_edit_count` at decision time — two rules that exist
 * because this row is evidence under the inauthentic-content policy, and both of which
 * would be untested if they lived inside a `'use server'` module.
 */

export type WriteResult = { ok: true; message: string; id?: string } | { ok: false; message: string };

export const DECISIONS = ['pass', 'reshoot', 'kill'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface ReviewInput {
  renderId: string;
  reviewerId: string;
  decision: string;
  reshootShotIds: string[];
  notes: string | null;
}

/**
 * Record a decision.
 *
 * `structure_novel` is derived here from the novelty view and never taken from the caller.
 * ARCHITECTURE.md §0.2 makes it evidence in a policy appeal, and a boolean the reviewer
 * supplies is a boolean that says whatever makes the review pass — which is the opposite of
 * evidence.
 *
 * `human_edit_count` is snapshotted for the same reason: the row records what was true when
 * the judgement was made. Later edits to the script must not retroactively change what the
 * reviewer is recorded as having seen.
 */
export async function recordReview(db: Db, input: ReviewInput): Promise<WriteResult> {
  if (!DECISIONS.includes(input.decision as Decision)) {
    return { ok: false, message: `"${input.decision}" is not a decision.` };
  }

  if (input.decision === 'reshoot' && input.reshootShotIds.length === 0) {
    return {
      ok: false,
      message:
        'A reshoot decision has to name the shots. "Something is wrong with this" is not an ' +
        'instruction anything downstream can act on.',
    };
  }

  const { data: render } = await db
    .from('renders')
    .select('id, script_id')
    .eq('id', input.renderId)
    .maybeSingle();

  if (!render) return { ok: false, message: `No render ${input.renderId}.` };

  const { data: script } = await db
    .from('scripts')
    .select('human_edit_count')
    .eq('id', render.script_id)
    .maybeSingle();

  const { data: novelty } = await db
    .from('v_script_structure_novelty')
    .select('shared_with, unmeasured')
    .eq('script_id', render.script_id)
    .maybeSingle();

  // Unmeasured counts as not novel. A Studio stub hash is unique by construction, so
  // reporting it as novel would be the guard congratulating itself on arithmetic it never
  // did.
  const structureNovel = novelty
    ? !novelty.unmeasured && Number(novelty.shared_with) === 0
    : false;

  const { data, error } = await db
    .from('reviews')
    .insert({
      render_id: input.renderId,
      reviewer_id: input.reviewerId,
      decision: input.decision,
      reshoot_shot_ids: input.reshootShotIds,
      notes: input.notes,
      human_edit_count: script?.human_edit_count ?? 0,
      structure_novel: structureNovel,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, message: `The review was not recorded: ${error?.message ?? 'no row'}` };
  }

  // A reshoot is an instruction, so it moves the shots it names. Rows, not a note.
  if (input.decision === 'reshoot') {
    await db.from('shots').update({ status: 'reshoot' }).in('id', input.reshootShotIds);
  }

  return {
    ok: true,
    id: data.id,
    message:
      input.decision === 'pass'
        ? structureNovel
          ? 'Passed. This is the row the publish gate reads.'
          : 'Passed, and recorded as structurally not novel — the publish gate can still ' +
            'refuse on that, which is the point of recording it honestly.'
        : `Recorded as ${input.decision}.`,
  };
}

export async function writeTrim(
  db: Db,
  shotId: string,
  inS: number | null,
  outS: number | null,
): Promise<WriteResult> {
  const { data: shot } = await db
    .from('shots')
    .select('id, duration_s')
    .eq('id', shotId)
    .maybeSingle();

  if (!shot) return { ok: false, message: `No shot ${shotId}.` };

  const result = validateTrim({ durationS: Number(shot.duration_s) }, { inS, outS });
  if (!result.ok) return { ok: false, message: result.reason };

  const { error } = await db
    .from('shots')
    .update({ trim_in_s: result.trimInS, trim_out_s: result.trimOutS })
    .eq('id', shotId);

  if (error) return { ok: false, message: error.message };

  return {
    ok: true,
    message:
      result.trimInS === null
        ? 'Trim cleared.'
        : `In ${result.trimInS}s, out ${result.trimOutS}s. The cut is now shorter than the ` +
          'voiceover it was timed against — check the drift column before passing this.',
  };
}

/**
 * Persist a new shot order.
 *
 * Through `reorder_shots`, not a series of UPDATEs. `unique (script_id, idx)` makes a naive
 * swap fail mid-statement; the function renumbers in two phases so the constraint holds
 * throughout (0018). It also rejects a partial id list, which turns a stale client view
 * into an error rather than a silently reordered cut.
 */
export async function writeOrder(
  db: Db,
  scriptId: string,
  shotIds: string[],
): Promise<WriteResult> {
  const { error } = await db.rpc('reorder_shots', {
    p_script_id: scriptId,
    p_shot_ids: shotIds,
  });

  if (error) {
    return {
      ok: false,
      message: /not this script/.test(error.message)
        ? 'The shot list on screen is out of date — reload before reordering. Renumbering ' +
          'against a stale list would leave the shots it does not name wherever they landed.'
        : error.message,
    };
  }

  return { ok: true, message: 'Order saved. Re-run the rough cut to see it.' };
}
