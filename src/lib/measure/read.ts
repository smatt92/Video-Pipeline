import { serverClient, type Db } from '../db/server';

import { AGE_BUCKETS, type AgeBucket } from './snapshot';

/**
 * What the /measure screen reads.
 *
 * ── The denominator is the shape of this module ──────────────────────────────
 *
 * The operator's spec put the inverse test first and named the trap: **a metrics screen
 * that looks the same after one video and after a hundred.** This project has now found
 * that shape four times — the costs page, the trends list, the review queue, the Studio
 * list — plus three silent `.limit()` caps.
 *
 * So nothing here returns a bare list of measurements. Every read is anchored on
 * `v_measurement_due`, which has one row per (live publication, bucket) whose clock has
 * passed — what *should* have been measured, captured or not. The row count is the scale,
 * so a screen built on it cannot render identically at two scales, and the outstanding
 * count is work rather than an absence somebody has to notice.
 *
 * ── Every number here can be absent, and absent is not zero ──────────────────
 *
 * `captured_share` is null when nothing is due; `cost_per_1k_inr` is null with a `state`
 * saying which of four reasons; `median_retention_3s_pct` is null when a hook shape has
 * been used and never measured. None of those becomes 0 on the way through this module,
 * and the mappers below are where that would happen if it were going to.
 */

/** `numeric` and `bigint` cross PostgREST as strings. Decided at the boundary, once. */
const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/** For counts, where the range is known safe and absence genuinely means none. */
const count = (v: string | number | null | undefined): number => Number(v ?? 0);

export interface CoverageRow {
  channelId: string;
  due: number;
  captured: number;
  unavailable: number;
  outstanding: number;
  publicationsDue: number;
  publicationsMeasured: number;
  /** Null when nothing is due. Undefined, not 0 — there is no denominator. */
  capturedShare: number | null;
}

export interface DueRow {
  publicationId: string;
  title: string;
  publishedAt: string;
  ageBucket: AgeBucket;
  dueAt: string;
  coverageState: 'outstanding' | 'unavailable' | 'captured';
  views: number | null;
  retention3sPct: number | null;
}

export interface HookRow {
  hookPattern: string;
  videosMeasured: number;
  /** Separate from videosMeasured on purpose: a shape can be used eight times and teach nothing. */
  videosWithRetention: number;
  medianRetention3sPct: number | null;
  worstRetention3sPct: number | null;
  bestRetention3sPct: number | null;
  medianViews: number | null;
}

export interface CostPerKRow {
  publicationId: string;
  title: string;
  publishedAt: string;
  ageBucket: AgeBucket;
  views: number | null;
  costPer1kInr: number | null;
  state: 'countable' | 'not_measured' | 'no_views_yet' | 'cost_unknown';
  costBasis: 'measured' | 'estimated' | 'mixed' | null;
}

export interface MeasureBoard {
  coverage: CoverageRow[];
  due: DueRow[];
  hooks: HookRow[];
  costPerK: CostPerKRow[];
  /**
   * How many live publications exist at all, measured or not.
   *
   * The number the whole screen is scaled against, and it is read from `publications`
   * rather than counted off `due` — a video published an hour ago is live and not yet due
   * for any bucket, so deriving it from the due list would report a channel with three
   * fresh videos as having none. Independent route, on purpose: the two sides of "is this
   * screen showing everything" must not both come from the same view.
   */
  publicationsLive: number;
  /** Live publications whose scripts carry no hook pattern, so no rollup can see them. */
  unclassifiedHooks: number;
  /** Of those, the ones no classifier has ever run on — a backfill, not a taxonomy gap. */
  neverClassifiedHooks: number;
  /** Reads that failed, named. A screen must not render an error as an empty state. */
  unreadable: string[];
}

/** Which bucket the screen's headline numbers use. 6h and 24h still move; 30d is the tail. */
export const HEADLINE_BUCKET: AgeBucket = '7d';

