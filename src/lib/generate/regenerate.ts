import 'server-only';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { primaryForKind } from '../drivers/catalog';
import { stillCallPayload } from '../drivers/video-submit';
import { usability } from '../integrations/verify';
import { generationKey } from './keys';

/**
 * Regenerate one shot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this is two functions and not one
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `estimateRegenerate` answers "what would this cost, and may it happen at all"; it writes
 * nothing. `executeRegenerate` does it. The confirmation dialog calls the first and the
 * button calls the second, and the second **re-runs the first** rather than trusting any
 * number the browser sends back.
 *
 * That is not defensive habit. The dialog's figure is display, and a client that can post
 * its own cost estimate can post a zero — at which point the guard reads as working while
 * authorising an unpriced call, which is rule 5 inverted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A new key, therefore a new charge. Said out loud.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Rule 6 says every generation carries an idempotency key so retries do not double-charge,
 * and `generationKey` is explicit that `attempt` is "bumped deliberately by a human pressing
 * regenerate, never by a retry". So regenerate is the one place in the system that
 * deliberately defeats idempotency — that is its entire purpose, and the confirmation has to
 * say so in words rather than leaving the operator to infer it from a cost figure.
 *
 * `estimateRegenerate` therefore returns both keys. The dialog shows them. Two strings that
 * visibly differ is a harder thing to misread than a sentence claiming they will.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this does NOT do: call the vendor
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It writes an authorised `generations` row with a fresh key and status `queued`. The
 * vendor call, and the `cost_ledger` row that must precede it, belong to the stage-5 submit
 * path — which writes the ledger row *before* the call, exactly as rule 5 requires.
 *
 * Writing the ledger row here instead would record a charge for a call that may never be
 * made: a queued row that is never submitted has cost nothing, and cost-per-video is the
 * project's headline metric. Money is recorded when money moves, not when somebody presses
 * a button.
 */

export interface RegenerateBlocker {
  code: string;
  detail: string;
  remedy: string;
}

export type RegenerateEstimate =
  | {
      ok: true;
      shotId: string;
      shotIdx: number;
      description: string;
      driver: string;
      model: string;
      /** What the last submit for this shot was keyed as. Null when there has been none. */
      previousKey: string | null;
      /** What this one would be keyed as. Different by construction. */
      newKey: string;
      attempt: number;
      quantity: number;
      unit: string;
      costUsd: number;
      costInr: number;
      usdInrRate: number;
      rateSourceNote: string | null;
    }
  | { ok: false; blockers: RegenerateBlocker[] };

/**
 * The credit cost of one shot's regeneration.
 *
 * One credit per still. Deliberately a named constant rather than an inline 1: the moment a
 * model bills two credits for a longer clip this is the line that has to change, and a bare
 * literal in an arithmetic expression is the version of that which gets missed.
 */
const CREDITS_PER_SHOT = 1;

