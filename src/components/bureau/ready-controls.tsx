'use client';

import { useState, useTransition } from 'react';

import { markScheduledAction, queueDubsAction } from '@/lib/bureau/ui-actions';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rounded border px-2 py-1 text-2xs"
      style={{ borderColor: 'var(--border-default)', color: 'var(--accent)' }}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'copied' : `copy ${label}`}
    </button>
  );
}

/** Slot time pre-filled in the viewer's local zone; the stored value is an absolute instant. */
export function MarkScheduled({ publicationId, slotTime }: { publicationId: string; slotTime: string | null }) {
  const local = slotTime ? new Date(new Date(slotTime).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  const [at, setAt] = useState(local);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-3 grid gap-2">
      <div className="flex flex-wrap gap-2">
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="min-h-11 rounded-md border bg-transparent px-2 text-sm" style={{ borderColor: 'var(--border-default)' }} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Studio / Shorts link (for metrics)" className="min-h-11 flex-1 rounded-md border bg-transparent px-2 text-sm" style={{ borderColor: 'var(--border-default)' }} />
        <button type="button" disabled={pending || !at} onClick={() => start(async () => setMsg((await markScheduledAction(publicationId, at, url)).message))} className="min-h-11 rounded-md px-3 text-sm font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
          Mark scheduled
        </button>
      </div>
      {msg && <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{msg}</p>}
    </div>
  );
}

export function QueueDubs({ episodeId }: { episodeId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span>
      <button type="button" disabled={pending} onClick={() => start(async () => setMsg((await queueDubsAction(episodeId, ['hi', 'es', 'pt-BR'])).message))} className="text-2xs underline" style={{ color: 'var(--accent)' }}>
        queue hi / es / pt-BR dubs
      </button>
      {msg && <span className="ml-2 text-2xs" style={{ color: 'var(--text-muted)' }}>{msg}</span>}
    </span>
  );
}
