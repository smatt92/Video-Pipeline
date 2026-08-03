import { routeClient } from '../auth/supabase';
import { isOnboardingComplete, isOpenOnDeferral, outstandingRequired } from './gate';

/**
 * Onboarding progress for the signed-in user, as the wizard sees it.
 *
 * Read through the session-scoped client rather than the service-role one: this is the
 * user's own row, and a page that renders "your progress" using a key that can read
 * everyone's row is a habit that survives into places where it matters.
 *
 * `onboarding_completed_steps` is the record; `onboarding_step` is a derived display value
 * maintained by a trigger (0007). The wizard reads the array so its tick marks and the
 * middleware's lock cannot disagree.
 */

export interface OnboardingProgress {
  /** Steps that have passed a real verification. */
  completed: number[];
  /** Highest completed, for "step N of M" copy only. */
  step: number;
  /** Required steps still outstanding, in wizard order. Deferrals are not outstanding. */
  outstanding: number[];
  /** Steps deliberately skipped, with why. */
  deferred: { step: number; reason: string; at: string }[];
  /** True when the app is reachable only because something was deferred. */
  openOnDeferral: boolean;
  complete: boolean;
  /** The signed-in user, when there is one. Steps write against this id. */
  userId: string | null;
  email: string | null;
  /** Set when the profile row could not be read at all. Never silently zero. */
  unavailable: string | null;
}

const NONE = {
  completed: [] as number[],
  step: 0,
  deferred: [] as { step: number; reason: string; at: string }[],
  openOnDeferral: false,
  complete: false,
  userId: null,
  email: null,
  unavailable: null,
};

export async function onboardingProgress(): Promise<OnboardingProgress> {
  const supabase = await routeClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware has already refused an unauthenticated request by the time this renders.
  // Reaching here without a user means the matcher stopped covering this route.
  if (!user) {
    return { ...NONE, outstanding: outstandingRequired([]), unavailable: 'no session' };
  }

  const base = { ...NONE, userId: user.id, email: user.email ?? null };

  const { data, error } = await supabase
    .from('profiles')
    .select(
      'onboarding_completed_steps, onboarding_completed_at, onboarding_deferred_steps, onboarding_deferrals',
    )
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    return { ...base, outstanding: outstandingRequired([]), unavailable: error.message };
  }

  // No row yet is not an error — it is step zero, which is exactly where a first run
  // starts. Step 1 writes the row.
  if (!data) return { ...base, outstanding: outstandingRequired([]) };

  const completed = [...(data.onboarding_completed_steps ?? [])].sort((a, b) => a - b);
  const deferredSteps = [...(data.onboarding_deferred_steps ?? [])].sort((a, b) => a - b);

  // The jsonb carries the reason and the timestamp; the array is the trigger-derived
  // shape the gate compares. Reading both means a malformed jsonb degrades to "deferred,
  // reason unknown" rather than to a crash on a screen whose job is to explain itself.
  const notes = (data.onboarding_deferrals ?? {}) as Record<
    string,
    { at?: string; reason?: string } | undefined
  >;

  const deferred = deferredSteps.map((step) => ({
    step,
    reason: notes[String(step)]?.reason ?? 'no reason recorded',
    at: notes[String(step)]?.at ?? '',
  }));

  return {
    ...base,
    completed,
    step: completed.length ? Math.max(...completed) : 0,
    deferred,
    openOnDeferral: isOpenOnDeferral(data),
    outstanding: outstandingRequired(completed, deferredSteps),
    complete: isOnboardingComplete(data),
  };
}
