import 'server-only';

import { serverClient, type Db } from '../db/server';

/**
 * Cost per video, read from `v_video_cost`.
 *
 * The design constraint, decided before the screen was written: **per-video rows and a
 * denominator before any headline number.** A total spend figure looks identical after one
 * video and after a hundred — it goes up, and nothing on screen tells you whether that is
 * a hundred cheap videos or one ruinous one. So the rows are the primary artifact and the
 * average is derived from them, with the count it was divided by stated next to it.
 *
 * The three kinds of uncertainty come through from the view rather than being flattened
 * here, because flattening them is how a headline metric becomes wrong in the flattering
 * direction:
 *
 *  - **unpriced** — a contributing ledger row has a null cost. The video's cost is unknown,
 *    not low. It is excluded from the average and counted in `excluded.unpriced`.
 *  - **committed but unsettled** — an estimate written at submit whose result has not come
 *    back. Real money, not yet actual. Reported as its own figure, never added to settled.
 *  - **not a video yet** — spend on a script nothing has rendered. Excluded from the
 *    per-video average by definition; it is not a video.
 *
 * `costPerVideo` is null when the countable set is empty, and the caller must render that
 * as "—" rather than ₹0. There is a real difference between "videos cost nothing" and
 * "no video has finished", and this project has now shipped five instances of that
 * distinction being lost.
 *
 * Three outcomes, never two — the same rule the board was rewritten for. Rows, empty, or
 * broken. A blank costs page that could mean "nothing has cost anything" or "the view is
 * missing" hides the second case until somebody independently suspects it, and on this
 * screen the first reading is the comfortable one.
 */

export interface VideoCostRow {
  scriptId: string;
  conceptId: string;
  channelId: string;
  title: string;
  createdAt: string;
  /**
   * Money parted with, priced from the vendor's own figure or an observed balance delta.
   * Null when any contributing row is unpriced. Never coerce to 0.
   */
  measuredInr: number | null;
  /**
   * Money parted with, priced from our rate card. A completed generation lands here, which
   * is what makes it countable without a fabricated reconcile — and why every surface that
   * shows it has to say "estimated".
   */
  estimatedInr: number | null;
  measuredRows: number;
  unpricedIncurredRows: number;
  /** Submitted, not yet terminal. The vendor may still refuse it for free. */
  committedInr: number | null;
  unpricedCommittedRows: number;
  ledgerRows: number;
  componentInr: Record<string, { inr: number | null; unpriced: number }>;
  renders: number;
  rendersReady: number;
  publicationsLive: number;
  denominatorState:
    | 'countable_measured'
    | 'countable_estimated'
    | 'not_rendered'
    | 'unpriced'
    | 'nothing_incurred';
}

export interface UnattributedRow {
  component: string;
  entryKind: string;
  rowsN: number;
  inr: number | null;
  unpriced: number;
  firstAt: string;
  lastAt: string;
}

export type CostResult =
  | ({ ok: true } & CostSummary)
  | { ok: false; error: string; hint: string };

