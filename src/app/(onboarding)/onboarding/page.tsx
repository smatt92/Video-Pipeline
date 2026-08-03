import { cookies } from 'next/headers';

import { TourScreen } from '@/components/onboarding/tour-screen';
import { checkEmail } from '@/lib/auth/allowed';
import { routeClient } from '@/lib/auth/supabase';
import { TOUR } from '@/lib/onboarding/tour';

/**
 * The product tour. Public — no session required, by design.
 *
 * It used to sit behind authentication, which meant the only people who saw the explanation
 * of what Kiln is were people who had already decided to sign up. Moving it in front is the
 * whole point of the restructure.
 *
 * Whether the visitor is signed in changes only where the fork sends them, so it is read
 * here and passed down rather than checked again inside the client component.
 */

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  let signedIn = false;
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = !!user && checkEmail(user.email).ok;
  } catch {
    // Anonymous is the expected case here, not an error.
  }

  const jar = await cookies();
  const replay = jar.get('kiln.onboarding-seen')?.value === '1';

  return <TourScreen steps={TOUR} signedIn={signedIn} replay={replay} />;
}
