'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { acceptFallbackAction, markNotificationsReadAction } from '@/lib/bureau/ui-actions';

/**
 * Marks the channel's alerts read once the centre has been shown — from the browser after the
 * page rendered, never during the render, so a prefetch of /notifications cannot clear the
 * badge for a screen nobody looked at. The rows keep their unread highlight for this view.
 */
export function MarkReadOnView({ channelId, unread }: { channelId: string; unread: number }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || unread === 0) return;
    done.current = true;
    void markNotificationsReadAction(channelId).then((r) => {
      if (r.ok) router.refresh();
    });
  }, [channelId, unread, router]);
  return null;
}

/**
 * The format-fallback decision (fallbacks.ts): "Run as illustrated" accepts it and restarts;
 * leaving it leaves the episode halted, which is the safe default and costs nothing.
 */
export function FallbackDecision({ episodeId, glass }: { episodeId: string; glass?: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [left, setLeft] = useState(false);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const r = await acceptFallbackAction(episodeId);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  // The orb-card form (Kiln Glass "Needs you"): the action and "Leave it", which does nothing
  // on the server — leaving it IS the decision — and says so.
  if (glass)
    return (
      <div className="col" style={{ gap: 6, width: '100%' }}>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="pbtn" style={{ height: 40 }} disabled={pending || msg?.ok === true} onClick={run}>
            {pending ? 'Starting…' : 'Run as illustrated'}
          </button>
          <button type="button" className="gbtn" disabled={pending} onClick={() => setLeft(true)} aria-pressed={left}>
            Leave it
          </button>
        </div>
        {(left || msg) && (
          <span className="xs" role="status" style={{ color: msg && !msg.ok ? 'var(--blk-text)' : 'var(--t2)' }}>
            {msg ? msg.text : 'Left stopped: nothing is spent. Fix the cause, then restart it on Board.'}
          </span>
        )}
      </div>
    );
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn sm pri"
          disabled={pending || msg?.ok === true}
          onClick={() =>
            start(async () => {
              const r = await acceptFallbackAction(episodeId);
              setMsg({ ok: r.ok, text: r.message });
              if (r.ok) router.refresh();
            })
          }
        >
          {pending ? 'Starting…' : 'Run as illustrated'}
        </button>
        <span className="xs t3">Or leave it: the episode stays stopped and nothing is spent. Fix the cause, then restart it on Board.</span>
      </div>
      {msg && (
        <span className="xs" role="status" style={{ color: msg.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
