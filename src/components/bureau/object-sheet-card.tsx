'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { redrawObjectSheetAction } from '@/lib/bureau/ui-actions';

/**
 * One hero object of a 3D explainer on Cuts (0052): its locked sheet — the reference every
 * picture of the episode was given — and "Redraw sheet" with an optional note. The thumbnail
 * is a presigned GET straight from the bucket (rule 2). Approver only, checked server-side.
 * A redrawn sheet is used by every picture drawn after it; Redraw a picture to bring it over.
 */
export function ObjectSheetCard({ episodeId, tag, name, url, missing, disabled }: { episodeId: string; tag: string; name: string; url: string | null; missing: string | null; disabled: string | null }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL; next/image would proxy the bytes through Vercel
        <img src={url} alt={`@${tag} sheet`} width={54} height={96} style={{ borderRadius: 6, objectFit: 'cover', background: 'var(--s2)', flex: 'none' }} />
      ) : (
        <span className="xs t3" style={{ width: 54, height: 96, display: 'grid', placeItems: 'center', borderRadius: 6, background: 'var(--s2)', flex: 'none' }}>
          none
        </span>
      )}
      <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
        <span className="sm">
          <span className="mono">@{tag}</span> · {name}
        </span>
        {missing && <span className="xs" style={{ color: 'var(--blk-text)' }}>No sheet: {missing}. Its pictures name it by description instead.</span>}
        <input className="input" aria-label={`Note for @${tag} (optional)`} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Optional note — “rounder, matte white”" disabled={pending || !!disabled} />
        <button
          type="button"
          className="btn sm"
          disabled={pending || !!disabled}
          title={disabled ?? undefined}
          onClick={() =>
            start(async () => {
              const r = await redrawObjectSheetAction(episodeId, tag, note);
              setMsg({ ok: r.ok, text: r.message });
              if (r.ok) {
                setNote('');
                router.refresh();
              }
            })
          }
        >
          {pending ? 'Starting…' : 'Redraw sheet'}
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