export async function estimateRegenerate(
  db: Db,
  shotId: string,
  opts: { usdInrRate: number },
): Promise<RegenerateEstimate> {
  const blockers: RegenerateBlocker[] = [];

  const { data: shot } = await db
    .from('shots')
    .select('id, idx, description, script_id, compiled_params, prompt_id, status, duration_source')
    .eq('id', shotId)
    .maybeSingle();

  if (!shot) {
    return {
      ok: false,
      blockers: [
        { code: 'unknown_shot', detail: `No shot ${shotId}.`, remedy: 'Reload the review screen.' },
      ],
    };
  }

  // ── Gate 1: is there a vendor we are allowed to call? ────────────────────
  const descriptor = primaryForKind('video');
  if (!descriptor) {
    blockers.push({
      code: 'no_video_integration',
      detail: 'No integration in the catalogue is marked primary for video.',
      remedy: 'Fix INTEGRATION_CATALOG in src/lib/drivers/catalog.ts.',
    });
  } else {
    const use = await usability(db, descriptor.slug);
    if (!use.usable) {
      blockers.push({
        code: use.deferred ? 'video_integration_deferred' : 'video_integration_unusable',
        detail: use.reason,
        remedy:
          'Settings → Integrations, then Test connection. Enabling states intent; verifying ' +
          'states fact, and only the second one lets a task spend money.',
      });
    }
  }

  // ── Gate 2: is the shot compiled? ────────────────────────────────────────
  const params = asRecord(shot.compiled_params);
  const model = typeof params.model === 'string' ? params.model : null;

  if (!shot.prompt_id || !model) {
    blockers.push({
      code: 'not_compiled',
      detail:
        'This shot has no compiled parameters, so there is nothing to re-submit. ' +
        'Regeneration repeats a request; it does not invent one.',
      remedy: 'Run stage 4 against this script first.',
    });
  }

  // ── Gate 3: can it be priced? ────────────────────────────────────────────
  //
  // The gate the whole dialog exists for. An unverified rate produces no rupee figure
  // anywhere (Addendum 01), so a confirmation showing one would be showing a number that is
  // internally consistent and externally meaningless — which is worse than showing none,
  // because it gets believed and then quoted.
  let priced: { unitCostUsd: number; sourceNote: string | null } | null = null;

  if (descriptor && model) {
    const rate = await currentRate(db, {
      driver: descriptor.slug,
      model,
      endpoint: null,
      unit: 'credit',
    });

    if (!rate.found) {
      blockers.push({
        code: rate.reason,
        detail: rate.detail,
        remedy:
          'Settings → Rate card. A credit rate is verified by watching the balance move, not ' +
          'by reading a docs page — nobody publishes these. Until then no rupee figure can be ' +
          'shown and no credit-billed call may be authorised.',
      });
    } else {
      priced = { unitCostUsd: rate.rate.unitCostUsd, sourceNote: rate.rate.sourceNote };
    }
  }

  if (blockers.length > 0 || !priced || !descriptor || !model) {
    return { ok: false, blockers };
  }

  // ── The keys ─────────────────────────────────────────────────────────────
  const { data: previous } = await db
    .from('generations')
    .select('idempotency_key, attempt')
    .eq('shot_id', shotId)
    .order('attempt', { ascending: false })
    .limit(1)
    .maybeSingle();

  const attempt = (previous?.attempt ?? 0) + 1;
  const payload = stillCallPayload(params, { shot_id: shotId });
  const newKey = generationKey({ shotId, attempt, kind: 'image', payload });

  const costUsd = priced.unitCostUsd * CREDITS_PER_SHOT;

  return {
    ok: true,
    shotId,
    shotIdx: shot.idx,
    description: shot.description,
    driver: descriptor.slug,
    model,
    previousKey: previous?.idempotency_key ?? null,
    newKey,
    attempt,
    quantity: CREDITS_PER_SHOT,
    unit: 'credit',
    costUsd,
    costInr: round(costUsd * opts.usdInrRate),
    usdInrRate: opts.usdInrRate,
    rateSourceNote: priced.sourceNote,
  };
}

export type RegenerateResult =
  | { ok: true; generationId: string; idempotencyKey: string; attempt: number; costInr: number }
  | { ok: false; blockers: RegenerateBlocker[] };

export async function executeRegenerate(
  db: Db,
  shotId: string,
  opts: { usdInrRate: number },
): Promise<RegenerateResult> {
  // Re-estimated, not trusted. Every gate is re-checked here, so authorisation cannot be
  // granted by a stale dialog left open while somebody disabled the integration.
  const estimate = await estimateRegenerate(db, shotId, opts);
  if (!estimate.ok) return { ok: false, blockers: estimate.blockers };

  const { data: shot } = await db
    .from('shots')
    .select('compiled_params')
    .eq('id', shotId)
    .maybeSingle();

  const payload = stillCallPayload(asRecord(shot?.compiled_params), { shot_id: shotId });

  const { data, error } = await db
    .from('generations')
    .insert({
      shot_id: shotId,
      kind: 'image',
      driver: estimate.driver,
      model: estimate.model,
      request_payload: payload as Json,
      idempotency_key: estimate.newKey,
      attempt: estimate.attempt,
      status: 'queued',
      origin: 'pipeline',
    })
    .select('id')
    .single();

  if (error || !data) {
    // A duplicate key here is not a race to paper over — it means this exact regeneration
    // already exists, which is rule 6 doing its job. Reported as a refusal rather than
    // retried with a different key, because a different key is a second charge.
    if (error && /duplicate key|unique constraint/i.test(error.message)) {
      return {
        ok: false,
        blockers: [
          {
            code: 'already_queued',
            detail: `Attempt ${estimate.attempt} of this shot, with these exact parameters, is already queued.`,
            remedy: 'Wait for it, or change the shot before regenerating so it is a different request.',
          },
        ],
      };
    }
    return {
      ok: false,
      blockers: [
        {
          code: 'insert_failed',
          detail: error?.message ?? 'No row returned.',
          remedy: 'Run pnpm doctor.',
        },
      ],
    };
  }

  await db.from('shots').update({ status: 'generating' }).eq('id', shotId);

  return {
    ok: true,
    generationId: data.id,
    idempotencyKey: estimate.newKey,
    attempt: estimate.attempt,
    costInr: estimate.costInr,
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
