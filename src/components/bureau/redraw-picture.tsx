'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { redrawAction } from '@/lib/bureau/ui-actions';

/**
 * One picture of an illustrated shot on Cuts, with "Redraw" and an optional one-line note
 * ("show the Moon bigger", "no arrows"). The thumbnail is a presigned GET straight from the
 * bucket — the bytes never pass through Vercel (rule 2). Approver only, checked server-side.
 */
export function RedrawPicture({ episodeId, shotIdx, part, of, url, disabled }: { episodeId: string; shotIdx: number; part: number; of: number; url: string | null; disabled: string | null }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const label = `Shot ${shotIdx}, picture ${part + 1} of ${of}`;
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL; next/image would proxy the bytes through Vercel
        <img src={url} alt={label} width={54} height={96} style={{ borderRadius: 6, objectFit: 'cover', background: 'var(--s2)', flex: 'none' }} />
      ) : (
        <span className="xs t3" style={{ width: 54, height: 96, display: 'grid', placeItems: 'center', borderRadius: 6, background: 'var(--s2)', flex: 'none' }}>
          none
        </span>
      )}
      <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
        <span className="xs t3">picture {part + 1} of {of}</span>
        <input
          className="input"
          aria-label={`Note for ${label} (optional)`}
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note — “show the Moon bigger”"
          disabled={pending || !!disabled}
        />
        <button
          type="button"
          className="btn sm"
          disabled={pending || !!disabled}
          title={disabled ?? undefined}
          onClick={() =>
            start(async () => {
              const r = await redrawAction(episodeId, shotIdx, part, note);
              setMsg({ ok: r.ok, text: r.message });
              if (r.ok) {
                setNote('');
                router.refresh();
              }
            })
          }
        >
          {pending ? 'Starting…' : 'Redraw'}
        </button>
        {msg && (
          <span className="xs" role="status" style={{ color: msg.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
