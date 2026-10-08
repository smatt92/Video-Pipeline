'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
import { NAV } from '@/lib/nav';
import type { RailData } from '@/lib/shell/rail';

import { LinkPending } from './nav-feedback';
import { badgeFor, ChannelAvatar, isActive, useSwitchChannel } from './nav-parts';

/**
 * Phone glass tab bar (canvas: GlassHomeM) — Home, Approvals, Cuts, Board, More — floating
 * over the ambient layer, and the More sheet: search, the channel switcher, then every other
 * screen grouped as on the top bar's More menu. Shown below 768px, where the top bar keeps
 * only the logo, switcher, bell and kill switch.
 */

const MORE_PATH = 'M3.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M17.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0';

export function TabBar({ data }: { data: RailData }) {
  const pathname = usePathname();
  const [more, setMore] = useState(false);
  const tabs = NAV.flatMap((g) => g.items).filter((i) => i.tab);
  const onTab = tabs.some((t) => isActive(pathname, t.href));

  useEffect(() => setMore(false), [pathname]);

  return (
    <>
      {more && <MoreSheet data={data} onClose={() => setMore(false)} />}
      <nav className="tbar gp" aria-label="Primary">
        {tabs.map((t) => {
          const on = isActive(pathname, t.href) && !more;
          const b = badgeFor(t, data.counts);
          return (
            <Link key={t.href} href={t.href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>
              <LinkPending />
              <Icon name={t.icon as IconName} />
              <span>{t.label}</span>
              {b && (
                <span className={`badge${b.red ? '' : ' act'}`} aria-label={`${b.n} waiting`}>
                  {b.n}
                </span>
              )}
            </Link>
          );
        })}
        <button type="button" className={more || !onTab ? 'on' : undefined} aria-expanded={more} aria-haspopup="dialog" onClick={() => setMore((m) => !m)}>
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d={MORE_PATH} />
          </svg>
          <span>More</span>
        </button>
      </nav>
    </>
  );
}

function MoreSheet({ data, onClose }: { data: RailData; onClose: () => void }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const { go, pending, error } = useSwitchChannel();
  const allSelected = pathname === '/all';

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.tab) })).filter((g) => g.items.length);

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="More" ref={ref} tabIndex={-1}>
        <div className="sheet-grab" aria-hidden="true" />
        <div className="row sb">
          <span className="h2">More</span>
          <button type="button" className="btn ghost icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <button
          type="button"
          className="mrow card"
          style={{ flex: 'none' }}
          onClick={() => {
            onClose();
            window.dispatchEvent(new Event('kiln:palette'));
          }}
        >
          <Icon name="search" />
          <span className="grow">Search or jump</span>
        </button>
        <span className="lbl">Channel</span>
        {/* flex: none — a direct child of the scrolling sheet with overflow hidden may shrink to
            nothing, and on a phone the channel list did exactly that: a hairline, no channels. */}
        <section className="card" style={{ overflow: 'hidden', flex: 'none' }}>
          <Link className={`mrow${allSelected ? ' on' : ''}`} href="/all">
            <ChannelAvatar ch="all" size="md" />
            <span className="grow">All channels</span>
            {allSelected && <Icon name="check" className="tac" />}
          </Link>
          {data.channels.map((c, i) => {
            const on = !allSelected && c.id === data.activeId;
            return (
              <button key={c.id} type="button" className={`mrow${on ? ' on' : ''}`} disabled={pending} onClick={() => go(c.id)}>
                <ChannelAvatar ch={c} size="md" alt={i % 2 === 1} />
                <span className="col grow" style={{ gap: 0, lineHeight: 1.25 }}>
                  <span>{c.name}</span>
                  <span className="mono xs t3">{c.handle ?? 'no handle'}</span>
                </span>
                {on && <Icon name="check" className="tac" />}
              </button>
            );
          })}
          <Link className="mrow" href="/setup/basics?new=1">
            <ChannelAvatar ch="add" size="md" />
            <span className="grow t2">Add channel</span>
          </Link>
        </section>
        {error && (
          <p className="xs" style={{ color: 'var(--blk-text)' }} role="alert">
            {error}
          </p>
        )}
        {groups.map((g) => (
          <div key={g.label} className="col" style={{ gap: 8 }}>
            <span className="lbl" style={{ marginTop: 6 }}>
              {g.label}
            </span>
            <section className="card" style={{ overflow: 'hidden' }}>
              {g.items.map((it) => {
                const b = badgeFor(it, data.counts);
                return (
                  <Link key={it.href} className={`mrow${isActive(pathname, it.href) ? ' on' : ''}`} href={it.href}>
                    <LinkPending />
                    <Icon name={it.icon as IconName} />
                    <span className="grow">{it.label}</span>
                    {b && <span className={`badge ${b.red ? 'red' : 'ac'}`}>{b.n}</span>}
                  </Link>
                );
              })}
            </section>
          </div>
        ))}
        <section className="card" style={{ overflow: 'hidden', flex: 'none' }}>
          <form action="/auth/signout" method="post" style={{ display: 'contents' }}>
            <button type="submit" className="mrow">
              <Icon name="back" />
              <span className="grow">Sign out{data.user ? ` · ${data.user.name}` : ''}</span>
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
