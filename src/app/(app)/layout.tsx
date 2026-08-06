import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

import { Suspense } from 'react';

import { DeferralBanner } from '@/components/shell/deferral-banner';
import { AppShell } from '@/components/shell/app-shell';
import { ChecklistSlot } from '@/components/onboarding/checklist-slot';
import { readUiScale } from '@/lib/settings/read-ui-scale';
import { uiScaleBootstrapScript } from '@/lib/settings/ui-scale';

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
 * on reaching an external font CDN. The package ships the files, so the build needs
 * nothing but npm — and the deployment has one less thing that can fail at 3am for
 * reasons unrelated to the code.
 *
 * (The hostname used to be written out here and `check:vendors` flagged it when stage 10
 * added the API domain to its list. A different Google surface entirely, and the guard was
 * still right to fire: it cannot tell a comment from a call, and narrowing it so that it
 * could would narrow it past a commented-out call too. Note that the first version of THIS
 * note named the domain while explaining why not to, and was flagged in turn — which is
 * the guard behaving correctly twice, not a false positive.)
 *
 * Geist rather than Inter because Inter now reads as "didn't think about it".
 */

export const metadata: Metadata = {
  title: 'Kiln',
  description: 'AI video content pipeline — trend to published, with the cost attached.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read before render so the scale is on <html> at first paint. Reading it in an effect
  // instead renders every page once at 100% and then jumps, and on the display this exists
  // for the jump is from unreadable to readable — on every navigation.
  const uiScale = await readUiScale();

  return (
    // Dark-first: the attribute is set here rather than resolved from a media query, so
    // there is no flash of the wrong theme. A toggle would write to this same attribute.
    <html
      lang="en"
      data-theme="dark"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      // Inline rather than a class, because the value is a number from the database and a
      // class would need one variant per step compiled ahead of time.
      style={uiScale === 1 ? undefined : ({ '--ui-scale': String(uiScale) } as React.CSSProperties)}
    >
      <head>
        {/* Belt and braces for the case the server value is absent — a cold profile read,
            or a route rendered before sign-in. Runs before hydration by construction. */}
        <script
          dangerouslySetInnerHTML={{ __html: uiScaleBootstrapScript(uiScale) }}
        />
      </head>
      <body>
        <AppShell checklist={<Suspense fallback={null}><ChecklistSlot /></Suspense>}>
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
