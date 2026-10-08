import type { Metadata } from 'next';
import { htmlAppearance } from '@/lib/appearance/read';

import { fontVariables } from '../fonts';

import '../globals.css';

/**
 * Root layout for the product tour.
 *
 * A third root, alongside `(app)` and `(setup)`, and the reason is the same one that
 * justified the second: this is a genuinely different surface, not the app with a flag. It
 * is **public** — reachable with no session at all — which makes it the only root that must
 * assume there is no profile, no theme preference to read, and nobody to personalise for.
 *
 * No `--ui-scale` read here on purpose. That lives on the profile and there may not be one;
 * the bootstrap script in the app layout falls back to localStorage for exactly this case,
 * and a returning visitor who set 125% keeps it.
 */

export const metadata: Metadata = {
  title: 'Kiln — what this is',
  description:
    'An AI video pipeline that records what every video cost to make. Five things worth ' +
    'knowing before you sign in.',
};

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const look = await htmlAppearance();
  return (
    <html lang="en" data-theme={look['data-theme']} className={`${fontVariables} ${look.className}`.trim()}>
      <body style={{ background: 'var(--s0)' }}>{children}</body>
    </html>
  );
}
