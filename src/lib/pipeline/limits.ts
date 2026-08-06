import 'server-only';

import { serverClient, type Db } from '../db/server';

/**
 * The limits you hit unexpectedly, and the credit clock.
 *
 * ── The inverse test, applied to both before either was written ──────────────
 *
 * **The limits block.** Its obvious shape is a gauge: usage over ceiling, with a reset
 * countdown. Two of those three are not available, and building them anyway is how a
 * fabricated figure reaches the screen an operator checks daily.
 *
 *  · *Usage* — `in_flight` is real and observed, and it is 0 on a workspace that has never
 *    generated and stays 0 for ever. A card built on it alone renders identically after one
 *    video and after a hundred, which is exactly the trap. What survives the test is the
 *    retrospective half: how often the vendor has actually refused us, and when last. "You
 *    hit this ceiling fourteen times yesterday" is the answer to the hour spent diagnosing.
 *
 *  · *Reset* — a concurrency ceiling has no reset. It is not a window, and a countdown next
 *    to it would be a fiction. Windowed quotas do reset, and this codebase has none it can
 *    observe (see `QUOTAS` below), so no countdown is rendered anywhere. An absent clock is
 *    better than a wrong one.
 *
 *  · *Ceiling* — null for every driver right now, because `concurrency_limit` is read from
 *    the account at verification and nothing has verified. Null renders as "unknown", never
 *    as a guess: a guess above the real ceiling produces a permanent failure rate that
 *    reads as vendor flakiness rather than as our own setting.
 *
 * **The credit card.** Its obvious shape is a balance. There is no balance:
 * `generations.credits_spent` has no writer anywhere in `src/`, so "remaining" would be the
 * purchase total, unchanged for ever, presented as though it moved. That is the
 * absent-versus-zero rule in its most expensive form — not a missing measurement rendered
 * as zero, but a stale constant rendered as a live figure.
 *
 * What is fully answerable today is the expiry clock, and it is the part that matters
 * daily: credits die about 90 days after purchase whether or not anything used them, and
 * nothing is billed at the moment they evaporate — so the cost ledger structurally cannot
 * see the loss. That is why this belongs on the board rather than only in settings.
 */

/**
 * Windowed quotas — the first limit on this card with a real numerator.
 *
 * This used to be an empty constant with a comment saying it would be filled in "on the
 * day `src/lib/publish/` calls the API". Migration 0035 is that day, and the shape it
 * arrived in is not the shape that was reserved for it — which is worth stating, because
 * the reserved shape would have been wrong.
 *
 * A `readonly [{slug, label, window, ceiling}]` constant would have declared four vendors'
 * published ceilings and had nothing to divide them by. What makes this quota showable is
 * not that the ceiling is known — every ceiling in `observability.ts` is known — but that
 * **consumption is observed**: we make each call, each price is published, and
 * `api_quota_usage` has a row for every one. So the numerator comes from the database and
 * there is no constant here at all.
 *
 * `quotaSource` travels with it and must be rendered. The consumption is observed; the
 * ceiling is the vendor's documented claim until a refusal makes it otherwise, and a
 * remaining figure built on an assumed ceiling is honest only while it says which half is
 * which.
 */
export interface QuotaLimit {
  slug: string;
  ceiling: number;
  /** 'documented' until a 403 makes it observable. Never omit this from a surface. */
  ceilingSource: string;
  unitsUsed: number;
  unitsWasted: number;
  unitsRemaining: number;
  callsMade: number;
  windowResetsAt: string;
}

export type LimitKind = 'concurrency' | 'quota';

export interface DriverLimit {
  slug: string;
  kind: string;
  limitKind: LimitKind;
  isVerified: boolean;
  /** Null means unknown. Never render a guess. */
  ceiling: number | null;
  /** 'default' when the number is our fallback rather than the account's answer. */
  ceilingSource: string;
  /** Observed and live. Meaningful only alongside the hit counts. */
  inFlight: number;
  /** Counted apart on purpose: one wants a queue, the other backoff. */
  hitsConcurrency: number;
  hitsRate: number;
  hitsCredits: number;
  lastHitAt: string | null;
  submitsTotal: number;
  /** False when nothing has ever been submitted to this driver — not "never limited". */
  hasSubmitted: boolean;
}

