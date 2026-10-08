'use server';

import { cookies } from 'next/headers';
import { z } from 'zod';

import { SURFACE_COOKIE, SURFACES, THEME_COOKIE, THEME_IDS } from '@/styles/themes';

/**
 * Settings → Appearance writes. Zod at the boundary: a Server Action is an HTTP endpoint and
 * the value lands in a cookie every page reads, so only a known theme id or surface is ever
 * written. A year, lax, httpOnly — the browser applies the attribute itself for the instant
 * preview, and the server reads the cookie on the next request.
 */
const AppearanceSchema = z
  .object({
    theme: z.enum(THEME_IDS).optional(),
    surface: z.enum(SURFACES).optional(),
  })
  .strict();

const YEAR = 365 * 24 * 3600;

export async function setAppearanceAction(input: unknown): Promise<{ ok: boolean; message: string }> {
  const parsed = AppearanceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Unknown theme or surface.' };
  const jar = await cookies();
  const opts = { path: '/', maxAge: YEAR, sameSite: 'lax' as const, httpOnly: true, secure: process.env.NODE_ENV === 'production' };
  if (parsed.data.theme) jar.set(THEME_COOKIE, parsed.data.theme, opts);
  if (parsed.data.surface) jar.set(SURFACE_COOKIE, parsed.data.surface, opts);
  return { ok: true, message: 'Saved on this browser.' };
}
