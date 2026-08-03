'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { recordReview, writeOrder, writeTrim } from './write';

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