export interface CreditPosition {
  slug: string;
  purchases: number;
  creditsUnexpired: number;
  creditsExpired: number;
  creditsExpiring30d: number;
  nextExpiry: string | null;
  daysUntilExpiry: number | null;
  lastPurchaseAt: string | null;
  amountUsd: number | null;
  /**
   * False when no generation carries a credit figure. When false, `remaining` is unknown
   * and must not be shown as `creditsUnexpired` — the purchase total is not a balance.
   */
  consumptionObserved: boolean;
  creditsSpent: number | null;
}

export type LimitsResult =
  | {
      ok: true;
      limits: DriverLimit[];
      /** Empty when no integration declares one — not "zero remaining". */
      quotas: QuotaLimit[];
      credits: CreditPosition[];
      /** True when no purchase row exists at all — different from having spent everything. */
      noPurchases: boolean;
    }
  | { ok: false; error: string; hint: string };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function readLimits(client?: Db): Promise<LimitsResult> {
  const db = client ?? serverClient();

  const [limitRows, creditRows, quotaRows] = await Promise.all([
    db.from('v_driver_limits').select('*'),
    db.from('v_credit_position').select('*').in('kind', ['video', 'audio']),
    db.from('v_api_quota').select('*'),
  ]);

  const err = limitRows.error ?? creditRows.error ?? quotaRows.error;
  if (err) {
    return {
      ok: false,
      error: err.message,
      hint: /does not exist|schema cache/i.test(err.message)
        ? 'v_driver_limits is missing, so migration 0031 has not been applied. Run `pnpm db:doctor`.'
        : 'The read failed. This is not an idle pipeline — an idle one returns rows with inFlight 0 and hasSubmitted false.',
    };
  }

  const limits: DriverLimit[] = (limitRows.data ?? []).map((r: Record<string, unknown>) => ({
    slug: String(r.slug),
    kind: String(r.kind),
    limitKind: 'concurrency',
    isVerified: Boolean(r.is_verified),
    ceiling: num(r.concurrency_limit),
    ceilingSource: String(r.concurrency_source ?? 'default'),
    inFlight: Number(r.in_flight ?? 0),
    hitsConcurrency: Number(r.hits_concurrency ?? 0),
    hitsRate: Number(r.hits_rate ?? 0),
    hitsCredits: Number(r.hits_credits ?? 0),
    lastHitAt: r.last_hit_at ? String(r.last_hit_at) : null,
    submitsTotal: Number(r.submits_total ?? 0),
    hasSubmitted: Number(r.submits_total ?? 0) > 0,
  }));

  const credits: CreditPosition[] = (creditRows.data ?? []).map(
    (r: Record<string, unknown>) => ({
      slug: String(r.slug),
      purchases: Number(r.purchases ?? 0),
      creditsUnexpired: Number(r.credits_unexpired ?? 0),
      creditsExpired: Number(r.credits_expired ?? 0),
      creditsExpiring30d: Number(r.credits_expiring_30d ?? 0),
      nextExpiry: r.next_expiry ? String(r.next_expiry) : null,
      daysUntilExpiry: num(r.days_until_expiry),
      lastPurchaseAt: r.last_purchase_at ? String(r.last_purchase_at) : null,
      amountUsd: num(r.amount_usd),
      consumptionObserved: Number(r.credits_recorded ?? 0) > 0,
      creditsSpent: Number(r.credits_recorded ?? 0) > 0 ? num(r.credits_spent_total) : null,
    }),
  );

  const quotas: QuotaLimit[] = (quotaRows.data ?? []).map((r: Record<string, unknown>) => ({
    slug: String(r.slug),
    ceiling: Number(r.daily_quota_units),
    ceilingSource: String(r.quota_source),
    unitsUsed: Number(r.units_used ?? 0),
    unitsWasted: Number(r.units_wasted ?? 0),
    unitsRemaining: Number(r.units_remaining ?? 0),
    callsMade: Number(r.calls_made ?? 0),
    windowResetsAt: String(r.window_resets_at),
  }));

  return {
    ok: true,
    limits,
    quotas,
    credits,
    noPurchases: credits.every((c) => c.purchases === 0),
  };
}

/**
 * The soonest expiry across every driver, which is the one number the board needs.
 *
 * Null when nothing is unexpired — and that is two different situations the caller has to
 * tell apart, which is why `noPurchases` exists beside it: nothing bought yet, versus
 * everything bought has already expired. The second is money already lost.
 */
export function soonestExpiry(credits: CreditPosition[]): CreditPosition | null {
  const withClock = credits.filter((c) => c.daysUntilExpiry !== null);
  if (withClock.length === 0) return null;
  return withClock.reduce((a, b) => (a.daysUntilExpiry! <= b.daysUntilExpiry! ? a : b));
}
