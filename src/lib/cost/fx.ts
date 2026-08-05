import { env, requireEnv } from '../env';

/**
 * The USD→INR rate, at the one moment it matters.
 *
 * ── Why this is not a default ────────────────────────────────────────────────
 *
 * `USD_INR_RATE` used to carry `.default(88.5)` in the schema. Nothing refused without it,
 * which sounds like resilience and is the opposite: six tasks passed `env.USD_INR_RATE`
 * straight into `cost_ledger`, so a deployment that never set the variable snapshotted a
 * rate **nobody chose** onto every money row, and `/costs` then presented a rupee figure
 * this project invented as though it were the rate in force when the money moved.
 *
 * Nothing downstream could tell that figure from a real one. That is the difficulty: a
 * missing measurement rendered as a plausible number is silently believed, summed, and
 * acted on. It is the same defect as `?? 0` on a duration, sitting in the input to the
 * metric rule 5 calls the project's headline.
 *
 * ── Why required here and not at boot ────────────────────────────────────────
 *
 * A worker that never touches money should not fail to start, and the onboarding wizard
 * that configures everything else must be able to run on a deployment that has configured
 * nothing. That is the whole reason `src/lib/env.ts` made most of the schema optional —
 * requiring this at boot would re-create the chicken-and-egg deadlock that file documents
 * at length.
 *
 * So the rate is optional at boot and required at the point a rupee figure is produced,
 * which is exactly the contract `requireEnv` exists for. Same reasoning as
 * `unit_cost_snapshot`: the figure is protected where the figure is made.
 *
 * ── Two functions, because refusing and reporting are different jobs ─────────
 *
 * A path that is about to write a ledger row must refuse. A path that is about to *show*
 * an estimate must be able to say "I cannot tell you", because a screen that throws tells
 * the operator less than a screen that names what is unconfigured. Both are honest; only
 * a fabricated number is not.
 */

/**
 * The rate, or null when it is not configured.
 *
 * For display and pre-flight paths that must degrade into naming the problem. `null` here
 * means **absent**, never zero — a zero rate would price every call at ₹0.00 and render as
 * a real cost of nothing.
 */
export function readUsdInrRate(): number | null {
  return env.USD_INR_RATE ?? null;
}

/**
 * The rate, or a refusal naming what wanted it.
 *
 * For every path that writes a `cost_ledger` row. `wantedBy` becomes part of the message,
 * so the failure names the operation rather than the variable alone.
 */
export function requireUsdInrRate(wantedBy: string): number {
  return requireEnv('USD_INR_RATE', wantedBy);
}
