'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { KillSwitch } from '@/components/glass/kill-switch';
import { Menu } from '@/components/ui/controls';
import { Icon, type IconName } from '@/components/ui/icon';
import { KilnMark } from '@/components/ui/logo';
import { ALL_NAV_ITEMS, NAV } from '@/lib/nav';
import type { RailData } from '@/lib/shell/rail';

import { LinkPending } from './nav-feedback';
import { badgeFor, ChannelAvatar, ChannelMenuItems, isActive, useSwitchChannel } from './nav-parts';

/**
 * The top bar (canvas: GlassHome header). Logo → Home; "/" and the channel switcher; the
 * section pill tabs; search, the bell with its unread count, and the physical kill switch.
 *
 * Six tabs, as on the canvas, and a More pill that opens every other screen grouped as the
 * old rail grouped them, with the same badges — so nothing the rail reached is unreachable.
 * On a phone the tabs move to the glass tab bar at the bottom (tab-bar.tsx) and this bar
 * keeps the logo, the switcher, the bell and the kill switch, as GlassHomeM does.
 */

export const TOP_TABS = ['/home', '/studio', '/bureau/approvals', '/bureau/cuts', '/bureau/ready', '/bureau/board'] as const;

export function TopBar({ data, onOpenPalette }: { data: RailData; onOpenPalette: () => void }) {
  const pathname = usePathname();
  const allSelected = pathname === '/all';
  const activeIdx = data.channels.findIndex((c) => c.id === data.activeId);
  const active = activeIdx >= 0 ? data.channels[activeIdx]! : null;
  const { go, pending, error } = useSwitchChannel();
  const tabs = TOP_TABS.map((h) => ALL_NAV_ITEMS.find((i) => i.href === h)!).filter(Boolean);
  const moreGroups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !(TOP_TABS as readonly string[]).includes(i.href) && i.href !== '/notifications') })).filter((g) => g.items.length);
  const moreOn = !TOP_TABS.some((h) => isActive(pathname, h)) && pathname !== '/notifications';
  const unread = data.counts.unread;
  const bellName = unread === null ? 'Notifications' : unread === 0 ? 'Notifications, none unread' : `Notifications, ${unread} unread`;

  return (
    <header className="gtop">
      <div className="row gtop-l" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
        <Link href={allSelected ? '/all' : '/home'} className="gtop-logo" aria-label="Kiln home">
          <KilnMark size={26} />
          <span className="gtop-wm desk-only">kiln</span>
        </Link>
        <span className="t4 gtop-slash" aria-hidden="true">
          /
        </span>
        <Menu
          label="Channels"
          align="left"
          trigger={({ open, toggle, id, ref }) => (
            <button
              ref={ref}
              type="button"
              className="gtop-ch"
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? id : undefined}
              aria-label={`Switch channel — now ${allSelected ? 'All channels' : (active?.name ?? 'no channel')}`}
              disabled={pending}
            >
              {!allSelected && active && <ChannelAvatar ch={active} size="md" alt={activeIdx % 2 === 1} />}
              <span className="gtop-chn">{allSelected ? 'All channels' : (active?.name ?? 'No channel yet')}</span>
              <Icon name="down" size={14} className="t3" />
            </button>
          )}
        >
          <ChannelMenuItems data={data} allSelected={allSelected} onSwitch={(id) => go(id)} />
        </Menu>
        {error && (
          <span className="xs" role="alert" style={{ color: 'var(--blk-text)' }}>
            {error}
          </span>
        )}
      </div>

      <nav className="tabs gtop-tabs" aria-label="Sections">
        {tabs.map((t) => {
          const on = isActive(pathname, t.href);
          const b = badgeFor(t, data.counts);
          return (
            <Link key={t.href} href={t.href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
              <LinkPending />
              {t.label}
              {b && (
                <span className={`tbadge${b.red ? ' red' : ''}`} aria-label={`${b.n} waiting`}>
                  {b.n}
                </span>
              )}
            </Link>
          );
        })}
        <Menu
          label="More screens"
          align="right"
          trigger={({ open, toggle, id, ref }) => (
            <button
              ref={ref}
              type="button"
              className={moreOn ? 'on' : undefined}
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? id : undefined}
            >
              More
              <Icon name="down" size={14} />
            </button>
          )}
        >
          <div className="gmore">
            {moreGroups.map((g) => (
              <div key={g.label} className="nav">
                <span className="lbl nav-h">{g.label === 'Bureau' && active && !allSelected ? active.name : g.label}</span>
                {g.items.map((it) => {
                  const b = badgeFor(it, data.counts);
                  const on = isActive(pathname, it.href);
                  return (
                    <Link key={it.href} href={it.href} role="menuitem" className={`ni${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
                      <LinkPending />
                      <Icon name={it.icon as IconName} />
                      <span>{it.label}</span>
                      {b && <span className={`badge ${b.red ? 'red' : 'ac'}`}>{b.n}</span>}
                    </Link>
                  );
                })}
              </div>
            ))}
            <div className="nav">
              <span className="lbl nav-h">{data.user?.name ?? 'Signed in'} · approver</span>
              {data.setup && (
                <Link href="/setup" role="menuitem" className="ni">
                  <Icon name="setup" />
                  <span>Finish setup</span>
                  <span className="badge ac">
                    {data.setup.done}/{data.setup.total}
                  </span>
                </Link>
              )}
              <form action="/auth/signout" method="post" style={{ display: 'contents' }}>
                <button type="submit" role="menuitem" className="ni">
                  <Icon name="back" />
                  <span>Sign out</span>
                </button>
              </form>
            </div>
          </div>
        </Menu>
      </nav>

      <div className="row gtop-r" style={{ gap: 12, flexWrap: 'nowrap' }}>
        <button type="button" className="ibtn desk-only" aria-label="Search or jump (⌘K)" onClick={onOpenPalette}>
          <Icon name="search" />
        </button>
        <Link href="/notifications" className={`ibtn${pathname === '/notifications' ? ' on' : ''}`} aria-label={bellName} aria-current={pathname === '/notifications' ? 'page' : undefined}>
          <Icon name="bell" />
          {unread !== null && unread > 0 && <span className="badge">{unread}</span>}
        </Link>
        <KillSwitch kill={data.kill} channelId={allSelected ? null : data.activeId} />
      </div>
    </header>
  );
}
