'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { lockSheetAction, requestSheetAction, setFigureAction } from '@/lib/bureau/ui-actions';

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

/**
 * "Figure" — who the character is, gender included ("an Indian woman in her fifties"). Every
 * sheet and picture prompt says it; the first Mrs. Iyer sheet was a man because nothing did.
 */
export function FigureField({ channelId, slug, name, figure }: { channelId: string; slug: string; name: string; figure: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(figure ?? '');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = value.trim() !== (figure ?? '');
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="xs t3">Figure — who {name} is, as drawn</span>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input
          className="input grow"
          style={{ minWidth: 0 }}
          aria-label={`Who ${name} is, as drawn`}
          value={value}
          maxLength={80}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. an Indian woman in her fifties"
          disabled={pending}
        />
        <button
          type="button"
          className="btn sm"
          disabled={pending || !dirty || !value.trim()}
          onClick={() =>
            start(async () => {
              const r = await setFigureAction(channelId, slug, value);
              setMsg({ ok: r.ok, text: r.message });
              if (r.ok) router.refresh();
            })
          }
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {!figure && !msg && <span className="xs" style={{ color: 'var(--blk-text)' }}>Not set — a sheet is refused until it is.</span>}
      {msg && (
        <span className="xs" role="status" style={{ color: msg.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
