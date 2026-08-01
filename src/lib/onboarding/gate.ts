import { REQUIRED_STEPS, STEPS } from './steps';

/**
 * When the onboarding gate opens.
 *
 * A **set** comparison, not a threshold. `profiles.onboarding_step` is an integer and an
 * integer describes a line; the wizard is a graph. Steps 4 and 5 both depend on 2 and not
 * on each other, 7 is optional and sits between two required steps, and 8 depends only on
 * 1 — so someone who has passed 1, 2, 3 and 8 while stalling on 4 has completed four steps
 * and has no honest integer to write. Migration 0007 adds
 * `onboarding_completed_steps int[]` for that reason and demotes the integer to a display
 * value maintained by a trigger.
 *
 * The threshold that used to live here compared against the highest *required* step rather
 * than the last one, because 10 is the guided first video: valuable, but it spends real
 * credits, and refusing to run the app until someone has produced a video is a gate that
 * gets bypassed rather than passed. The set comparison keeps that property — optional
 * steps are simply not in REQUIRED_STEPS.
 */

/** Kept for display: "step N of M". Not what the gate compares. */
export const GATE_STEP: number = Math.max(...REQUIRED_STEPS);

export interface ProfileProgress {
  onboarding_completed_steps: number[];
  onboarding_completed_at: string | null;
}

/** The step the gate is waiting on, for the message at the top of the wizard. */
export function nextRequiredStep(completed: readonly number[]) {
  return STEPS.find((s) => s.required && !completed.includes(s.n)) ?? null;
}

/** Required steps still outstanding, in wizard order. */
export function outstandingRequired(completed: readonly number[]): number[] {
  return REQUIRED_STEPS.filter((n) => !completed.includes(n));
}

/**
 * Whether setup is far enough along to let the rest of the app run.
 *
 * `completed_at` is checked first and independently: it is written once, when the wizard
 * finishes, and it survives the required set changing later. Someone who completed
 * onboarding under an eight-step wizard should not be locked out because a ninth required
 * step was added afterwards — that is a migration problem, not their problem.
 */
export function isOnboardingComplete(profile: ProfileProgress | null): boolean {
  if (!profile) return false;
  if (profile.onboarding_completed_at !== null) return true;
  return outstandingRequired(profile.onboarding_completed_steps ?? []).length === 0;
}
