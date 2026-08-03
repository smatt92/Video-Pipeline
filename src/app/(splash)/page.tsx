import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

import { SplashMark } from '@/components/onboarding/splash-mark';
import { checkEmail } from '@/lib/auth/allowed';
import { routeClient } from '@/lib/auth/supabase';
import { serverClient } from '@/lib/db/server';
import { entryDestination, SEEN_COOKIE } from '@/lib/onboarding/entry';

/**
 * The splash. Renders on every visit and decides where the visit goes.
 *
 * ── It does real work or it should not exist ─────────────────────────────────
 *
 * Three things, in this order: check the session, resolve where this person belongs, and
 * hand the browser a destination it can start fetching. A splash that only shows a logo for
 * a fixed number of milliseconds is a delay wearing a brand, and this one has no timer at
 * all — it redirects the moment it knows, which on a warm session is immediately.
 *
 * ── The LCP element is an inline SVG ─────────────────────────────────────────
 *
 * Not a raster. A logo PNG is a second network round trip on the one screen whose entire
 * purpose is to not be in the way, and on the slow connection where a splash would actually
 * be visible it is the round trip that makes it visible. The mark is DOM and ships with the
 * document.
 *
 * ── Fails toward the tour, not toward an error ───────────────────────────────
 *
 * Any failure to read auth or the profile lands on `/onboarding`, which is public and
 * explains the product. That is the right destination for "we do not know who you are" —
 * it is also the destination for a first-time visitor, which is the most likely reason to
 * not know.
 */

export const dynamic = 'force-dynamic';

export default async function Splash() {
  let signedIn = false;
  let seenOnRecord: boolean | null = null;

  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user && checkEmail(user.email).ok) {
      signedIn = true;
      const { data } = await serverClient()
        .from('profiles')
        .select('onboarding_seen_at')
        .eq('id', user.id)
        .maybeSingle();
      seenOnRecord = data ? data.onboarding_seen_at !== null : null;
    }
  } catch {
    // Toward the tour. See the note above.
  }

  const jar = await cookies();
  const destination = entryDestination({
    signedIn,
    seenOnRecord,
    seenCookie: jar.get(SEEN_COOKIE)?.value === '1',
  });

  redirect(
    destination.to === 'app' ? '/board' : destination.to === 'login' ? '/login' : '/onboarding',
  );

  // Unreachable — `redirect` throws. Present because a splash that could ever paint should
  // paint the mark rather than nothing, and because deleting it would make the file look
  // like it renders no UI at all.
  return <SplashMark />;
}
