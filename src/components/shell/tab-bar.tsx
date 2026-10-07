'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
import { NAV } from '@/lib/nav';
import type { RailData } from '@/lib/shell/rail';

import { badgeFor, ChannelAvatar, isActive, KillSwitchRow, useSwitchChannel } from './rail';

/**
 * Mobile tab bar (canvas: TabBar) — Home, Approvals, Cuts, Board, More — and the More sheet
 * (canvas: More-m): channel switcher, then every other item, grouped as on the rail. Shown
 * below 768px; the Rail is hidden there.
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
      <nav className="tabbar" aria-label="Primary">
        {tabs.map((t) => {
          const on = isActive(pathname, t.href) && !more;
          const b = badgeFor(t, data.counts);
          return (
            <Link key={t.href} href={t.href} className={`tab${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
              <Icon name={t.icon as IconName} />
              <span>{t.label}</span>
              {b && (
                <span className={`bdg${b.red ? ' red' : ''}`} aria-label={`${b.n} waiting`}>
                  {b.n}
                </span>
              )}
            </Link>
          );
        })}
        <button
          type="button"
          className={`tab${more || !onTab ? ' on' : ''}`}
          aria-expanded={more}
          aria-haspopup="dialog"
          onClick={() => setMore((m) => !m)}
          style={{ background: 'transparent', border: 0, font: 'inherit', cursor: 'pointer' }}
        >
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
        <span className="lbl">Channel</span>
        <section className="card" style={{ overflow: 'hidden' }}>
          <Link className={`mrow${allSelected ? ' on' : ''}`} href="/all">
            <ChannelAvatar ch="all" size="sm" />
            <span className="grow">All channels</span>
            {allSelected && <Icon name="check" className="tac" />}
          </Link>
          {data.channels.map((c) => {
            const on = !allSelected && c.id === data.activeId;
            return (
              <button key={c.id} type="button" className={`mrow${on ? ' on' : ''}`} disabled={pending} onClick={() => go(c.id)}>
                <ChannelAvatar ch={c} size="sm" />
                <span className="col grow" style={{ gap: 0, lineHeight: 1.25 }}>
                  <span>{c.name}</span>
                  <span className="mono xs t3">{c.handle ?? 'no handle'}</span>
                </span>
                {on && <Icon name="check" className="tac" />}
              </button>
            );
          })}
          <Link className="mrow" href="/channels/new">
            <ChannelAvatar ch="add" size="sm" />
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
                    <Icon name={it.icon as IconName} />
                    <span className="grow">{it.label}</span>
                    {b && <span className={`badge ${b.red ? 'red' : 'ac'}`}>{b.n}</span>}
                  </Link>
                );
              })}
            </section>
          </div>
        ))}
        <KillSwitchRow kill={data.kill} channelId={allSelected ? null : data.activeId} compact />
      </div>
    </>
  );
}
