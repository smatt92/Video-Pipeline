'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Icon, type IconName } from '@/components/ui/icon';
import { KilnMark, Wordmark } from '@/components/ui/logo';
import { Menu } from '@/components/ui/controls';
import { killSwitchAction } from '@/lib/bureau/ui-actions';
import { setActiveChannelAction } from '@/lib/channels/actions';
import { NAV, type NavItem } from '@/lib/nav';

import { LinkPending } from './nav-feedback';
import type { RailChannel, RailData } from '@/lib/shell/rail';

/**
 * The Rail (canvas: Rail). Lockup → home, channel switcher (All channels / each channel /
 * + Add channel), ⌘K, grouped nav with badges from real counts, kill switch and the user at
 * the foot. Desktop only — below 768px the tab bar and the More sheet carry the same items.
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

export function ChannelAvatar({ ch, size }: { ch: RailChannel | 'all' | 'add'; size?: 'sm' | 'lg' }) {
  const sz = size ? ` ${size}` : '';
  if (ch === 'all')
    return (
      <div className={`av all${sz}`} aria-hidden="true">
        <Icon name="channels" size={size === 'sm' ? 13 : 16} />
      </div>
    );
  if (ch === 'add')
    return (
      <div className={`av add${sz}`} aria-hidden="true">
        +
      </div>
    );
  return (
    <div className={`av${sz}`} aria-hidden="true">
      {ch.initials}
    </div>
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
        <ChannelAvatar ch="all" size="sm" />
        <span>All channels</span>
      </Link>
      {data.channels.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          className={`ni${!allSelected && c.id === data.activeId ? ' on' : ''}`}
          onClick={() => onSwitch(c.id)}
        >
          <ChannelAvatar ch={c} size="sm" />
          <span className="col" style={{ gap: 0, lineHeight: 1.2, minWidth: 0 }}>
            <span>{c.name}</span>
            <span className="mono xs t3">{c.handle ?? (c.hasBible ? 'no handle' : 'no bible yet')}</span>
          </span>
        </button>
      ))}
      <div className="hr" style={{ margin: '4px 0' }} />
      <Link className="ni" href="/setup/basics?new=1" role="menuitem">
        <ChannelAvatar ch="add" size="sm" />
        <span>Add channel</span>
      </Link>
    </>
  );
}

export function KillSwitchRow({ kill, channelId, compact }: { kill: RailData['kill']; channelId: string | null; compact?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const on = kill?.on ?? false;
  const unknown = kill === null || channelId === null;

  const toggle = () => {
    if (!channelId) return;
    if (on) {
      if (!window.confirm('Turn the kill switch off and let generation and publishing resume?')) return;
      start(async () => {
        setMsg((await killSwitchAction(channelId, false, '')).message);
        router.refresh();
      });
    } else {
      const reason = window.prompt('Stop the pipeline: no new generation claims, no publishing. Reason (logged verbatim):');
      if (!reason) return;
      start(async () => {
        setMsg((await killSwitchAction(channelId, true, reason)).message);
        router.refresh();
      });
    }
  };

  return (
    <div className="inset" style={{ padding: compact ? '10px 14px' : '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <Icon name="power" className={on ? 'tblk' : 't3'} />
      <div className="col grow" style={{ gap: 0 }}>
        <span className="sm" style={{ fontWeight: 500 }}>
          Kill switch
        </span>
        <span className="xs t3" title={kill?.reason ?? undefined}>
          {channelId === null ? 'Per channel · pick one to change it' : kill === null ? 'No policy row for this channel' : on ? `On · ${kill?.reason ?? 'stopped'}` : 'Off · pipeline running'}
        </span>
        {msg && (
          <span className="xs t2" role="status">
            {msg}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? 'Kill switch is on — turn off' : 'Kill switch is off — turn on'}
        className={`sw${on ? ' on' : ''}`}
        disabled={pending || unknown}
        onClick={toggle}
      />
    </div>
  );
}

export function Rail({ data, onOpenPalette }: { data: RailData; onOpenPalette: () => void }) {
  const pathname = usePathname();
  const allSelected = pathname === '/all';
  const active = data.channels.find((c) => c.id === data.activeId) ?? null;
  const { go, pending, error } = useSwitchChannel();

  return (
    <nav className="rail" aria-label="Kiln">
      <div className="row sb" style={{ padding: '2px 4px 0 6px' }}>
        <Link href={allSelected ? '/all' : '/home'} className="lockup" style={{ fontSize: 19, textDecoration: 'none' }} aria-label="Kiln home">
          <KilnMark size={22} />
          <Wordmark />
        </Link>
        <span className="mono xs t3" aria-hidden="true">
          v2
        </span>
      </div>

      <Menu
        label="Channels"
        trigger={({ open, toggle, id, ref }) => (
          <button
            ref={ref}
            className="chsw"
            type="button"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            disabled={pending}
          >
            {allSelected || !active ? <ChannelAvatar ch="all" /> : <ChannelAvatar ch={active} />}
            <div className="col grow" style={{ gap: 1 }}>
              <span className="nm">{allSelected ? 'All channels' : active?.name ?? 'No channel yet'}</span>
              <span className="hd">
                {allSelected
                  ? `${data.channels.length} channel${data.channels.length === 1 ? '' : 's'} · combined`
                  : active?.handle ?? (active ? 'no handle' : 'add one to start')}
              </span>
            </div>
            <Icon name="updown" className="t3" />
          </button>
        )}
      >
        <ChannelMenuItems data={data} allSelected={allSelected} onSwitch={(id) => go(id)} />
      </Menu>
      {error && (
        <p className="xs" style={{ color: 'var(--blk-text)' }} role="alert">
          {error}
        </p>
      )}

      <button className="cmdk" type="button" onClick={onOpenPalette}>
        <Icon name="search" />
        Search or jump
        <span className="kbd">⌘K</span>
      </button>

      {NAV.map((g) => (
        <div className="nav" key={g.label}>
          <span className="lbl nav-h">{g.label === 'Bureau' && active && !allSelected ? active.name.split(' ')[0] : g.label}</span>
          {g.items.map((it) => {
            const on = isActive(pathname, it.href);
            const b = badgeFor(it, data.counts);
            if (it.status.kind === 'disabled') {
              return (
                <span key={it.href} className="ni" aria-disabled="true" title={`${it.hint}. ${it.status.reason}.`}>
                  <Icon name={it.icon as IconName} />
                  <span>{it.label}</span>
                  <span className="badge">{it.status.phase}</span>
                </span>
              );
            }
            return (
              <Link key={it.href} href={it.href} className={`ni${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
                <LinkPending />
                <Icon name={it.icon as IconName} />
                <span>{it.label}</span>
                {b && (
                  <span className={`badge ${b.red ? 'red' : 'ac'}`} aria-label={`${b.n} waiting`}>
                    {b.n}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}

      <div className="rail-foot">
        {data.setup && (
          <Link href="/setup" className="ni" style={{ border: '1px dashed var(--b2)' }}>
            <Icon name="setup" />
            <span>Finish setup</span>
            <span className="badge ac">
              {data.setup.done}/{data.setup.total}
            </span>
          </Link>
        )}
        <KillSwitchRow kill={data.kill} channelId={allSelected ? null : data.activeId} />
        <div className="row" style={{ gap: 10, padding: '4px 6px', flexWrap: 'nowrap' }}>
          <div className="avatar-user" aria-hidden="true">
            {data.user?.initials ?? '—'}
          </div>
          <div className="col grow" style={{ gap: 0, lineHeight: 1.25 }}>
            <span className="sm">{data.user?.name ?? 'Signed in'}</span>
            <span className="xs t3">approver</span>
          </div>
          <Link className="btn ghost sm icon" href="/settings" aria-label="Settings">
            <Icon name="settings" />
          </Link>
          <form action="/auth/signout" method="post" style={{ display: 'contents' }}>
            <button type="submit" className="btn ghost sm" title="Sign out">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
