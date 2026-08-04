import 'server-only';

import { serverClient, type Db } from '../db/server';

/**
 * Numbers a screen deliberately does not show, and the writer each one is waiting for.
 *
 * ── The difference between a documented limitation and a permanent one ───────
 *
 * `/costs` withheld a credit balance because `generations.credits_spent` has no writer, and
 * the way that was done matters more than the fact: `consumptionObserved` is computed from
 * the data — *has anything ever written this?* — rather than hardcoded. The day a writer
 * lands, one row carries a figure, the flag flips, and the screen starts showing a balance
 * **without anyone remembering to change it**.
 *
 * A hardcoded `false` with a comment would have looked identical and stayed false for ever.
 * That is the difference between a limitation that documents itself and one that becomes
 * permanent by being written down.
 *
 * This registry generalises it. Every entry is a number some screen refuses to show, the
 * column whose absence of a writer is the reason, and a probe that answers *has that
 * changed*. Nothing here is a config flag: there is no way to turn one on by hand, and no
 * way for one to stay off once the data exists.
 *
 * ── What must never appear here ──────────────────────────────────────────────
 *
 * A number withheld because it is *hard*, or *unfinished*, or because the screen would look
 * bad. Those are reasons to build the thing. An entry is only correct when the number is
 * genuinely unknowable from the rows we have — and the probe is what keeps that honest,
 * because the moment it is knowable the entry stops applying and the check fails.
 */

export type WithheldKey = 'generation_settled' | 'credits_spent' | 'publication_outcome';

export interface Withheld {
  readonly key: WithheldKey;
  /** The number the screen will not show. */
  readonly number: string;
  /** The writer that does not exist. Named precisely enough to grep for. */
  readonly missingWriter: string;
  /** What the screen says instead, and why that is not the same as zero. */
  readonly saysInstead: string;
  /** What appears the day the writer lands. Written now so nobody has to re-derive it. */
  readonly whenWritten: string;
}

export const WITHHELD: readonly Withheld[] = [
  {
    key: 'generation_settled',
    number: 'Settled cost of a video generation, and therefore cost per video for any '
      + 'script that has generated.',
    missingWriter:
      'Nothing writes a `reconcile` row against a `generation_id`. `submit.ts` writes the '
      + '`estimate` at submit and the terminal path in `confirm.ts` writes a status, an '
      + 'asset and an ingest enqueue — and no ledger row. Rule 5 says "reconcile on '
      + 'completion" and that half has never existed.',
    saysInstead:
      'The video stays in `denominator_state = nothing_settled`, which reads as "in flight" '
      + 'and is honest about the row while silent about the fact that it is permanent.',
    whenWritten:
      'The estimate is superseded, settled_inr becomes a figure, and the video becomes '
      + 'countable towards cost per video — which today it never can, no matter how many '
      + 'complete.',
  },
  {
    key: 'credits_spent',
    number: 'Credits remaining against a vendor account.',
    missingWriter: 'Nothing writes `generations.credits_spent`.',
    saysInstead:
      '"not recorded" where a balance would go. The purchase total is shown as a position — '
      + 'unexpired, expiring, expired — because it is not a balance and rendering it as one '
      + 'would be a stale constant presented as a live figure.',
    whenWritten:
      'consumptionObserved flips, the spent column fills in, and remaining becomes '
      + 'answerable. verify:limits §3 asserts both directions of that flag.',
  },
  {
    key: 'publication_outcome',
    number: 'Whether a video actually went live, and when.',
    missingWriter:
      'Nothing writes `publications.external_post_id` or `published_at`. Phase 1 publishes '
      + 'by hand — download the file, paste the metadata — so there is no API call to '
      + 'record one.',
    saysInstead:
      'A publication row stays `draft`. That is exact: the row records the metadata that '
      + 'was prepared, not an outcome nobody observed.',
    whenWritten:
      'Auto-publish lands after Meta app review, `src/lib/publish/` records the post id, '
      + 'and published_at becomes the measurement analytics divides by.',
  },
];

export type Observability = Record<WithheldKey, { observed: boolean; rows: number }>;

/**
 * Ask, of each withheld number, whether the writer has appeared.
 *
 * Counts rather than existence checks, so a screen can say "3 of 40 generations have a
 * settled cost" during the window where a writer exists and has not caught up — which is a
 * third state, and the one where a naive boolean would claim the number is trustworthy.
 */
export async function readObservability(client?: Db): Promise<Observability> {
  const db = client ?? serverClient();

  const [settled, credits, published] = await Promise.all([
    db
      .from('cost_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('entry_kind', 'reconcile')
      .not('generation_id', 'is', null),
    db
      .from('generations')
      .select('id', { count: 'exact', head: true })
      .not('credits_spent', 'is', null),
    db
      .from('publications')
      .select('id', { count: 'exact', head: true })
      .not('published_at', 'is', null),
  ]);

  const at = (r: { count: number | null }) => ({
    observed: (r.count ?? 0) > 0,
    rows: r.count ?? 0,
  });

  return {
    generation_settled: at(settled),
    credits_spent: at(credits),
    publication_outcome: at(published),
  };
}

export function withheld(key: WithheldKey): Withheld {
  const w = WITHHELD.find((x) => x.key === key);
  if (!w) throw new Error(`No withheld entry for ${key}`);
  return w;
}
