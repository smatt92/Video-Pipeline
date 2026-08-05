import 'server-only';

import { readUsdInrRate } from '../cost/fx';
import type { Db } from '../db/server';

/**
 * What the last metadata draft actually cost, and whether another one may be charged.
 *
 * ── Why a prior and not an estimate ──────────────────────────────────────────
 *
 * The rule for anything that spends is that the screen shows the cost before it fires. For a
 * generation that works: the rate card and the shot's parameters give a real forecast.
 *
 * For a Messages call it does not, and `src/lib/cost/llm.ts` says why in its own header:
 * *"A Messages call is synchronous and priced on tokens that do not exist until it returns:
 * there is no honest estimate to write beforehand. The input token count is not knowable
 * without a separate billed count_tokens call, and the output count is not knowable at all."*
 *
 * So a rupee figure labelled "this will cost" would be invented — the precise defect three
 * decisions this week have been removing, reappearing on a button. What *is* honest is a
 * **measurement of the last one**, labelled as the last one. It answers the question the
 * operator is actually asking (is this ₹0.40 or ₹40?) without asserting anything about the
 * call that has not happened.
 *
 * Null means no metadata draft has ever been charged. Not zero — see the whole of this
 * project on that distinction. The screen says "not previously measured", which is the
 * truthful thing to put in front of somebody about to spend.
 */

export interface MetadataPrior {
  /** The last charged draft, or null when none has been. Never a zero standing in for none. */
  lastCostInr: number | null;
  lastAt: string | null;
  /** Null when a rupee figure can be produced; a sentence naming the problem when it cannot. */
  refusal: string | null;
}

export async function readMetadataPrior(db: Db): Promise<MetadataPrior> {
  // The rate first. Without it the task will refuse anyway, and finding that out after
  // pressing is the failure this whole ordering exists to prevent.
  const fx = await readUsdInrRate(db);

  const { data } = await db
    .from('cost_ledger')
    .select('cost_inr, occurred_at')
    .eq('stage', '09-metadata')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // `numeric` arrives as a string. `Number()` at the boundary, knowingly: a rupee figure of
  // this size is well inside a double, and the mapper is where that decision belongs.
  const cost = data?.cost_inr === undefined || data?.cost_inr === null ? null : Number(data.cost_inr);

  return {
    lastCostInr: cost !== null && Number.isFinite(cost) ? cost : null,
    lastAt: data?.occurred_at ?? null,
    refusal: fx.ok ? null : `${fx.reason} ${fx.remedy}`,
  };
}
