import type { Metadata } from 'next';
import { Ambient } from '@/components/glass/ambient';
import { htmlAppearance } from '@/lib/appearance/read';

import { fontVariables } from '../fonts';

import '../globals.css';

/**
 * Root layout for setup.
 *
 * Deliberately without the app shell. Every destination in that sidebar is blocked until
 * setup finishes, and offering navigation you cannot use is how a gate quietly becomes a
 * suggestion — the screen would be saying "you can't use this yet" while displaying a
 * full menu of the things you can't use.
 *
 * This is a second *root* layout, which is why `(app)` and `(setup)` are top-level route
 * groups: Next permits multiple roots only that way, and each must render its own <html>
 * and <body>. The cost is that the two roots can drift — if you change fonts or the theme
 * attribute in one, change it in the other.
 */

export const metadata: Metadata = {
  title: 'Kiln — first run',
  description: 'Set up the pipeline before it can spend anything.',
};

export default async function SetupRootLayout({ children }: { children: React.ReactNode }) {
  const look = await htmlAppearance();
  return (
    <html lang="en" data-theme={look['data-theme']} className={`${fontVariables} ${look.className}`.trim()}>
      <body>
        {/* The setup frame sits on the same ambient glow as the app, in the theme's colours. */}
        <Ambient />
        <div className="lay">{children}</div>
      </body>
    </html>
  );
}