export interface CostSummary {
  rows: VideoCostRow[];
  unattributed: UnattributedRow[];
  /** The denominator, stated. Null cost when countable === 0. */
  countable: number;
  /**
   * The average, and whether any of it was measured.
   *
   * `basis` is not decoration. A figure built from rate-card estimates is a different claim
   * from one built from what the vendor charged, and a caller that cannot tell them apart
   * will present the first as the second. Today it is always 'estimated'.
   */
  costPerVideoInr: number | null;
  costPerVideoBasis: 'measured' | 'estimated' | 'mixed' | null;
  measuredTotalInr: number | null;
  estimatedTotalInr: number | null;
  committedTotalInr: number | null;
  excluded: { notRendered: number; unpriced: number; nothingIncurred: number };
  unattributedTotalInr: number | null;
  /** True when the ledger has no rows at all — a different fact from everything costing 0. */
  ledgerEmpty: boolean;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export async function readVideoCosts(client?: Db): Promise<CostResult> {
  try {
    return { ok: true, ...(await read(client ?? serverClient())) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      hint: /does not exist|schema cache/i.test(message)
        ? 'v_video_cost is missing, so migration 0026 has not been applied to this database. Run `pnpm doctor`.'
        : 'The read failed. This is not an empty ledger — an empty ledger returns rows: [] and ledgerEmpty: true.',
    };
  }
}

async function read(db: Db): Promise<CostSummary> {
  const [videos, unattr, ledger] = await Promise.all([
    db.from('v_video_cost').select('*').order('created_at', { ascending: false }),
    db.from('v_cost_unattributed').select('*'),
    db.from('cost_ledger').select('id', { count: 'exact', head: true }),
  ]);

  if (videos.error) throw new Error(`v_video_cost: ${videos.error.message}`);
  if (unattr.error) throw new Error(`v_cost_unattributed: ${unattr.error.message}`);

  const rows: VideoCostRow[] = (videos.data ?? []).map((r: Record<string, unknown>) => ({
    scriptId: String(r.script_id),
    conceptId: String(r.concept_id),
    channelId: String(r.channel_id),
    title: String(r.title),
    createdAt: String(r.created_at),
    measuredInr: num(r.measured_inr),
    estimatedInr: num(r.estimated_inr),
    measuredRows: Number(r.measured_rows ?? 0),
    unpricedIncurredRows: Number(r.unpriced_incurred_rows ?? 0),
    committedInr: num(r.committed_inr),
    unpricedCommittedRows: Number(r.unpriced_committed_rows ?? 0),
    ledgerRows: Number(r.ledger_rows ?? 0),
    componentInr: (r.component_inr ?? {}) as VideoCostRow['componentInr'],
    renders: Number(r.renders ?? 0),
    rendersReady: Number(r.renders_ready ?? 0),
    publicationsLive: Number(r.publications_live ?? 0),
    denominatorState: r.denominator_state as VideoCostRow['denominatorState'],
  }));

  const unattributed: UnattributedRow[] = (unattr.data ?? []).map(
    (r: Record<string, unknown>) => ({
      component: String(r.component),
      entryKind: String(r.entry_kind),
      rowsN: Number(r.rows_n ?? 0),
      inr: num(r.inr),
      unpriced: Number(r.unpriced ?? 0),
      firstAt: String(r.first_at),
      lastAt: String(r.last_at),
    }),
  );

  const countableRows = rows.filter(
    (r) => r.denominatorState === 'countable_measured' || r.denominatorState === 'countable_estimated',
  );
  const countableTotal = countableRows.reduce<number>(
    (a, r) => a + (r.measuredInr ?? 0) + (r.estimatedInr ?? 0),
    0,
  );
  const anyMeasured = countableRows.some((r) => r.measuredRows > 0);
  const allMeasured = countableRows.length > 0 && countableRows.every((r) => (r.estimatedInr ?? 0) === 0);

  // A sum over rows with any unknown member is itself unknown. These two totals cover every
  // row on screen, not only the countable ones, so an unpriced row anywhere poisons them —
  // which is the correct behaviour and the reason they are separate from the average.
  const anyUnpricedIncurred = rows.some((r) => r.unpricedIncurredRows > 0);
  const anyUnpricedCommitted = rows.some((r) => r.unpricedCommittedRows > 0);

  return {
    rows,
    unattributed,
    countable: countableRows.length,
    costPerVideoInr:
      countableRows.length === 0
        ? null
        : Math.round((countableTotal / countableRows.length) * 100) / 100,
    costPerVideoBasis:
      countableRows.length === 0 ? null : allMeasured ? 'measured' : anyMeasured ? 'mixed' : 'estimated',
    measuredTotalInr: anyUnpricedIncurred
      ? null
      : rows.reduce<number>((a, r) => a + (r.measuredInr ?? 0), 0),
    estimatedTotalInr: anyUnpricedIncurred
      ? null
      : rows.reduce<number>((a, r) => a + (r.estimatedInr ?? 0), 0),
    committedTotalInr: anyUnpricedCommitted
      ? null
      : rows.reduce<number>((a, r) => a + (r.committedInr ?? 0), 0),
    excluded: {
      notRendered: rows.filter((r) => r.denominatorState === 'not_rendered').length,
      unpriced: rows.filter((r) => r.denominatorState === 'unpriced').length,
      nothingIncurred: rows.filter((r) => r.denominatorState === 'nothing_incurred').length,
    },
    unattributedTotalInr: unattributed.some((u) => u.unpriced > 0)
      ? null
      : unattributed.reduce<number>((a, u) => a + (u.inr ?? 0), 0),
    ledgerEmpty: (ledger.count ?? 0) === 0,
  };
}
