'use client';

import { useState, useTransition } from 'react';

import { cutAction, regenerateAction } from '@/lib/bureau/ui-actions';

export function CutControls({ episodeId }: { episodeId: string }) {
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (approve: boolean) =>
    start(async () => {
      const r = await cutAction(episodeId, approve, note);
      setMsg(r.message);
    });
  return (
    <div className="mt-3 grid gap-2">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (required to reject; logged verbatim)" className="min-h-11 rounded-md border bg-transparent px-3 text-sm" style={{ borderColor: 'var(--border-default)' }} />
      <div className="flex gap-2">
        <button type="button" disabled={pending} onClick={() => go(true)} className="min-h-11 flex-1 rounded-md px-3 text-sm font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
          Approve cut
        </button>
        <button type="button" disabled={pending || !note.trim()} onClick={() => go(false)} className="min-h-11 rounded-md border px-3 text-sm" style={{ borderColor: 'var(--border-default)', opacity: note.trim() ? 1 : 0.5 }}>
          Reject
        </button>
      </div>
      {msg && <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{msg}</p>}
    </div>
  );
}

export function RegenerateButton({ episodeId, shotIdx }: { episodeId: string; shotIdx: number }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span>
      <button
        type="button"
        disabled={pending}
        className="text-2xs underline"
        style={{ color: 'var(--accent)' }}
        onClick={() => {
          const note = window.prompt(`What should change in shot ${shotIdx}?`);
          if (!note) return;
          start(async () => setMsg((await regenerateAction(episodeId, shotIdx, note)).message));
        }}
      >
        {pending ? 'queueing…' : 're-roll'}
      </button>
      {msg && <span className="ml-2 text-2xs" style={{ color: 'var(--text-muted)' }}>{msg}</span>}
    </span>
  );
}
