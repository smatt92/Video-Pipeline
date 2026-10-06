import { redirect } from 'next/navigation';

import { onboardingProgress } from '@/lib/onboarding/progress';
import { STEPS, firstIncompleteSlug } from '@/lib/onboarding/steps';

/**
 * `/setup` → the first step still to do, by slug.
 *
 * It redirected to `/setup/1` while the steps are addressed by slug (`/setup/profile` …), so
 * the index of the wizard was a 404. If progress cannot be read, the first step — a page that
 * exists is a better answer to "I don't know" than a page that does not.
 */
export const dynamic = 'force-dynamic';

export default async function SetupIndex() {
  let slug = STEPS[0].slug;
  try {
    const p = await onboardingProgress();
    if (!p.unavailable) slug = firstIncompleteSlug(p.completed, p.deferred.map((d) => d.step));
  } catch {
    // The first step. See above.
  }
  redirect(`/setup/${slug}`);
}
