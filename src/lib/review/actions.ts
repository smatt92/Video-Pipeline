'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { estimateRegenerate, executeRegenerate, type RegenerateEstimate } from '../generate/regenerate';
import { recordReview, writeOrder, writeTrim } from './write';
import { readUsdInrRate, requireUsdInrRate } from '../cost/fx';

/**
 * The review screen's Server Actions: auth, then `write.ts`, then revalidate.
 *
 * Deliberately thin. Every rule with consequences — how `structure_novel` is derived, that
 * a reshoot must name its shots, that a reorder goes through `reorder_shots` — lives in
 * `write.ts`, where `scripts/verify-review.mjs` executes it. What is left here is the part
 * that genuinely needs Next, and a file with nothing else in it cannot hide a rule that
 * nothing tests.
 *
 * The allowlist re-check is not optional. A Server Action is an HTTP endpoint, and a
 * `reviews` row with `decision = 'pass'` is the only thing that gets a publication past the
 * `enforce_review_pass` trigger.
 */

export interface ReviewState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
}

async function requireUser(): Promise<string> {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error('Not signed in.');
  if (!checkEmail(user.email).ok) throw new Error('Not permitted.');
  return user.id;
}

export async function submitReviewAction(
  renderId: string,
  _prev: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  try {
    const reviewerId = await requireUser();

    const result = await recordReview(serverClient(), {
      renderId,
      reviewerId,
      decision: String(formData.get('decision') ?? ''),
      reshootShotIds: formData.getAll('reshoot').map(String).filter(Boolean),
      notes: String(formData.get('notes') ?? '').trim() || null,
    });

    revalidatePath(`/review/${renderId}`);
    revalidatePath('/review');

    return { status: result.ok ? 'ok' : 'error', message: result.message };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function setTrimAction(
  renderId: string,
  shotId: string,
  inS: number | null,
  outS: number | null,
): Promise<ReviewState> {
  try {
    await requireUser();
    const result = await writeTrim(serverClient(), shotId, inS, outS);
    revalidatePath(`/review/${renderId}`);
    return { status: result.ok ? 'ok' : 'error', message: result.message };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function reorderShotsAction(
  renderId: string,
  scriptId: string,
  shotIds: string[],
): Promise<ReviewState> {
  try {
    await requireUser();
    const result = await writeOrder(serverClient(), scriptId, shotIds);
    revalidatePath(`/review/${renderId}`);
    return { status: result.ok ? 'ok' : 'error', message: result.message };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What regenerating this shot would cost, and whether it may happen.
 *
 * Read-only, and the dialog's whole content. Separate from the action that does it so the
 * confirmation is built from live state rather than from whatever the page was rendered
 * with — an integration disabled two minutes ago must close the dialog's answer, not be
 * discovered after the charge.
 */
export async function estimateRegenerateAction(shotId: string): Promise<RegenerateEstimate> {
  await requireUser();

  // A blocker, not a throw. This is the dialog's whole content, and its job is to say
  // whether the regenerate may happen — so an unset rate belongs in the list beside
  // "integration disabled", where the operator reads it before pressing anything. A throw
  // here would quote no price and name no cause.
  const usdInrRate = readUsdInrRate();
  if (usdInrRate === null) {
    return {
      ok: false,
      blockers: [
        {
          code: 'no_usd_inr_rate',
          detail:
            'USD_INR_RATE is not set, so this regenerate cannot be priced in rupees and the '
            + 'ledger row it would write would carry a rate nobody chose.',
          remedy: 'Set USD_INR_RATE in the environment of whichever deployment runs the submit.',
        },
      ],
    };
  }

  return estimateRegenerate(serverClient(), shotId, { usdInrRate });
}

export async function regenerateShotAction(
  renderId: string,
  shotId: string,
): Promise<ReviewState> {
  try {
    await requireUser();

    // The one that actually spends. `requireUsdInrRate` rather than the nullable read,
    // because there is nothing to degrade into here — the caller wants the charge made or
    // refused, and the catch below turns the refusal into the same error surface every
    // other configuration fault on this screen uses.
    const result = await executeRegenerate(serverClient(), shotId, {
      usdInrRate: requireUsdInrRate('regenerating a shot'),
    });

    revalidatePath(`/review/${renderId}`);

    if (!result.ok) {
      return {
        status: 'error',
        message: result.blockers.map((b) => `${b.detail} ${b.remedy}`).join(' · '),
      };
    }

    return {
      status: 'ok',
      message:
        `Queued as attempt ${result.attempt}, key ${result.idempotencyKey}. ` +
        'The cost row is written by the submit path at the moment the vendor is called — a ' +
        'queued generation that is never submitted has cost nothing.',
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ask stage 9 for publishing metadata.
 *
 * Here rather than in a module of its own because it belongs to the review screen: the
 * moment metadata makes sense is the moment a human has passed a render, and that is the
 * only screen where that happens.
 *
 * Enqueued rather than run inline — a Server Action that awaited a model call would hold
 * the request open for it.
 */
export async function requestMetadata(renderId: string): Promise<{
  enqueued: boolean;
  runId?: string;
  detail?: string;
}> {
  try {
    const { metadataTask } = await import('@/trigger/09-metadata');
    const handle = await metadataTask.trigger({ renderId });
    return { enqueued: true, runId: handle.id };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[review] could not enqueue metadata', { renderId, detail });
    return { enqueued: false, detail };
  }
}
