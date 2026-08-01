import { routeClient } from '../auth/supabase';
import { isOnboardingComplete } from './gate';

/**
 * Onboarding progress for the signed-in user, as the wizard sees it.
 *
 * Read through the session-scoped client rather than the service-role one: this is the
 * user's own row, and a page that renders "your progress" using a key that can read
 * everyone's row is a habit that survives into places where it matters.
 *
 * `profiles.onboarding_step` is the highest step completed, so completion is derived
 * rather than stored per step — see the note in `gate.ts` about what that assumes.
 */

export interface OnboardingProgress {
  /** Highest step completed. 0 means nothing has been verified. */
  step: number;
  /** Step numbers treated as done, derived from `step`. */
  completed: number[];
  complete: boolean;
  /** Set when the profile row could not be read at all. Never silently zero. */
  unavailable: string | null;
}

const NONE: OnboardingProgress = { step: 0, completed: [], complete: false, unavailable: null };

export async function onboardingProgress(): Promise<OnboardingProgress> {
  const supabase = await routeClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware has already refused an unauthenticated request by the time this renders.
  // Reaching here without a user means the matcher stopped covering this route.
  if (!user) return { ...NONE, unavailable: 'no session' };

  const { data, error } = await supabase
    .from('profiles')
    .select('onboarding_step, onboarding_completed_at')
    .eq('id', user.id)
    .maybeSingle();

  if (error) return { ...NONE, unavailable: error.message };

  // No row yet is not an error — it is step zero, which is exactly where a first run
  // starts. Step 1 writes the row.
  if (!data) return NONE;

  const step = data.onboarding_step;
  return {
    step,
    completed: Array.from({ length: step }, (_, i) => i + 1),
    complete: isOnboardingComplete(data),
    unavailable: null,
  };
}
