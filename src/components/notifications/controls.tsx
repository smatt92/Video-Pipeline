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
export function FallbackDecision({ episodeId }: { episodeId: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
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
