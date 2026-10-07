'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { killSwitchAction } from '@/lib/bureau/ui-actions';

/**
 * Kill switch for every channel at once (canvas: AllChannels). Not a new mechanism: it calls
 * the per-channel action once per channel, with one reason, after one confirmation. "On"
 * when every channel is stopped; a mix shows as off, with the count.
 */
export function KillAll({ channels }: { channels: { id: string; name: string; on: boolean }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const stopped = channels.filter((c) => c.on).length;
  const allOn = channels.length > 0 && stopped === channels.length;

  const toggle = () => {
    if (allOn) {
      if (!window.confirm(`Turn the kill switch off for all ${channels.length} channels?`)) return;
      start(async () => {
        const out = [];
        for (const c of channels) out.push(`${c.name}: ${(await killSwitchAction(c.id, false, '')).message}`);
        setMsg(out.join(' · '));
        router.refresh();
      });
    } else {
      const reason = window.prompt(`Stop every channel (${channels.length}): no new generation, no publishing. Reason (logged verbatim on each):`);
      if (!reason) return;
      start(async () => {
        const out = [];
        for (const c of channels.filter((x) => !x.on)) out.push(`${c.name}: ${(await killSwitchAction(c.id, true, reason)).message}`);
        setMsg(out.join(' · '));
        router.refresh();
      });
    }
  };

  return (
    <div className="card card-b col" style={{ borderColor: 'var(--blk-line)', gap: 8 }}>
      <div className="row sb" style={{ flexWrap: 'nowrap' }}>
        <div className="col" style={{ gap: 2 }}>
          <span className="h3">Kill switch · all channels</span>
          <span className="xs t3">
            {allOn ? 'On — every channel is stopped.' : stopped ? `${stopped} of ${channels.length} stopped. Turning it on stops the rest.` : 'Off — halts every channel at once. Asks to confirm.'}
          </span>
        </div>
        <button
          className={`sw${allOn ? ' on' : ''}`}
          type="button"
          role="switch"
          aria-checked={allOn}
          aria-label="Kill switch for all channels"
          disabled={pending || channels.length === 0}
          onClick={toggle}
        />
      </div>
      {msg && (
        <p className="xs t2" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}
