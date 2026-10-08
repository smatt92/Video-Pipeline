/**
 * Token values written out as literals, for the few consumers that are not CSS: the PWA
 * manifest (read by the OS) and email / PDF renderers (no stylesheet). Each mirrors a token in
 * tokens.css — change both together. Lives under src/styles/ because that is the one place
 * raw colour values are allowed (eslint-rules/no-primitive-tokens.mjs).
 */
export const BRAND_HEX = {
  /** --base (oklch 0.18 0.006 70) */ page: '#13110F',
  /** --base-2 (oklch 0.14 0.006 70) */ inset: '#0B0907',
  /** --navy */ navy: '#0F1B30',
  /** --chalk */ chalk: '#F2EFE8',
  /** --act-solid, Mint (the default theme) */ accent: '#98F899',
  /** --paper */ paper: '#F8F6F2',
  /** --paper-2 */ paper2: '#EFECE7',
  /** --paper-b */ paperBorder: '#DAD7D2',
  /** --ink */ ink: '#1D1B19',
  /** --ink-2 */ ink2: '#56524E',
  /** --ac-on-paper (oklch 0.42 0.11 150) */ accentOnPaper: '#0B5D2A',
  /** --rev (oklch 0.82 0.14 78) */ ochre: '#F6B84D',
} as const;

/**
 * Channel accents offered by + Add channel (canvas: Onb-ChBasics). Stored on the channel's
 * bible as `accent_hex` — data, read back by every screen that draws the channel square.
 * Teal first: it is the Bureau's, and a second channel should pick another.
 */
export const CHANNEL_ACCENTS = [
  { name: 'Teal', hex: '#5FD3C2' },
  { name: 'Lime', hex: '#B5D95A' },
  { name: 'Ochre', hex: '#E0A55C' },
  { name: 'Orchid', hex: '#D98AC6' },
  { name: 'Sky', hex: '#7FB2F0' },
  { name: 'Chalk', hex: '#E4DFD4' },
] as const;