export async function readMeasureBoard(client?: Db): Promise<MeasureBoard> {
  const db = client ?? serverClient();
  const unreadable: string[] = [];

  const [coverage, due, hooks, costPerK, live, unclassified] = await Promise.all([
    db.from('v_measurement_coverage').select('*'),
    db
      .from('v_measurement_due')
      .select('publication_id, title, published_at, age_bucket, due_at, coverage_state, views, retention_3s_pct')
      .order('due_at', { ascending: false }),
    db.from('v_hook_performance').select('*'),
    db
      .from('v_cost_per_1k_views')
      .select('publication_id, title, published_at, age_bucket, views, cost_per_1k_inr, state, cost_basis')
      .eq('age_bucket', HEADLINE_BUCKET)
      .order('published_at', { ascending: false }),
    db.from('publications').select('id', { count: 'exact', head: true }).eq('status', 'live'),
    // The videos the hook rollup cannot see. Read rather than inferred from `hooks`: a
    // script whose hook classified to null is absent from every row of
    // v_hook_performance, not under-counted in one, so nothing in that result set can
    // reveal it. Without this the rollup reads as complete over a sample it narrowed.
    db.from('v_hook_unclassified').select('publication_id, hook_pattern_version'),
  ]);

  // A failed read is named, never rendered as an empty result. `v_measurement_coverage`
  // returning nothing because the migration has not been applied and returning nothing
  // because no video is due are the same JSON and opposite facts.
  for (const [name, res] of [
    ['v_measurement_coverage', coverage],
    ['v_measurement_due', due],
    ['v_hook_performance', hooks],
    ['v_cost_per_1k_views', costPerK],
    ['publications', live],
    ['v_hook_unclassified', unclassified],
  ] as const) {
    if (res.error) unreadable.push(`${name}: ${res.error.message}`);
  }

  return {
    coverage: (coverage.data ?? []).map((r) => ({
      channelId: r.channel_id as string,
      due: count(r.due),
      captured: count(r.captured),
      unavailable: count(r.unavailable),
      outstanding: count(r.outstanding),
      publicationsDue: count(r.publications_due),
      publicationsMeasured: count(r.publications_measured),
      capturedShare: num(r.captured_share),
    })),
    due: (due.data ?? []).map((r) => ({
      publicationId: r.publication_id as string,
      title: r.title as string,
      publishedAt: r.published_at as string,
      ageBucket: r.age_bucket as AgeBucket,
      dueAt: r.due_at as string,
      coverageState: r.coverage_state as DueRow['coverageState'],
      views: num(r.views),
      retention3sPct: num(r.retention_3s_pct),
    })),
    hooks: (hooks.data ?? []).map((r) => ({
      hookPattern: r.hook_pattern as string,
      videosMeasured: count(r.videos_measured),
      videosWithRetention: count(r.videos_with_retention),
      medianRetention3sPct: num(r.median_retention_3s_pct),
      worstRetention3sPct: num(r.worst_retention_3s_pct),
      bestRetention3sPct: num(r.best_retention_3s_pct),
      medianViews: num(r.median_views),
    })),
    costPerK: (costPerK.data ?? []).map((r) => ({
      publicationId: r.publication_id as string,
      title: r.title as string,
      publishedAt: r.published_at as string,
      ageBucket: r.age_bucket as AgeBucket,
      views: num(r.views),
      costPer1kInr: num(r.cost_per_1k_inr),
      state: r.state as CostPerKRow['state'],
      costBasis: r.cost_basis as CostPerKRow['costBasis'],
    })),
    publicationsLive: live.count ?? 0,
    unclassifiedHooks: (unclassified.data ?? []).length,
    // Never classified at all, as opposed to classified and unrecognised. A backfill fixes
    // the first; only a better taxonomy fixes the second, and a single total would send
    // somebody to do the wrong one.
    neverClassifiedHooks: (unclassified.data ?? []).filter(
      (r) => r.hook_pattern_version === null,
    ).length,
    unreadable,
  };
}

/** The buckets, in age order, for a form that has to offer all four. */
export const BUCKETS_IN_ORDER: readonly AgeBucket[] = AGE_BUCKETS;
