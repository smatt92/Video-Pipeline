import { z } from 'zod';

import type { Db } from '../db/server';

/**
 * Stage 11 — recording what a published video actually did.
 *
 * ── Where the numbers come from in Phase 1 ───────────────────────────────────
 *
 * A person, typing. CLAUDE.md's Current phase says publishing is manual — download the
 * file, copy the metadata, upload it yourself — and measurement is manual for the same
 * reason: there is no verified analytics integration and there will not be one until
 * stage 10 lands a credential worth reading from.
 *
 * That is why `metric_source` exists rather than being assumed. `manual_entry` is the only
 * value anything writes today; `vendor_api` is written the day a fetch does. A screen that
 * shows the two identically is the fabricated-measurement trap in a second place, and the
 * fix there was this same column on `cost_ledger`.
 *
 * ── The whole job of this module is refusing to write a number nobody has ────
 *
 * `metrics_snapshots` has CHECKs (migration 0034) that make an unavailable row empty and a
 * measured row carry views. Those catch a bad write; they cannot tell the caller *why* in
 * words a person can act on, and they fire after the form has been filled in. So the same
 * predicate lives here, first, and the CHECKs are the backstop rather than the interface.
 *
 * The specific mistake being prevented: typing `0` into the retention field because the
 * platform did not show one. Zero retention is the strongest claim this table can make
 * about a hook — nobody made it past three seconds — and it is indistinguishable
 * afterwards from a real measurement of a genuinely terrible hook. Leaving it blank says
 * "withheld", which is what happened.
 */

export const AGE_BUCKETS = ['6h', '24h', '7d', '30d'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/**
 * Empty string → null, before anything else looks at it.
 *
 * An HTML number input that a person left alone yields `''`, and `Number('')` is `0`. That
 * single coercion is the whole failure this module exists to prevent, so it is handled
 * once, at the outermost edge, rather than trusted to every caller.
 */
const OptionalNumber = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  z.coerce.number().nullable(),
);

const Counts = {
  views: OptionalNumber.pipe(z.number().int().min(0).nullable()),
  likes: OptionalNumber.pipe(z.number().int().min(0).nullable()),
  comments: OptionalNumber.pipe(z.number().int().min(0).nullable()),
  shares: OptionalNumber.pipe(z.number().int().min(0).nullable()),
  saves: OptionalNumber.pipe(z.number().int().min(0).nullable()),
  // 0–100, matching the column's CHECK and its `_pct` name. A vendor's 0–1 ratio must be
  // multiplied by the caller; this refuses rather than silently accepting 0.87 as 0.87%,
  // which would read as a catastrophic hook and be within range.
  avgViewPct: OptionalNumber.pipe(z.number().min(0).max(100).nullable()),
  retention3sPct: OptionalNumber.pipe(z.number().min(0).max(100).nullable()),
};

export const SnapshotInputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('measured'),
    publicationId: z.uuid(),
    ageBucket: z.enum(AGE_BUCKETS),
    metricSource: z.enum(['manual_entry', 'vendor_api']),
    enteredBy: z.uuid().nullable().default(null),
    ...Counts,
  }),
  z.object({
    status: z.literal('unavailable'),
    publicationId: z.uuid(),
    ageBucket: z.enum(AGE_BUCKETS),
    metricSource: z.enum(['manual_entry', 'vendor_api']),
    enteredBy: z.uuid().nullable().default(null),
    // Required, and not defaulted. "Unavailable" with no reason is a row that records that
    // somebody gave up, which is exactly as useful as no row at all.
    unavailableReason: z.string().trim().min(1),
  }),
]);

export type SnapshotInput = z.input<typeof SnapshotInputSchema>;

export type SnapshotResult =
  | { ok: true; snapshotId: string; replaced: boolean }
  | { ok: false; code: string; detail: string };

