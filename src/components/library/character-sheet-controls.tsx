'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { lockSheetAction, requestSheetAction } from '@/lib/bureau/ui-actions';

/**
 * "Generate sheet" with an optional note, for one character on Library → Characters. Spends
 * one image, which is why the price is on the button. Approver only, checked server-side.
 */
export function GenerateSheet({ channelId, slug, name, price, disabled }: { channelId: string; slug: string; name: string; price: string; disabled: string | null }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="col" style={{ gap: 6 }}>
      <input
        className="input"
        aria-label={`Note for ${name}'s sheet (optional)`}
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note — “longer lanyard, friendlier face”"
        disabled={pending || !!disabled}
      />
      <button
        type="button"
        className="btn sm"
        disabled={pending || !!disabled}
        title={disabled ?? undefined}
        onClick={() =>
          start(async () => {
            const r = await requestSheetAction(channelId, slug, note);
            setMsg({ ok: r.ok, text: r.message });
            if (r.ok) {
              setNote('');
              router.refresh();
            }
          })
        }
      >
        {pending ? 'Starting…' : `Generate sheet · ${price}`}
      </button>
      {disabled && <span className="xs t3">{disabled}</span>}
      {msg && (
        <span className="xs" role="status" style={{ color: msg.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

/** "Lock" under one finished candidate: it becomes the reference every picture of the character is drawn from. */
export function LockSheet({ channelId, slug, generationId, disabled }: { channelId: string; slug: string; generationId: string; disabled: string | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="col" style={{ gap: 4 }}>
      <button
        type="button"
        className="btn sm pri"
        disabled={pending || !!disabled}
        title={disabled ?? undefined}
        onClick={() =>
          start(async () => {
            const r = await lockSheetAction(channelId, slug, generationId);
            setMsg({ ok: r.ok, text: r.message });
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? 'Locking…' : 'Lock'}
      </button>
      {msg && (
        <span className="xs" role="status" style={{ color: msg.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
