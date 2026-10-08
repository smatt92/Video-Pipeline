import { SectionHeader } from '@/components/settings/parts';
import { Appearance } from '@/components/settings/theme-picker';
import { readAppearance } from '@/lib/appearance/read';

/**
 * Settings → Appearance (Kiln Glass, 08-Oct): the colour theme and glass or solid panels.
 * Built from the canvas board GlassThemes. Per browser, in a cookie the root layouts read
 * before the first paint — lib/appearance/read.ts says why a cookie and not the profile.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Appearance' };

export default async function AppearancePage() {
  const { theme, surface } = await readAppearance();
  return (
    <>
      <SectionHeader
        title="Appearance"
        hint="Six gradient themes on graphite glass. Mint is the default. A theme changes the action colour, the glass tint and the glow — never what a status colour means."
      />
      <Appearance theme={theme} surface={surface} />
    </>
  );
}
