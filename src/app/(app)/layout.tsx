import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

import { Suspense } from 'react';

import { DeferralBanner } from '@/components/shell/deferral-banner';
import { AppShell } from '@/components/shell/app-shell';

import '../globals.css';

/**
 * Root layout for the application proper.
 *
 * One of two root layouts. `(setup)` has its own, deliberately without the shell — see
 * the note there. Two top-level route groups is the only way Next allows two roots, and
 * it is the right shape here rather than a workaround: setup and the app are genuinely
 * different surfaces, not the same surface with a flag.
 *
 * Geist from the `geist` npm package rather than `next/font/google`.
 *
 * The Google loader fetches the font files at build time, which makes every build depend
 * on reaching fonts.googleapis.com. The package ships the files, so the build needs
 * nothing but npm — and the deployment has one less thing that can fail at 3am for
 * reasons unrelated to the code.
 *
 * Geist rather than Inter because Inter now reads as "didn't think about it".
 */

export const metadata: Metadata = {
  title: 'Kiln',
  description: 'AI video content pipeline — trend to published, with the cost attached.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Dark-first: the attribute is set here rather than resolved from a media query, so
    // there is no flash of the wrong theme. A toggle would write to this same attribute.
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <AppShell>
          {/* Above everything, on every screen in the app, and not dismissible. A banner
              you can close is closed on day one, and the state it describes then goes
              invisible for weeks — which is the failure it exists to prevent, since a
              deferred integration looks exactly like a working one from any screen that
              has no data to show anyway. Suspended so a slow read delays the banner and
              not the page. */}
          <Suspense fallback={null}>
            <DeferralBanner />
          </Suspense>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
