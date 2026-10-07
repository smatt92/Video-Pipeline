'use client';

import { useEffect, useState } from 'react';

/**
 * Countdown to a slot (canvas: Home "Next slot"). Ticks once a second; renders the server's
 * value first so there is no flash. Past the target it says so instead of counting negative.
 */
export function Countdown({ target, serverNow, className = 'cd', style }: { target: string; serverNow: number; className?: string; style?: React.CSSProperties }) {
  const t = new Date(target).getTime();
  const [now, setNow] = useState<number>(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const ms = Math.max(0, t - now);
  if (t <= now) {
    return (
      <span className={className} style={style}>
        due
      </span>
    );
  }
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return (
    <span className={className} style={style} aria-label={`${d} days ${Number(h)} hours ${Number(m)} minutes to publish`} role="timer">
      {d}
      <span>d </span>
      {h}
      <span>:</span>
      {m}
      <span>:</span>
      {sec}
    </span>
  );
}

/** The wall clock in a time zone, for page headers. */
export function Clock({ tz, label }: { tz: string; label: string }) {
  const fmt = () => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date());
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    setV(fmt());
    const i = setInterval(() => setV(fmt()), 15_000);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);
  return (
    <span className="mono sm t3">
      {v ?? '--:--'} {label}
    </span>
  );
}
