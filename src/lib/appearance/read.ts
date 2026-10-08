import 'server-only';

import { cookies } from 'next/headers';

import { surfaceFrom, SURFACE_COOKIE, themeFrom, THEME_COOKIE, type Surface, type ThemeId } from '@/styles/themes';

/**
 * The viewer's colour theme and surface (glass or solid), from cookies, for the root layouts.
 *
 * Read on the server so `data-theme` and `.solid` are on <html> in the first byte of HTML:
 * there is no frame painted in Mint and then repainted in Ember. A cookie rather than the
 * profile row because it is per browser — a phone in Solid and a desktop in Glass is a
 * reasonable thing to want — and because the sign-in and setup screens render before there
 * is a profile to read. Anything unreadable is Mint on glass, never an error.
 */
export async function readAppearance(): Promise<{ theme: ThemeId; surface: Surface }> {
  try {
    const jar = await cookies();
    return { theme: themeFrom(jar.get(THEME_COOKIE)?.value), surface: surfaceFrom(jar.get(SURFACE_COOKIE)?.value) };
  } catch {
    return { theme: themeFrom(null), surface: surfaceFrom(null) };
  }
}

/** The attributes every root layout puts on <html>. */
export async function htmlAppearance(): Promise<{ 'data-theme': ThemeId; className: string }> {
  const { theme, surface } = await readAppearance();
  return { 'data-theme': theme, className: surface === 'solid' ? 'solid' : '' };
}
