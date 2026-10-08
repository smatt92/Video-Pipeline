'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Icon } from '@/components/ui/icon';
import { setActiveChannelAction } from '@/lib/channels/actions';
import type { NavItem } from '@/lib/nav';
import type { RailChannel, RailData } from '@/lib/shell/rail';

/**
 * Parts the top bar, the phone tab bar and its More sheet share (Kiln Glass, 08-Oct): which
 * nav item is active, its badge from real counts, the channel avatar and the switcher.
 *
 * The left rail these lived in is gone. The design's top bar carries the six screens Sahil
 * uses daily as pill tabs (Home, Studio, Approvals, Cuts, Ready, Board) and everything else
 * — 19 more items in four groups — in a More menu beside them; a rail beside a top bar would
 * have been two navigations for one app, and the rail's last jobs (switcher, kill switch,
 * search) all have a place on the bar.
 */

export function isActive(pathname: string, href: string): boolean {
  if (href === '/home') return pathname === '/home';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function badgeFor(item: NavItem, counts: RailData['counts']): { n: number; red: boolean } | null {
  if (!item.badge) return null;
  const n = counts[item.badge];
  // null = could not be read → no badge, never a 0. 0 → nothing waiting → no badge either.
  if (n === null || n === 0) return null;
  return { n, red: item.badge === 'blocked' || item.badge === 'genFailed' };
}

/** Channel avatar (Kiln Glass `.cav`): the second channel gets the bronze, so two never look alike. */
export function ChannelAvatar({ ch, size, alt }: { ch: RailChannel | 'all' | 'add'; size?: 'sm' | 'md' | 'lg'; alt?: boolean }) {
  const sz = size ? ` ${size}` : '';
  if (ch === 'all')
    return (
      <span className={`cav all${sz}`} aria-hidden="true">
        <Icon name="channels" size={size === 'sm' ? 12 : 15} />
      </span>
    );
  if (ch === 'add')
    return (
      <span className={`cav all${sz}`} aria-hidden="true">
        +
      </span>
    );
  return (
    <span className={`cav${alt ? ' alt' : ''}${sz}`} aria-hidden="true">
      {ch.initials}
    </span>
  );
}

export function useSwitchChannel() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (id: string, to = '/home') =>
    start(async () => {
      setError(null);
      const r = await setActiveChannelAction(id);
      if (!r.ok) {
        setError(r.message ?? 'Could not switch channel.');
        return;
      }
      router.push(to);
      router.refresh();
    });
  return { go, pending, error };
}

export function ChannelMenuItems({ data, allSelected, onSwitch }: { data: RailData; allSelected: boolean; onSwitch: (id: string) => void }) {
  return (
    <>
      <Link className={`ni${allSelected ? ' on' : ''}`} href="/all" role="menuitem">
        <ChannelAvatar ch="all" size="md" />
        <span>All channels</span>
      </Link>
      {data.channels.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          className={`ni${!allSelected && c.id === data.activeId ? ' on' : ''}`}
          onClick={() => onSwitch(c.id)}
        >
          <ChannelAvatar ch={c} size="md" alt={i % 2 === 1} />
          <span className="col" style={{ gap: 0, lineHeight: 1.2, minWidth: 0 }}>
            <span>{c.name}</span>
            <span className="mono xs t3">{c.handle ?? (c.hasBible ? 'no handle' : 'no bible yet')}</span>
          </span>
        </button>
      ))}
      <div className="hr" style={{ margin: '4px 0' }} />
      <Link className="ni" href="/setup/basics?new=1" role="menuitem">
        <ChannelAvatar ch="add" size="md" />
        <span>Add channel</span>
      </Link>
    </>
  );
}
