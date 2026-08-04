import type { Db } from '../db/server';
import type { TokenUsage } from '../script/draft';
import { currentRate, type Rate } from './rate-card';

/**
 * Pricing and ledgering an LLM call.
 *
 * Two rows per call, not one. Input and output tokens are priced 5× apart, so a single
 * blended row would fail the ledger's own arithmetic — `quantity × unit_cost` would not
 * equal `cost_usd`, and a ledger whose rows do not multiply out is a ledger nobody can
 * check. Migration 0006 keys them on (script_id, entry_kind, unit) so a retry cannot
 * double-write either of them.
 *
 * ── Why these are written as `reconcile`, not `estimate` ─────────────────────
 *
 * Rule 5 says the row goes in at submit time, before the result comes back, because the
 * headline metric cannot be backfilled. That rule is written for the generation legs,
 * where submit and result are minutes or hours apart and the vendor answers by webhook.
 *
 * A Messages call is synchronous and priced on tokens that do not exist until it returns:
 * there is no honest estimate to write beforehand. The input token count is not knowable
 * without a separate billed count_tokens call, and the output count is not knowable at all.
 * So the row is written immediately on return, in the same task, before anything is done
 * with the script — and it is written as `reconcile` because that is what it is: actual
 * spend, not a forecast.
 *
 * The property rule 5 is actually protecting — that no money moves without a row — holds.
 * The row is written even when the draft failed, because a refusal and a truncation are
 * billed exactly like a success.
 */

const DRIVER = 'anthropic';

export interface LlmLedgerRow {
  unit: 'input_token' | 'output_token';
  quantity: number;
  unitCostUsd: number;
  costUsd: number;
  costInr: number;
  rateId: string;
}

export type LlmPricing =
  | { priced: true; rows: LlmLedgerRow[]; totalUsd: number; totalInr: number; usdInrRate: number }
  | { priced: false; reason: 'no_rate_card_entry' | 'rate_unverified'; detail: string };

function row(unit: LlmLedgerRow['unit'], quantity: number, rate: Rate, usdInrRate: number): LlmLedgerRow {
  const costUsd = quantity * rate.unitCostUsd;
  return {
    unit,
    quantity,
    unitCostUsd: rate.unitCostUsd,
    costUsd,
    costInr: costUsd * usdInrRate,
    rateId: rate.id,
  };
}

/**
 * The arithmetic, with the rates already in hand.
 *
 * Split out from `priceLlmCall` so the sum can be computed anywhere the two rates can be
 * read — including a verification harness that reaches Postgres directly because the REST
 * host is unreachable. The alternative was a second copy of the multiplication in the
 * verification path, which would verify the copy.
 */
export function priceFromRates(q: {
  inputRate: Rate;
  outputRate: Rate;
  usage: TokenUsage;
  usdInrRate: number;
}): Extract<LlmPricing, { priced: true }> {
  const rows = [
    row('input_token', q.usage.inputTokens, q.inputRate, q.usdInrRate),
    row('output_token', q.usage.outputTokens, q.outputRate, q.usdInrRate),
  ];

  return {
    priced: true,
    rows,
    totalUsd: rows.reduce((n, r) => n + r.costUsd, 0),
    totalInr: rows.reduce((n, r) => n + r.costInr, 0),
    usdInrRate: q.usdInrRate,
  };
}

/**
 * Price a completed call. Returns a refusal rather than a zero when either rate is missing
 * or unverified — Addendum 01: unverified means no rupee figure anywhere, and a zero would
 * render as a real cost of nothing.
 */
export async function priceLlmCall(
  db: Db,
  q: { model: string; endpoint: string; usage: TokenUsage; usdInrRate: number },
): Promise<LlmPricing> {
  const [input, output] = await Promise.all([
    currentRate(db, { driver: DRIVER, model: q.model, endpoint: q.endpoint, unit: 'input_token' }),
    currentRate(db, { driver: DRIVER, model: q.model, endpoint: q.endpoint, unit: 'output_token' }),
  ]);

  if (!input.found) return { priced: false, reason: input.reason, detail: input.detail };
  if (!output.found) return { priced: false, reason: output.reason, detail: output.detail };

  return priceFromRates({
    inputRate: input.rate,
    outputRate: output.rate,
    usage: q.usage,
    usdInrRate: q.usdInrRate,
  });
}

/**
 * The ledger rows themselves, as data.
 *
 * Pure, and separate from the write for the same reason the arithmetic is: this is the
 * part worth checking. Which subject each row carries, which key makes a retry idempotent,
 * and whether the numbers multiply out are all decided here, and none of them needs a
 * database to decide.
 */
export function llmCostRows(subject: LlmCostSubject, pricing: Extract<LlmPricing, { priced: true }>) {
  return pricing.rows.map((r) => ({
    driver: DRIVER,
    stage: subject.stage,
    entry_kind: 'reconcile' as const,
    usd_inr_rate: pricing.usdInrRate,
    concept_id: subject.kind === 'channel' || subject.kind === 'studio' ? null : subject.conceptId,
    channel_id: subject.kind === 'channel' ? subject.channelId : null,
    script_id: subject.kind === 'script' ? subject.scriptId : null,
    studio_session_id: subject.kind === 'studio' ? subject.sessionId : null,
    idempotency_key:
      subject.kind === 'script' ? null : `${subject.idempotencyKey}:${r.unit}`,
    unit: r.unit,
    quantity: r.quantity,
    cost_usd: r.costUsd,
    cost_inr: r.costInr,
  }));
}

