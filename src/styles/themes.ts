/**
 * The six Kiln Glass colour themes, as data for the places that are not CSS: the Appearance
 * picker's labels, the cookie parser and the contrast test. The colours themselves live in
 * tokens.css (`:root[data-theme=…]`); the hex strings here are the gradient stops written
 * out for display, and `pnpm test:contrast` asserts they match the stylesheet, so the two
 * cannot drift. Under src/styles/ because raw colour values are allowed only here
 * (eslint-rules/no-primitive-tokens.mjs).
 */

export const THEME_IDS = ['mint', 'ember', 'ocean', 'aurora', 'rose', 'graphite'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
/** Mint is the default and must always remain available (Sahil, 08-Oct). */
export const DEFAULT_THEME: ThemeId = 'mint';

export const SURFACES = ['glass', 'solid'] as const;
export type Surface = (typeof SURFACES)[number];
export const DEFAULT_SURFACE: Surface = 'glass';

/** Cookie names. Read server-side in every root layout so the first paint is the right theme. */
export const THEME_COOKIE = 'kiln-theme';
export const SURFACE_COOKIE = 'kiln-surface';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  /** The design's class for the theme (glass.css v0.2): .pa … .pf. */
  designClass: string;
  tag: string;
  stops: readonly [string, string, string];
  blurb: string;
}

export const THEMES: readonly ThemeInfo[] = [
  {
    id: 'mint',
    name: 'Mint',
    designClass: 'pa',
    tag: 'default',
    stops: ['#BFF97E', '#98F899', '#CCFFEA'],
    blurb: 'The default. Lime to mint, black ink on the gradient; “ready” is a deeper green with a check so it never reads as a button.',
  },
  {
    id: 'ember',
    name: 'Ember',
    designClass: 'pb',
    tag: 'warm',
    stops: ['#FFC27A', '#FF8A3D', '#FF6A2B'],
    blurb: 'Kiln fire. Blocked moves to crimson-pink so it never reads as ember.',
  },
  {
    id: 'ocean',
    name: 'Ocean',
    designClass: 'pc',
    tag: 'blue',
    stops: ['#9FE2FF', '#5AA8FF', '#8E9BFF'],
    blurb: 'Sky to deep blue. Generating moves to violet so it never reads as the blue action colour.',
  },
  {
    id: 'aurora',
    name: 'Aurora',
    designClass: 'pd',
    tag: 'violet',
    stops: ['#E3B8FF', '#A98BFF', '#7FE0F0'],
    blurb: 'Violet into cyan — the night-sky option.',
  },
  {
    id: 'rose',
    name: 'Rose',
    designClass: 'pe',
    tag: 'soft',
    stops: ['#FFD0DE', '#F59AC2', '#C9A8FF'],
    blurb: 'Pink to lilac. Blocked moves to orange-red so it never reads as rose.',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    designClass: 'pf',
    tag: 'calm',
    stops: ['#F6F6F4', '#C9CDD3', '#EEF0F3'],
    blurb: 'Silver on graphite — almost no colour, for long sessions. Status colours carry all the meaning.',
  },
];

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}

/** An unknown or missing cookie is Mint, never an error: a theme is a preference, not state. */
export function themeFrom(v: string | undefined | null): ThemeId {
  return isThemeId(v) ? v : DEFAULT_THEME;
}

export function surfaceFrom(v: string | undefined | null): Surface {
  return v === 'solid' ? 'solid' : DEFAULT_SURFACE;
}
