import type { Db } from '../db/server';

/**
 * The USD→INR rate, read from the workspace, at the one moment it matters.
 *
 * ── There is exactly one rate, and it is `profiles.usd_inr_rate` ─────────────
 *
 * This used to read `USD_INR_RATE` from the environment. That variable no longer exists —
 * not deprecated, removed — because two configured rates is how the defect below happened
 * and a loser that keeps existing is a loser that gets used.
 *
 * The rate is an **operational value, not a deployment constant**. The wizard's own copy
 * says it is snapshotted onto each cost row so that changing it later does not rewrite
 * history, which is a description of something the operator sets and changes — and changing
 * it must not require a redeploy, which the environment variable always did. Migration 0005
 * said the same thing in the column comment from the day the column existed: *"after that
 * this is the truth"*. Only the code disagreed.
 *
 * It disagreed for months. `profiles.usd_inr_rate` was written by onboarding step 1 and read
 * by **nothing** on the pricing path; every ledger row took its rate from the environment,
 * which defaulted to 88.5. So an operator who set the rate in the form had configured
 * nothing, and a deployment that set no variable priced every row at a number nobody chose.
 * Both halves of that are now gone.
 *
 * ── Absent is a refusal with a name, never a fallback ────────────────────────
 *
 * No profile row, or a null rate, means the rupee figure is **unknown**. Not zero, not 88.5,
 * not the last one we saw. The same rule the rate card follows: an unverified rate produces
 * no rupee figure anywhere rather than a plausible one. A fallback here would reintroduce
 * exactly the defect being removed, one layer down and harder to see.
 *
 * ── Two disagreeing profiles is also a refusal ───────────────────────────────
 *
 * Phase 1 has one operator, so in practice there is one row. If there are ever two carrying
 * different rates, this refuses rather than picking — silently choosing one would make every
 * rupee figure in the product depend on row order.
 */

export type FxRate =
  | { ok: true; rate: number }
  | { ok: false; reason: string; remedy: string };

/**
 * The rate, or a named refusal.
 *
 * For display and pre-flight paths, which must be able to say "I cannot tell you" rather
 * than throw — a screen that names what is unconfigured tells the operator more than one
 * that errors.
 */
export async function readUsdInrRate(db: Db): Promise<FxRate> {
  const { data, error } = await db
    .from('profiles')
    .select('usd_inr_rate')
    .not('usd_inr_rate', 'is', null);

  if (error) {
    return {
      ok: false,
      reason: `Could not read the workspace's USD→INR rate: ${error.message}`,
      remedy: 'This is a database fault rather than a configuration one — check the connection.',
    };
  }

  // `numeric` crosses the wire as a string, because Postgres will not silently lose
  // precision on your behalf. `Number()` here is a decision rather than a conversion: an FX
  // rate is a small decimal well inside what a double holds exactly, so the loss is
  // accepted knowingly. A bigint id in this position would have to stay a string.
  const rates = [...new Set((data ?? []).map((r) => Number(r.usd_inr_rate)))].filter(
    (n) => Number.isFinite(n) && n > 0,
  );

  if (rates.length === 0) {
    return {
      ok: false,
      reason:
        'No USD→INR rate is set for this workspace, so nothing can be priced in rupees. '
        + 'This is unknown, not zero — a default here would put a rate nobody chose onto '
        + 'every money row, indistinguishable from one somebody did.',
      remedy: 'Settings → Workspace, or onboarding step 1, sets the rate.',
    };
  }

  if (rates.length > 1) {
    return {
      ok: false,
      reason:
        `${rates.length} profiles carry different USD→INR rates (${rates.join(', ')}), so `
        + 'there is no single answer to what a rupee figure means here.',
      remedy: 'Make them agree in Settings → Workspace. Refusing beats picking by row order.',
    };
  }

  return { ok: true, rate: rates[0] };
}

/**
 * The rate, or a thrown refusal naming what wanted it.
 *
 * For every path that writes a `cost_ledger` row. `wantedBy` becomes part of the message, so
 * the failure names the operation rather than the setting alone.
 */
export async function requireUsdInrRate(db: Db, wantedBy: string): Promise<number> {
  const result = await readUsdInrRate(db);
  if (result.ok) return result.rate;

  throw new Error(
    `${result.reason}\n\n${wantedBy} cannot proceed without it. ${result.remedy}`,
  );
}
