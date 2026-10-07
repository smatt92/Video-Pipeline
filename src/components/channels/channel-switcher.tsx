'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { setActiveChannelAction } from '@/lib/channels/actions';

export interface SwitcherChannel {
  id: string;
  name: string;
  handle: string | null;
  hasBible: boolean;
}

/**
 * The active channel, at the top of the sidebar. Per browser (a cookie), defaulting to the
 * oldest channel with a bible. Every channel-scoped screen reads it; an action on a specific
 * row reads the row's channel instead, so switching here never re-targets a decision.
 */
export function ChannelSwitcher({ channels, activeId }: { channels: SwitcherChannel[]; activeId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const active = channels.find((c) => c.id === activeId) ?? null;

  return (
    <div className="px-2 pb-3">
      <label className="sr-only" htmlFor="channel-switcher">Active channel</label>
      <select
        id="channel-switcher"
        className="w-full rounded-sm border px-2 py-1 text-sm"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
        value={activeId ?? ''}
        disabled={pending || channels.length === 0}
        onChange={(e) => {
          const id = e.target.value;
          setError(null);
          start(async () => {
            const r = await setActiveChannelAction(id);
            if (!r.ok) setError(r.message ?? 'Could not switch.');
            router.refresh();
          });
        }}
      >
        {channels.length === 0 && <option value="">No channel yet</option>}
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.handle ? ` · ${c.handle}` : ''}
            {c.hasBible ? '' : ' (no bible)'}
          </option>
        ))}
      </select>
      <div className="mt-1 flex items-center gap-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
        <span className="truncate">{active?.handle ?? (active ? 'no handle' : '')}</span>
        <Link href="/channels/new" className="ml-auto shrink-0" style={{ color: 'var(--accent)' }}>
          + Add channel
        </Link>
      </div>
      {error && <p className="mt-1 text-2xs" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}