export async function recordSnapshot(db: Db, raw: unknown): Promise<SnapshotResult> {
  const parsed = SnapshotInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_input',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  const input = parsed.data;

  // ── views is the denominator, so its absence is a refusal, not a null ──────
  //
  // Every consumer divides by it: cost per 1k, the coverage share, the hook rollup's
  // weighting. A measured row without views is an unavailable row that has not admitted
  // it, and the difference is invisible one join later.
  if (input.status === 'measured' && input.views === null) {
    return {
      ok: false,
      code: 'measured_without_views',
      detail:
        'A measured snapshot must carry a view count — it is the denominator of every '
        + 'number derived from this row. If the platform showed nothing, record the bucket '
        + 'as unavailable with the reason; that is a different fact from zero views and '
        + 'the two must not land in the same shape.',
    };
  }

  // ── The publication must be live and have a published_at ──────────────────
  //
  // Not decoration: `v_measurement_due` computes the bucket's due date from
  // `published_at`, so a snapshot against a publication without one is a measurement of a
  // video whose clock has not started. It would be stored, would never appear as due, and
  // would be counted as coverage of nothing.
  const { data: pub, error: pubErr } = await db
    .from('publications')
    .select('id, status, published_at')
    .eq('id', input.publicationId)
    .maybeSingle();

  if (pubErr) {
    return { ok: false, code: 'publication_unreadable', detail: pubErr.message };
  }
  if (!pub) {
    return {
      ok: false,
      code: 'no_such_publication',
      detail: `No publication ${input.publicationId}. A snapshot belongs to something published.`,
    };
  }
  if (pub.status !== 'live' || pub.published_at === null) {
    return {
      ok: false,
      code: 'not_published',
      detail:
        `Publication ${input.publicationId} is "${pub.status}"`
        + `${pub.published_at === null ? ' and has no published_at' : ''}. `
        + 'Measurement buckets are ages, and an unpublished video has no age — this row '
        + 'would never be due and would count as coverage of nothing.',
    };
  }

  // ── Replay: the same bucket, looked at again ──────────────────────────────
  //
  // The common case is a bucket that was unavailable and now is not, and it must upsert
  // rather than fail: a stage this project can replay from any prior stage's output is a
  // stage whose second run has to mean something. `captured_at` is deliberately left alone
  // by the update — first look and latest look are different facts, the same arrangement
  // `webhook_received_at` and `webhook_last_received_at` have carried since 0015.
  const { data: existing } = await db
    .from('metrics_snapshots')
    .select('id')
    .eq('publication_id', input.publicationId)
    .eq('age_bucket', input.ageBucket)
    .maybeSingle();

  // One object with every column named, rather than two shapes chosen between.
  //
  // Every metric is written explicitly, including on the unavailable branch where they are
  // all null. On an UPDATE an omitted column keeps whatever was there — so a bucket that
  // was measured and is now unavailable would keep its old numbers beside a status saying
  // there are none. The CHECK would catch it, and would report a constraint name rather
  // than the mistake, one layer away from the code that made it.
  const row = {
    publication_id: input.publicationId,
    age_bucket: input.ageBucket,
    status: input.status,
    unavailable_reason: input.status === 'unavailable' ? input.unavailableReason : null,
    metric_source: input.metricSource,
    entered_by: input.enteredBy,
    views: input.status === 'measured' ? input.views : null,
    likes: input.status === 'measured' ? input.likes : null,
    comments: input.status === 'measured' ? input.comments : null,
    shares: input.status === 'measured' ? input.shares : null,
    saves: input.status === 'measured' ? input.saves : null,
    avg_view_pct: input.status === 'measured' ? input.avgViewPct : null,
    retention_3s_pct: input.status === 'measured' ? input.retention3sPct : null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await db
      .from('metrics_snapshots')
      .update(row)
      .eq('id', existing.id)
      .select('id')
      .single();
    if (error) return { ok: false, code: 'update_failed', detail: error.message };
    return { ok: true, snapshotId: data.id, replaced: true };
  }

  const { data, error } = await db
    .from('metrics_snapshots')
    .insert(row)
    .select('id')
    .single();
  if (error) return { ok: false, code: 'insert_failed', detail: error.message };
  return { ok: true, snapshotId: data.id, replaced: false };
}
