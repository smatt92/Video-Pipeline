'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { SETTINGS_SECTIONS } from '@/lib/settings/sections';

/**
 * Settings sections as the canvas's tab row (Integrations artboard). Unbuilt sections stay
 * visible, disabled, with their reason as the tooltip — a nav that hides what is missing
 * hides the shape of the product.
 */
export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="tabs" aria-label="Settings sections">
      <Link href="/channels" className={pathname.startsWith('/channels') ? 'on' : undefined}>
        Channels
      </Link>
      {SETTINGS_SECTIONS.map((s) => {
        const href = `/settings/${s.slug}`;
        const on = pathname === href || (pathname === '/settings' && s.slug === 'integrations');
        return s.status.kind === 'scaffolded' ? (
          <span key={s.slug} aria-disabled="true" title={`${s.hint}. ${s.status.reason}.`}>
            {s.label} <span className="badge">{s.status.phase}</span>
          </span>
        ) : (
          <Link key={s.slug} href={href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined} title={s.hint}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
