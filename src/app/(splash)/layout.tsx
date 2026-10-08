import type { Metadata } from 'next';
import { htmlAppearance } from '@/lib/appearance/read';

import { fontVariables } from '../fonts';

import '../globals.css';

/**
 * Root layout for the splash.
 *
 * Deliberately bare — no shell, no sidebar, no data fetching beyond the auth check the page
 * itself does. The splash's whole job is to decide where the visit goes and to have already
 * started fetching whatever it decides on, so anything it renders that is not the LCP
 * element is competing with the thing it is supposed to be accelerating.
 */

export const metadata: Metadata = {
  title: 'Kiln',
  description: 'AI video content pipeline — trend to published, with the cost attached.',
};

export default async function SplashLayout({ children }: { children: React.ReactNode }) {
  const look = await htmlAppearance();
  return (
    <html lang="en" data-theme={look['data-theme']} className={`${fontVariables} ${look.className}`.trim()}>
      <body>{children}</body>
    </html>
  );
}
