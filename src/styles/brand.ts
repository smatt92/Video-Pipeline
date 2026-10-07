/**
 * Token values written out as literals, for the few consumers that are not CSS: the PWA
 * manifest (read by the OS) and email / PDF renderers (no stylesheet). Each mirrors a token in
 * tokens.css — change both together. Lives under src/styles/ because that is the one place
 * raw colour values are allowed (eslint-rules/no-primitive-tokens.mjs).
 */
export const BRAND_HEX = {
  /** --s0 */ page: '#141210',
  /** --in */ inset: '#0F0E0C',
  /** --navy */ navy: '#0F1B30',
  /** --chalk */ chalk: '#F2EFE8',
  /** --ac (oklch 0.79 0.12 182) */ accent: '#5FD3C2',
  /** --paper */ paper: '#F8F6F2',
  /** --paper-2 */ paper2: '#EFECE7',
  /** --paper-b */ paperBorder: '#DAD7D2',
  /** --ink */ ink: '#1D1B19',
  /** --ink-2 */ ink2: '#56524E',
  /** --ac-on-paper */ accentOnPaper: '#1F7A6E',
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
