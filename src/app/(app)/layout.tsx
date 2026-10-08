import type { Metadata } from 'next';

import { Suspense } from 'react';

import { DeferralBanner } from '@/components/shell/deferral-banner';
import { AppShell } from '@/components/shell/app-shell';
import { readUiScale } from '@/lib/settings/read-ui-scale';
import { railData } from '@/lib/shell/rail';
import { uiScaleBootstrapScript } from '@/lib/settings/ui-scale';
import { htmlAppearance } from '@/lib/appearance/read';

import { fontVariables } from '../fonts';

import '../globals.css';

/**
 * Root layout for the application proper.
 *
 * One of two root layouts. `(setup)` has its own, deliberately without the shell — see
 * the note there. Two top-level route groups is the only way Next allows two roots, and
 * it is the right shape here rather than a workaround: setup and the app are genuinely
 * different surfaces, not the same surface with a flag.
 *
 * Type is Urbanist and Geist Mono through `next/font/google` (src/app/fonts.ts) — Kiln Glass,
 * 08-Oct. The note that used to stand here explained why Geist came from an npm package
 * instead: the Google loader makes the build depend on reaching the font host. That is still
 * true and is now accepted; fonts.ts says what a sandbox without that route does.
 *
 * The colour theme and the glass/solid surface are cookies read here (lib/appearance), so
 * <html> carries the right `data-theme` in the first byte and nothing repaints.
 *
 */

export const metadata: Metadata = {
  title: { default: 'Kiln', template: 'Kiln — %s' },
  description: 'AI video content pipeline — trend to published, with the cost attached.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read before render so the scale is on <html> at first paint. Reading it in an effect
  // instead renders every page once at 100% and then jumps, and on the display this exists
  // for the jump is from unreadable to readable — on every navigation.
  const [uiScale, rail, look] = await Promise.all([readUiScale(), railData(), htmlAppearance()]);

  return (
    // The colour theme is set here from the cookie rather than resolved after hydration, so
    // there is no flash of the wrong theme. Settings → Appearance writes the same attribute.
    <html
      lang="en"
      data-theme={look['data-theme']}
      className={`${fontVariables} ${look.className}`.trim()}
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
        <AppShell data={rail}>
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
