import { Geist_Mono, Urbanist } from 'next/font/google';

/**
 * Kiln Glass type: Urbanist for display, numerals and UI; Geist Mono for data (Sahil, 08-Oct).
 *
 * Through `next/font/google` as the brief asks: the files are downloaded at build time and
 * served from this deployment, so no visitor's browser ever calls the font CDN, and the
 * fallback face is metric-adjusted so the swap does not move the layout. The fallbacks are
 * named fonts on purpose — never the system UI face.
 *
 * The cost the old note in the app layout warned about is real and accepted: a build now
 * needs to reach the font host. Vercel and the CI runner can. A sandbox that cannot sets
 * NEXT_FONT_GOOGLE_MOCKED_RESPONSES (Next's own test hook) to a local copy — see the P4
 * handover — and gets the same CSS.
 *
 * Urbanist with no `weight` is the variable font: one file covers 100–900, so the 200 hero
 * numerals and the 600 buttons cost one download.
 */
export const urbanist = Urbanist({
  subsets: ['latin'],
  variable: '--font-urbanist',
  display: 'swap',
  fallback: ['Arial', 'sans-serif'],
});

export const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
  fallback: ['Menlo', 'Consolas', 'monospace'],
});

/** The class string for <html>: both variables, so every root layout loads the same two faces. */
export const fontVariables = `${urbanist.variable} ${geistMono.variable}`;
