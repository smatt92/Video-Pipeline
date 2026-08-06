import type { Db } from '../db/server';

import { QUOTA_UNITS, type QuotaEndpoint } from './youtube';

/**
 * Quota accounting — the first countdown on the limits card with a real numerator.
 *
 * ── Why this one is allowed to show a number when the others are not ─────────
 *
 * `src/lib/pipeline/observability.ts` is the register of figures a screen must withhold,
 * and every vendor limit in it is withheld for one reason: the vendor publishes no counter,
 * so our consumption is unobservable and a countdown would be invented. This quota breaks
 * that pattern because **we make every call and each call's price is a published
 * constant** — consumption is something we already know, because we did it. Counting our
 * own actions is not a measurement of theirs.
 *
 * The ceiling is a different matter and stays labelled: 10,000/day is Google's documented
 * figure and nobody here has watched it hold. `integrations.quota_source` carries that, and
 * every surface showing `unitsRemaining` must show the source beside it.
 *
 * ── Written before the call, not after ───────────────────────────────────────
 *
 * Rule 5's shape, for units instead of rupees. A process that dies between spending and
 * recording leaves the remaining figure over-reporting for the rest of the window, and the
 * window is a day. `spend()` therefore returns the row id and the caller settles the
 * outcome afterwards — the units are already committed by then and settling only records
 * whether anything came of them.
 */

export interface QuotaWindow {
  integrationId: string;
  slug: string;
  dailyQuotaUnits: number;
  /** 'documented' until a refusal makes it observable. Never hide this on a screen. */
  quotaSource: 'documented' | 'observed';
  windowStartedAt: string;
  windowResetsAt: string;
  unitsUsed: number;
  unitsWasted: number;
  unitsRemaining: number;
  callsMade: number;
}

export type QuotaRead =
  | { ok: true; window: QuotaWindow }
  /** No integration declares a quota. Not zero remaining — no quota is being counted. */
  | { ok: false; code: 'no_quota_declared' | 'unreadable'; detail: string };

export async function readQuota(db: Db, slug: string): Promise<QuotaRead> {
  const { data, error } = await db
    .from('v_api_quota')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) return { ok: false, code: 'unreadable', detail: error.message };
  if (!data) {
    return {
      ok: false,
      code: 'no_quota_declared',
      detail:
        `No row in v_api_quota for "${slug}". That means no daily_quota_units is set on the `
        + 'integration — which is "we are not counting a quota for this vendor", not "zero '
        + 'units remain". A caller must not read it as a refusal.',
    };
  }

  return {
    ok: true,
    window: {
      integrationId: data.integration_id as string,
      slug: data.slug as string,
      // bigint/int over PostgREST: `Number()` at the boundary, in the mapper. Every figure
      // here is a unit count far inside what a double holds exactly.
      dailyQuotaUnits: Number(data.daily_quota_units),
      quotaSource: data.quota_source as QuotaWindow['quotaSource'],
      windowStartedAt: data.window_started_at as string,
      windowResetsAt: data.window_resets_at as string,
      unitsUsed: Number(data.units_used),
      unitsWasted: Number(data.units_wasted),
      unitsRemaining: Number(data.units_remaining),
      callsMade: Number(data.calls_made),
    },
  };
}

export type SpendResult =
  | { ok: true; usageId: string; unitsAfter: number }
  | { ok: false; code: 'insufficient_quota' | 'no_quota_declared' | 'write_failed'; detail: string };

/**
 * Commit units for a call that is about to be made.
 *
 * Refuses when the call would not fit in what remains. That refusal is the point of the
 * whole module: `videos.insert` costs 1,600 units and Google charges the attempt, so six
 * failures empty a day. Discovering that by being refused wastes the units; checking first
 * does not.
 *
 * There is a race here and it is stated rather than papered over: two workers could both
 * read 1,600 remaining and both spend it. The publish task's concurrency limit is 1, so it
 * cannot happen from that path today, and a database-side reservation would be the fix if
 * a second caller ever appears. Writing that now would be a guard for a state no write path
 * produces.
 */
export async function spend(
  db: Db,
  slug: string,
  endpoint: QuotaEndpoint,
  opts: { publicationId?: string | null; detail?: string } = {},
): Promise<SpendResult> {
  const units = QUOTA_UNITS[endpoint];
  const read = await readQuota(db, slug);
  if (!read.ok) {
    return {
      ok: false,
      code: read.code === 'no_quota_declared' ? 'no_quota_declared' : 'write_failed',
      detail: read.detail,
    };
  }

  if (read.window.unitsRemaining < units) {
    return {
      ok: false,
      code: 'insufficient_quota',
      detail:
        `${endpoint} costs ${units} units and ${read.window.unitsRemaining} remain in this `
        + `window, which resets at ${read.window.windowResetsAt}. Refusing before the call `
        + 'rather than after: the vendor charges a refused attempt, so finding this out by '
        + 'being refused would spend the units it is protecting.',
    };
  }

  const { data, error } = await db
    .from('api_quota_usage')
    .insert({
      integration_id: read.window.integrationId,
      endpoint,
      units,
      publication_id: opts.publicationId ?? null,
      // Null, not false. The call has not happened yet, so whether it worked is unknown —
      // and `false` here would be counted as wasted units before anything was wasted.
      succeeded: null,
      detail: opts.detail ?? null,
    })
    .select('id')
    .single();

  if (error) return { ok: false, code: 'write_failed', detail: error.message };

  return { ok: true, usageId: data.id, unitsAfter: read.window.unitsRemaining - units };
}

/**
 * Record whether the call the units were spent on actually worked.
 *
 * Never changes `units` — they are spent either way, and a settle that refunded them would
 * make the ledger describe what we wish had happened. This only fills in `succeeded`, which
 * is what makes "8,000 units burned and nothing shipped" answerable.
 */
export async function settle(
  db: Db,
  usageId: string,
  succeeded: boolean,
  detail?: string,
): Promise<void> {
  await db
    .from('api_quota_usage')
    .update({ succeeded, ...(detail ? { detail } : {}) })
    .eq('id', usageId);
}
