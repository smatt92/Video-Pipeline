import 'server-only';

import { currentRate } from '../cost/rate-card';
import { primaryForKind } from '../drivers/catalog';
import { serverClient, type Db } from '../db/server';

/**
 * The pilot shot: what saying yes will cost, and saying it exactly once.
 *
 * Stage 5 submits one shot and stops. This is the other half — reading what approving
 * commits to, and performing the transition.
 *
 * ── The number has to be visible before the decision ─────────────────────────
 *
 * The control is worth nothing if "approve" is a button whose consequence you learn from
 * the cost screen afterwards. `readPilot` returns the estimate for the shots still held
 * back so a screen can say *approve to spend an estimated ₹X across 5 more shots* — and it
 * returns **null** rather than a figure when the rate is unverified, because an unverified
 * rate produces no rupee figure anywhere and a guess here is a guess about how much
 * somebody is about to spend.
 *
 * ── Approving is a compare-and-set ───────────────────────────────────────────
 *
 * It spends money. Two clicks, two tabs, or a retried Server Action must not each start a
 * fan-out, and an application-level `if (!approved)` cannot promise that.
 * `approve_pilot_once` carries `pilot_approved_at is null` **and**
 * `pilot_generation_id = $2`, so approving a pilot that has since been replaced also loses
 * — the case an `is null` check alone would miss.
 */

export interface PilotView {
  scriptId: string;
  generationId: string | null;
  shotId: string | null;
  status: 'none' | 'awaiting' | 'approved' | 'rejected';
  /** Shots that will be submitted on approval. */
  heldBack: number;
  /** Null when the rate is unverified — never a guess about what is about to be spent. */
  estimatedInr: number | null;
  /** Why the estimate is null, when it is. */
  unpricedReason: string | null;
  generationStatus: string | null;
  rejectReason: string | null;
}

export async function readPilot(scriptId: string, client?: Db): Promise<PilotView> {
  const db = client ?? serverClient();

  const { data: script } = await db
    .from('scripts')
    .select('id, pilot_generation_id, pilot_approved_at, pilot_rejected_at, pilot_reject_reason')
    .eq('id', scriptId)
    .maybeSingle();

  const base: PilotView = {
    scriptId,
    generationId: script?.pilot_generation_id ?? null,
    shotId: null,
    status: !script?.pilot_generation_id
      ? 'none'
      : script.pilot_rejected_at
        ? 'rejected'
        : script.pilot_approved_at
          ? 'approved'
          : 'awaiting',
    heldBack: 0,
    estimatedInr: null,
    unpricedReason: null,
    generationStatus: null,
    rejectReason: script?.pilot_reject_reason ?? null,
  };

  if (!script?.pilot_generation_id) return base;

  const { data: gen } = await db
    .from('generations')
    .select('id, shot_id, status, model')
    .eq('id', script.pilot_generation_id)
    .maybeSingle();

  const { data: shots } = await db
    .from('shots')
    .select('id, compiled_params, prompt_id, duration_source')
    .eq('script_id', scriptId);

  const ready = (shots ?? []).filter(
    (sh) => sh.compiled_params && sh.prompt_id && sh.duration_source === 'derived_from_vo',
  );
  const heldBack = Math.max(0, ready.length - 1);

  const video = primaryForKind('video');
  let estimatedInr: number | null = null;
  let unpricedReason: string | null = null;

  if (heldBack === 0) {
    estimatedInr = 0;
  } else if (!video) {
    unpricedReason = 'No integration in the catalogue is marked primary for video.';
  } else {
    const rate = await currentRate(db, {
      driver: video.slug,
      model: gen?.model ?? '',
      endpoint: '/v1/text2image/soul',
      unit: 'credit',
    });
    const usdInr = await observedUsdInr(db);
    if (rate.found && usdInr !== null) {
      estimatedInr = rate.rate.unitCostUsd * heldBack * usdInr;
    } else {
      unpricedReason = rate.found
        ? 'No ledger row carries a USD→INR rate yet, so there is no observed rate to convert at.'
        : rate.detail;
    }
  }

  return {
    ...base,
    shotId: gen?.shot_id ?? null,
    generationStatus: gen?.status ?? null,
    heldBack,
    estimatedInr,
    unpricedReason,
  };
}

/**
 * The rate a rupee figure is converted at, read from the last charge.
 *
 * Null rather than a default when no ledger row carries one: with no observed rate there is
 * no rupee figure, which is the same rule the rate card follows. A default here would put a
 * number in front of somebody about to spend, computed from a constant nobody chose.
 */
async function observedUsdInr(db: Db): Promise<number | null> {
  const { data } = await db
    .from('cost_ledger')
    .select('usd_inr_rate')
    .not('usd_inr_rate', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const n = Number(data?.usd_inr_rate);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type PilotDecision =
  | { ok: true; heldBack: number }
  | { ok: false; code: string; detail: string };

/**
 * Approve, exactly once.
 *
 * Returns `lost` rather than throwing when the compare-and-set does not win: losing is an
 * ordinary outcome — a second tab, a double click, a pilot replaced since the page loaded —
 * and none of them is an error the operator caused.
 */
export async function approvePilot(
  scriptId: string,
  generationId: string,
  client?: Db,
): Promise<PilotDecision> {
  const db = client ?? serverClient();

  const { data: won, error } = await db.rpc('approve_pilot_once', {
    p_script_id: scriptId,
    p_generation_id: generationId,
  });

  if (error) return { ok: false, code: 'rpc_failed', detail: error.message };
  if (won !== true) {
    return {
      ok: false,
      code: 'lost',
      detail:
        'This pilot was already decided, or has been replaced by a newer one. Nothing was '
        + 'submitted — the database decided, which is what stops two clicks starting two '
        + 'fan-outs.',
    };
  }

  const view = await readPilot(scriptId, db);
  return { ok: true, heldBack: view.heldBack };
}

export async function rejectPilot(
  scriptId: string,
  reason: string,
  client?: Db,
): Promise<PilotDecision> {
  const db = client ?? serverClient();

  const { error } = await db
    .from('scripts')
    .update({ pilot_rejected_at: new Date().toISOString(), pilot_reject_reason: reason })
    .eq('id', scriptId)
    .is('pilot_approved_at', null)
    .is('pilot_rejected_at', null);

  if (error) return { ok: false, code: 'update_failed', detail: error.message };
  return { ok: true, heldBack: 0 };
}
