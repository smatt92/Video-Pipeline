'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { killSwitchAction } from '@/lib/bureau/ui-actions';

/**
 * The physical kill switch (Kiln Glass): a machined knob in a recessed track, red when on.
 * Same mechanism as before — `killSwitchAction` for the active channel, a confirm to turn it
 * off, a logged reason to turn it on. With no channel (All channels) or no policy row it is
 * shown and disabled, and its name says why: a switch that looks live and does nothing is
 * worse than one that says it cannot.
 *
 * `preview` renders the look only (Settings → Appearance): no action, never focusable as a
 * control that does something.
 */
export function KillSwitch({
  kill,
  channelId,
  showLabel = true,
  preview = false,
}: {
  kill: { on: boolean; reason: string | null } | null;
  channelId: string | null;
  showLabel?: boolean;
  preview?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const on = kill?.on ?? false;
  const unknown = !preview && (kill === null || channelId === null);

  const toggle = () => {
    if (preview || !channelId) return;
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

  const name = preview
    ? 'Kill switch (preview)'
    : channelId === null
      ? 'Kill switch — pick a channel to change it'
      : kill === null
        ? 'Kill switch — no policy row for this channel'
        : on
          ? `Kill switch is on${kill.reason ? ` — ${kill.reason}` : ''}. Turn off`
          : 'Kill switch is off — pipeline running. Turn on';

  return (
    <div className="kill" title={msg ?? (on ? kill?.reason ?? 'stopped' : undefined)}>
      {showLabel && <span className={`lbl2${on ? ' on' : ''}`}>{on ? 'Killed' : 'Kill'}</span>}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={name}
        className="kbtn"
        disabled={pending || unknown}
        tabIndex={preview ? -1 : undefined}
        onClick={toggle}
      >
        {/* The track is a child so the button can be a 44px target on a phone around a 32px track. */}
        <span className={`trk${on ? ' on' : ''}`}>
          <span className="knob" />
        </span>
      </button>
      {msg && (
        <span className="sr-only" role="status">
          {msg}
        </span>
      )}
    </div>
  );
}
