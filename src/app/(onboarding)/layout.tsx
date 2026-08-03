import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

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

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body style={{ background: 'var(--surface-0)' }}>{children}</body>
    </html>
  );
}
