import Link from 'next/link';
import type { ReactNode } from 'react';

import { ScreenHeader } from '@/components/shell/screen-header';

const TABS = [
  { href: '/library/voices', label: 'Voices' },
  { href: '/library/prompts', label: 'Prompts' },
  { href: '/library/music', label: 'Music' },
] as const;

/** Library header (canvas: Voices — Prompts and Music reuse its layout). */
export function LibraryHeader({ channel, active, sub }: { channel: { name: string }; active: (typeof TABS)[number]['label']; sub: ReactNode }) {
  return (
    <ScreenHeader
      channel={channel}
      crumb={`Library / ${active}`}
      title={active}
      sub={sub}
      actions={TABS.map((t) => (
        <Link key={t.href} href={t.href} className={`chip${t.label === active ? ' on' : ''}`} aria-current={t.label === active ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    />
  );
}