export type LlmCostSubject =
  | { kind: 'script'; scriptId: string; conceptId: string; stage: PipelineStage }
  | { kind: 'failed_draft'; conceptId: string; idempotencyKey: string; stage: PipelineStage }
  /**
   * A charge that belongs to a set rather than an artifact.
   *
   * Stage 2 proposes N concepts in one call; the concepts do not exist when the call is
   * billed, and once they do the charge belongs to all of them. The channel is what the
   * call is actually about — see migration 0023 and `v_concept_cost`, which divides.
   */
  | { kind: 'channel'; channelId: string; idempotencyKey: string; stage: PipelineStage }
  /**
   * A Studio turn.
   *
   * The fourth subject, and it exists because the Studio lane had its **own** copy of this
   * write — building the rows inline and calling `.upsert(..., { onConflict:
   * 'idempotency_key' })` against a partial unique index. That is the exact defect fixed in
   * `generate/submit.ts` and then again here, in a third place, where it survived precisely
   * because it was a third place. A real session found it: six turns completed, Anthropic
   * billed them, and every ledger row was refused.
   *
   * Deliberately no `script_id`, even once the session materialises one.
   * `cost_ledger_script_stage_entry_key` is unique on
   * `(script_id, coalesce(stage,''), entry_kind, unit)`, so a second turn on a materialised
   * session would collide and be swallowed as a retry — money moving with no row, which is
   * the failure this whole subject exists to prevent. The attribution to a video is made in
   * `v_cost_attributed`, which reaches the script through `studio_sessions.script_id`.
   */
  | { kind: 'studio'; sessionId: string; idempotencyKey: string; stage: 'studio' };

/**
 * Which stage spent the money, matching the `src/trigger/` filename.
 *
 * Part of the ledger's idempotency key (0009), because two stages legitimately charge the
 * same script and the old key rejected the second one. Also what makes cost-per-stage
 * answerable — the first question anyone asks when cost per video is higher than expected.
 */
export type PipelineStage =
  | '01-trends'
  | '02-concept'
  | '03-script'
  | '04-shotlist'
  | '06-voice'
  | '09-metadata';

/**
 * Write the ledger rows for a drafting call.
 *
 * Two shapes, because a billed call does not always produce a script:
 *
 *   succeeded — charged to the script, keyed on (script_id, stage, entry_kind, unit). A
 *               second charge from the same stage against the same script is rejected by
 *               the database; a charge from a *different* stage is not, because that is a
 *               different call. A redraft is a new script version, so it is a new row and a
 *               new charge, which is also correct.
 *
 *   failed    — charged to the concept, keyed on a caller-supplied idempotency key derived
 *               from the task run id. There is no natural key here and there must not be
 *               one by concept: two refusals on the same concept are two real charges.
 *
 * `upsert ... ignoreDuplicates` rather than `insert` so a task-level retry after a partial
 * write lands on the same rows instead of failing. The first write is the true one —
 * overwriting would let a later, differently-priced replay silently restate history.
 */
export async function writeLlmCost(
  db: Db,
  subject: LlmCostSubject,
  pricing: Extract<LlmPricing, { priced: true }>,
): Promise<void> {
  const rows = llmCostRows(subject, pricing);

  // ── Insert, not upsert, and this is a correction ──────────────────────────
  //
  // Both `onConflict` targets this used — `(script_id, stage, entry_kind, unit)` and
  // `(idempotency_key)` — name **partial** unique indexes: `where script_id is not null`
  // and `where idempotency_key is not null`. Postgres refuses to infer a partial index for
  // ON CONFLICT unless the statement repeats its predicate, and supabase-js gives no way to
  // express one. Against a correctly migrated database both fail with "no unique or
  // exclusion constraint matching the ON CONFLICT specification".
  //
  // The same defect was found and fixed in `src/lib/generate/submit.ts` an hour earlier;
  // this is its twin, in a path that has run for real. Whether it ever failed in production
  // could not be settled from here — the harnesses drive a `pg` shim rather than PostgREST,
  // so neither instrument can observe the other's behaviour, and the honest move is to stop
  // depending on the answer.
  //
  // So: insert, and treat a duplicate key as the constraint doing its job on a retry. That
  // works under every client and every index shape, and it is the idiom the rest of this
  // codebase already uses.
  const { error } = await db.from('cost_ledger').insert(rows);

  if (error && /duplicate key|unique constraint/i.test(error.message)) {
    // A retry of a call already charged. The charge stands; there is nothing to do.
    return;
  }

  if (error) {
    // Not swallowed. Money moved and the row did not land, which is the one accounting
    // failure this project cannot tolerate quietly — cost-per-video cannot be backfilled.
    const what =
      subject.kind === 'script'
        ? `script ${subject.scriptId}`
        : subject.kind === 'channel'
          ? `channel ${subject.channelId}`
          : subject.kind === 'studio'
            ? `studio session ${subject.sessionId}`
            : `concept ${subject.conceptId}`;
    throw new Error(
      `Cost ledger write failed for ${what} after the call was billed: ${error.message}`,
    );
  }
}
