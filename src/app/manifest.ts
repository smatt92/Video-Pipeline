import type { MetadataRoute } from 'next';

import { BRAND_HEX } from '@/styles/brand';

/**
 * PWA manifest (canvas: BrandLogo "App icon · 512 / PWA", BrandAppliedMobile).
 *
 * The icon is the one place the mark goes 3D — clay arch, chalk edge, glowing door on the navy
 * blueprint tile. The maskable copy is the same art without the rounded corner, so Android's
 * own mask cuts the shape; its safe zone is the central 80%, which the arch sits inside.
 * Colours come from
 * BRAND_HEX because a manifest is read by the OS, not by CSS.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Kiln',
    short_name: 'Kiln',
    description: 'AI video studio — trend to published, with the cost attached.',
    start_url: '/home',
    display: 'standalone',
    background_color: BRAND_HEX.page,
    theme_color: BRAND_HEX.inset,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
