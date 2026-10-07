'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { isRunning } from '@/lib/bureau/running';

/**
 * Re-reads the page every few seconds while something is running, so a step's progress
 * ("rendering video (1 of 3) · 42%") moves without a manual reload. Stops when nothing runs.
 */
export function LiveRefresh({ active, everyMs = 8_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return null;
}

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
export function LiveStatus({ status, detail, updatedAt }: { status: string; detail: string | null; updatedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  const running = isRunning(status);
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
        style={{ background: stale ? 'var(--state-review)' : 'var(--state-generating)' }}
        aria-hidden
      />
      <span style={{ color: 'var(--text-secondary)' }}>{detail ?? `${status}…`}</span>
      <span className="font-mono" style={{ color: stale ? 'var(--state-review)' : 'var(--text-muted)' }}>
        last update {ago(updatedAt, now)}
        {stale ? ' — no progress for 10+ min, check Generation' : ''}
      </span>
    </div>
  );
}
