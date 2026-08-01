import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

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

export default function SetupRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
