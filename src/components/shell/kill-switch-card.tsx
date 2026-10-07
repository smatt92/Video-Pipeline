'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { killSwitchAction } from '@/lib/bureau/ui-actions';

/**
 * Kill switch card (canvas: Home, Generation). On = stopped: no new generation claims, no
 * publishing. Turning it on asks for a reason (logged verbatim); turning it off asks to
 * confirm. The server action checks the approver; this only asks.
 */
export function KillSwitchCard({
  channelId,
  channelName,
  on,
  reason,
  known,
  compact,
}: {
  channelId: string;
  channelName: string;
  on: boolean;
  reason: string | null;
  known: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const toggle = () => {
    if (on) {
      if (!window.confirm(`Turn the kill switch off for ${channelName}? Generation and publishing resume.`)) return;
      start(async () => {
        const r = await killSwitchAction(channelId, false, '');
        setMsg(r.message);
        router.refresh();
      });
    } else {
      const why = window.prompt(`Stop ${channelName}: no new generation claims, no publishing. Reason (logged verbatim):`);
      if (!why) return;
      start(async () => {
        const r = await killSwitchAction(channelId, true, why);
        setMsg(r.message);
        router.refresh();
      });
    }
  };

  return (
    <section className={`side card${compact ? '' : ''}`} style={{ borderColor: 'var(--blk-line)' }} aria-label="Kill switch">
      <div className="card-h">
        <h2 className="h3">Kill switch</h2>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={on ? 'Kill switch is on — turn off' : 'Kill switch is off — turn on'}
          className={`sw${on ? ' on' : ''}`}
          disabled={pending || !known}
          onClick={toggle}
        />
      </div>
      <div className="card-b col" style={{ gap: 10 }}>
        <span className="sm t2">{!known ? 'No policy row for this channel — nothing to switch.' : on ? `On — ${reason ?? 'stopped'}` : 'Off · pipeline running'}</span>
        <p className="xs t3">Halts every queued and in-flight job for {channelName}, and stops spend. Asks to confirm. Approver only.</p>
        {msg && (
          <p className="xs t2" role="status">
            {msg}
          </p>
        )}
      </div>
    </section>
  );
}
