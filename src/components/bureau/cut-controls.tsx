'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { cutAction, regenerateAction } from '@/lib/bureau/ui-actions';

/**
 * Your call (canvas: Cuts). Approve moves the episode to Ready with its bundle — nothing
 * publishes from here. Send back needs a note (logged verbatim). When the voice stage could
 * not align some lines, Approve waits for "I listened to all N lines": only a listen confirms
 * those lines say the script. Same server action as before the redesign.
 */
export function CutControls({ episodeId, slot, unaligned }: { episodeId: string; slot: string; unaligned: number | null }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [listened, setListened] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const needsListen = (unaligned ?? 0) > 0;
  const go = (approve: boolean) =>
    start(async () => {
      const r = await cutAction(episodeId, approve, note);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  return (
    <div className="col" style={{ gap: 12 }}>
      {needsListen && (
        <label className="row sm" style={{ gap: 10, minHeight: 44 }}>
          <input type="checkbox" checked={listened} onChange={(e) => setListened(e.target.checked)} style={{ width: 18, height: 18 }} />I listened to all {unaligned} unaligned line{unaligned === 1 ? '' : 's'}
        </label>
      )}
      <button className="btn pri lg full" type="button" disabled={pending || (needsListen && !listened)} onClick={() => go(true)}>
        {pending ? 'Working…' : 'Approve cut'}
      </button>
      <div className="field">
        <label htmlFor={`sb-${episodeId}`}>Send back with a note</label>
        <textarea id={`sb-${episodeId}`} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change, and in which shot?" />
      </div>
      <button className="btn full" type="button" disabled={pending || !note.trim()} onClick={() => go(false)}>
        Send back
      </button>
      {msg && (
        <p className="sm" role="status" style={{ color: msg.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
          {msg.text}
        </p>
      )}
      <p className="xs t3">Approving moves {slot} to Ready with its publish bundle. Nothing publishes from here.</p>
    </div>
  );
}

export function RegenerateButton({ episodeId, shotIdx }: { episodeId: string; shotIdx: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
      <button
        type="button"
        disabled={pending}
        className="btn sm ghost"
        onClick={() => {
          const note = window.prompt(`What should change in shot ${shotIdx}? (logged verbatim)`);
          if (!note) return;
          start(async () => {
            const r = await regenerateAction(episodeId, shotIdx, note);
            setMsg(r.message);
            if (r.ok) router.refresh();
          });
        }}
      >
        {pending ? 'Queueing…' : 'Regenerate'}
      </button>
      {msg && (
        <span className="xs t3" role="status">
          {msg}
        </span>
      )}
    </span>
  );
}
