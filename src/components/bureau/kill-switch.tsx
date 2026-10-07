'use client';

import { useState, useTransition } from 'react';

import { killSwitchAction } from '@/lib/bureau/ui-actions';

export function KillSwitch({ on, channelId }: { on: boolean; channelId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        className="min-h-11 rounded-md border px-3 text-sm font-medium"
        style={{ borderColor: 'var(--danger)', color: on ? 'var(--accent)' : 'var(--danger)' }}
        onClick={() => {
          if (on) {
            if (!window.confirm('Turn the kill switch OFF and resume generation and publishing?')) return;
            start(async () => setMsg((await killSwitchAction(channelId, false, '')).message));
          } else {
            const reason = window.prompt('Kill switch ON — no new generation claims, no publishing. Reason (logged):');
            if (!reason) return;
            start(async () => setMsg((await killSwitchAction(channelId, true, reason)).message));
          }
        }}
      >
        {on ? 'Resume (turn kill switch off)' : 'Kill switch'}
      </button>
      {msg && <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>{msg}</p>}
    </div>
  );
}
