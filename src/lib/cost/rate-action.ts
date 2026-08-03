'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';

/**
 * Record an observed rate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The screen this serves is the one that unblocks every paid stage
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `priceLlmCall` and `requirePricing` refuse when a rate is unverified, so stages 2, 3, 5,
 * 6 and 9 all stop. Every rate ships at zero and unverified, deliberately — no vendor
 * publishes these and a plausible default would be believed, summed, and put in a business
 * case.
 *
 * The rate card screen existed to fix that and rendered a constant from
 * `src/lib/fixtures/settings.ts`. So the screen whose stated job was making the refusal stop
 * being true could not do it, and looked identical against a real database, an empty one and
 * a broken one. Same shape as the host voice, wider blast radius: the voice blocked one
 * chain, this blocks everything that costs money.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A correction appends. It never edits.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `currentRate` reads the newest `effective_from` at or before the moment asked about, so
 * inserting a row with `now()` supersedes the old one for everything from here on and leaves
 * every past price explainable. Updating in place would rewrite what a video cost six months
 * ago — the `unit_cost_snapshot` on each ledger row protects the *figure*, but the rate that
 * produced it would be gone, and "why was this video ₹40" would have no answer.
 *
 * This is also why there is no delete.
 */

export interface RateState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
}

export interface RateInput {
  driver: string;
  model: string;
  endpoint: string | null;
  unit: string;
  unitCost: number;
  currency?: string;
  sourceNote: string;
}

export async function setRateAction(input: RateInput): Promise<RateState> {
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { status: 'error', message: 'Not signed in.' };
    if (!checkEmail(user.email).ok) return { status: 'error', message: 'Not permitted.' };

    if (!Number.isFinite(input.unitCost) || input.unitCost < 0) {
      return { status: 'error', message: 'A rate must be a number and cannot be negative.' };
    }

    // Zero is refused rather than accepted-and-flagged. A verified zero is the exact state
    // the seed already represents, and marking it verified would mean "somebody checked,
    // and it is free" — which no paid endpoint is. If a call genuinely costs nothing it
    // does not belong in the rate card, because rule 5 only applies to calls that cost.
    if (input.unitCost === 0) {
      return {
        status: 'error',
        message:
          'A verified rate of zero would say "somebody checked, and this call is free", ' +
          'which no paid endpoint is. Leave it unverified until you have a figure — the ' +
          'refusal is doing its job in the meantime.',
      };
    }

    // Where the number has to come from, restated because it is the whole reason this is
    // manual. No vendor publishes credit prices; they are read off a balance delta after a
    // real call. A source note that does not say which run is a number nobody can re-derive.
    if (input.sourceNote.trim().length < 8) {
      return {
        status: 'error',
        message:
          'Say where the figure came from — a balance delta, an invoice line, a dated ' +
          'screenshot. A rate with no provenance is a number nobody can re-derive, and this ' +
          'is the field a cost-per-video claim ultimately rests on.',
      };
    }

    const { error } = await serverClient()
      .from('rate_card')
      .insert({
        driver: input.driver,
        model: input.model,
        endpoint: input.endpoint,
        unit: input.unit,
        unit_cost: input.unitCost,
        currency: input.currency ?? 'USD',
        is_verified: true,
        source_note: input.sourceNote.trim(),
        // Explicit rather than defaulted, so the row's own timestamp is the thing
        // `currentRate` orders on rather than an insertion artefact.
        effective_from: new Date().toISOString(),
      });

    if (error) return { status: 'error', message: error.message };

    revalidatePath('/settings/rate-card');
    return {
      status: 'ok',
      message:
        'Recorded, effective now. The previous row is kept — a past cost figure has to stay ' +
        'explainable — and stages that were refusing for want of this rate will now run.',
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
