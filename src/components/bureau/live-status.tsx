'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { isRunning } from '@/lib/bureau/running';

/**
 * Re-reads the page every few seconds while something is running, so a step's progress
 * ("rendering video (1 of 3) · 42%") moves without a manual reload. Stops when nothing runs,
 * and while the tab is hidden (a phone in a pocket polls nothing); on coming back it re-reads
 * at once instead of waiting out the interval. `router.refresh()` keeps scroll and input state
 * — only the server data changes.
 */
export function LiveRefresh({ active, everyMs = 8_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (t === null) t = setInterval(() => router.refresh(), everyMs);
    };
    const stop = () => {
      if (t !== null) clearInterval(t);
      t = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, everyMs, router]);
  return null;
}

/** What a running status says when the worker has not written a progress line. */
const IDLE_LINE: Record<string, string> = {
  cut_approved: 'approved — rendering the final files and building the bundle',
};

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

/**
 * What a running episode is doing right now, and how fresh that is. A pulsing dot while it
 * runs; the worker's own progress line (status_detail) beside it; "last update" so a stalled
 * run is visible as a growing number rather than a screen that merely looks still.
 */
export function LiveStatus({ status, detail, updatedAt, running: force }: { status: string; detail: string | null; updatedAt: string; /** Work that runs without changing the status (a redraw on an awaiting cut). */ running?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const running = force ?? isRunning(status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [running]);
  if (!running) return null;
  const stale = now - new Date(updatedAt).getTime() > 10 * 60_000;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs" role="status" aria-live="polite">
      <span
        className="inline-block h-2 w-2 rounded-full motion-safe:animate-pulse"
        style={{ background: stale ? 'var(--rev)' : 'var(--gen)' }}
        aria-hidden
      />
      <span style={{ color: 'var(--t2)' }}>{detail ?? IDLE_LINE[status] ?? `${status}…`}</span>
      <span className="font-mono" style={{ color: stale ? 'var(--rev)' : 'var(--t3)' }}>
        last update {ago(updatedAt, now)}
        {stale ? ' — no progress for 10+ min; after 30 the Board offers Restart run' : ''}
      </span>
    </div>
  );
}
