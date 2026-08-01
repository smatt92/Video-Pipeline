import { REQUIRED_STEPS, STEPS } from './steps';

/**
 * When the onboarding gate opens.
 *
 * `profiles.onboarding_step` is a single int — "highest step completed" — not a set. That
 * is only a sufficient answer because the wizard advances strictly in order and refuses to
 * unlock a step whose `blockedBy` has not passed (see `isUnlocked`). Reaching step N
 * therefore means every step below N was walked. If the wizard ever gains a "skip and come
 * back", this comparison stops being true and the column has to become an array.
 *
 * The threshold is the highest *required* step, not the last step. 9 is optional and 10 is
 * the guided first video — valuable, but it spends real credits and refusing to run the app
 * until someone has produced a video is a gate that would get bypassed rather than passed.
 */
export const GATE_STEP: number = Math.max(...REQUIRED_STEPS);

/** The step the gate is waiting on, for the message shown at the top of the wizard. */
export function nextRequiredStep(step: number) {
  return STEPS.find((s) => s.required && s.n > step) ?? null;
}

/**
 * Whether setup is far enough along to let the rest of the app run.
 *
 * `completedAt` is checked first and independently: it is written once, when the wizard
 * finishes, and it survives the step threshold changing later. Someone who completed
 * onboarding under an eight-step wizard should not be locked out because a ninth required
 * step was added afterwards — that is a migration problem, not their problem.
 */
export function isOnboardingComplete(
  profile: { onboarding_step: number; onboarding_completed_at: string | null } | null,
): boolean {
  if (!profile) return false;
  if (profile.onboarding_completed_at !== null) return true;
  return profile.onboarding_step >= GATE_STEP;
}
