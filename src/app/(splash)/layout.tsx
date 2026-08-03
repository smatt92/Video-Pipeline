import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';

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

export default function SplashLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
