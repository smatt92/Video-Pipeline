import type { Db } from '../db/server';

/**
 * Rate card lookups.
 *
 * The rule this serves is CLAUDE.md 5: every external call that costs money writes a
 * `cost_ledger` row *at submit time*, before the result exists. The corollary, from
 * Addendum 01, is that an unverified rate produces no rupee figure anywhere and the submit
 * refuses — a number that is internally consistent and externally meaningless is worse
 * than no number, because it gets quoted.
 *
 * A rate is identified by (driver, model, endpoint, unit) and superseded by inserting a
 * row with a later `effective_from`, never by UPDATE. The ledger snapshots the unit cost
 * onto every row it writes, so rewriting a rate would leave historical rupee figures
 * unexplainable — which is precisely what makes cost-per-video defensible in the first
 * place.
 */

export interface Rate {
  id: string;
  driver: string;
  model: string;
  endpoint: string | null;
  unit: string;
  unitCostUsd: number;
  isVerified: boolean;
  sourceNote: string | null;
  effectiveFrom: string;
}

export type RateLookup =
  | { found: true; rate: Rate }
  | { found: false; reason: 'no_rate_card_entry' | 'rate_unverified'; detail: string };

/**
 * The rate in force for this call, at this moment.
 *
 * Ordered by `effective_from` descending and limited to one, which is only deterministic
 * because 0002 (and 0006, which added `unit`) key the table uniquely on
 * (driver, model, endpoint, unit, effective_from). Without that key two rows could match
 * and the cost written would depend on scan order.
 */
export async function currentRate(
  db: Db,
  q: { driver: string; model: string; endpoint: string | null; unit: string; at?: Date },
): Promise<RateLookup> {
  const at = (q.at ?? new Date()).toISOString();

  let query = db
    .from('rate_card')
    .select('id, driver, model, endpoint, unit, unit_cost, is_verified, source_note, effective_from')
    .eq('driver', q.driver)
    .eq('model', q.model)
    .eq('unit', q.unit)
    .lte('effective_from', at)
    .order('effective_from', { ascending: false })
    .limit(1);

  // `.is(null)` and `.eq(value)` are different operators in PostgREST; a null endpoint
  // matched with eq silently returns nothing.
  query = q.endpoint === null ? query.is('endpoint', null) : query.eq('endpoint', q.endpoint);

  const { data, error } = await query.maybeSingle();

  const what = `${q.driver}/${q.model}${q.endpoint ? ` ${q.endpoint}` : ''} per ${q.unit}`;

  if (error) {
    return { found: false, reason: 'no_rate_card_entry', detail: `${what}: ${error.message}` };
  }
  if (!data) {
    return {
      found: false,
      reason: 'no_rate_card_entry',
      detail: `${what}: no rate card row effective on or before ${at}`,
    };
  }

  const rate: Rate = {
    id: data.id,
    driver: data.driver,
    model: data.model,
    endpoint: data.endpoint,
    unit: data.unit,
    unitCostUsd: Number(data.unit_cost),
    isVerified: data.is_verified,
    sourceNote: data.source_note,
    effectiveFrom: data.effective_from,
  };

  if (!rate.isVerified) {
    return {
      found: false,
      reason: 'rate_unverified',
      detail:
        `${what}: the rate card row exists but is not verified` +
        (rate.sourceNote ? ` (${rate.sourceNote})` : '') +
        '. Nothing prices against a guess.',
    };
  }

  return { found: true, rate };
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading the whole card, for the screen
// ═════════════════════════════════════════════════════════════════════════════

export interface RateCardRow {
  readonly id: string;
  readonly driver: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly unit: string;
  readonly unitCost: number;
  readonly currency: string;
  readonly isVerified: boolean;
  readonly sourceNote: string | null;
  readonly effectiveFrom: string;
  /** How many superseded rows sit behind this one. Zero on a rate never edited. */
  readonly revisions: number;
}

export type RateCardResult =
  | { ok: true; rows: RateCardRow[] }
  | { ok: false; error: string; hint: string };

/**
 * Every rate currently in effect, newest `effective_from` per key.
 *
 * ── Three outcomes, never two ────────────────────────────────────────────────
 *
 * Rows, empty, or broken — the same rule the board follows, and for the same reason. This
 * screen decides whether any paid stage may run; a blank one that could mean "no rates
 * seeded" or "the query failed" makes the second case invisible until somebody
 * independently suspects it.
 *
 * ── Superseded rows are counted, not hidden ──────────────────────────────────
 *
 * `currentRate` reads the latest `effective_from` at or before now, so a correction is an
 * append rather than an edit. That is what keeps a six-month-old cost figure explainable —
 * the row that priced it is still there. The count is surfaced because a rate revised four
 * times is a rate somebody is struggling to pin down, and that is worth seeing.
 */
export async function readRateCard(db: Db): Promise<RateCardResult> {
  const { data, error } = await db
    .from('rate_card')
    .select('id, driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from')
    .order('effective_from', { ascending: false });

  if (error) {
    return {
      ok: false,
      error: error.message,
      hint: /does not exist|schema cache/i.test(error.message)
        ? 'The rate_card table is missing, which means the migrations have not been applied to this database. Run `pnpm db:doctor`.'
        : 'The query itself failed. This is not an empty rate card — something is wrong with the read.',
    };
  }

  const seen = new Map<string, RateCardRow>();
  const superseded = new Map<string, number>();

  for (const r of data ?? []) {
    const key = `${r.driver}|${r.model}|${r.endpoint ?? ''}|${r.unit}`;
    if (seen.has(key)) {
      superseded.set(key, (superseded.get(key) ?? 0) + 1);
      continue;
    }
    seen.set(key, {
      id: r.id,
      driver: r.driver,
      model: r.model,
      endpoint: r.endpoint,
      unit: r.unit,
      unitCost: Number(r.unit_cost),
      currency: r.currency,
      isVerified: r.is_verified,
      sourceNote: r.source_note,
      effectiveFrom: r.effective_from,
      revisions: 0,
    });
  }

  const rows = [...seen.entries()]
    .map(([key, row]) => ({ ...row, revisions: superseded.get(key) ?? 0 }))
    // Unverified first: they are the ones stopping a stage from running.
    .sort((a, b) =>
      a.isVerified === b.isVerified
        ? a.driver.localeCompare(b.driver) || a.model.localeCompare(b.model)
        : a.isVerified
          ? 1
          : -1,
    );

  return { ok: true, rows };
}
