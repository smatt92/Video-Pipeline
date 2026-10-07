'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { findOrphansAction, requestOrphanPurgeAction, unstickEpisodeAction } from '@/lib/settings/actions';
import type { OrphanReport } from '@/lib/settings/orphans';

/**
 * Danger zone controls. Every action needs the channel's slug typed back; deleting orphans
 * also needs the count that was shown typed back (the second confirmation), and the bytes
 * are deleted by the worker, not here.
 */

type Result = { ok: true; message: string } | { ok: false; refused: string } | null;

function Outcome({ r }: { r: Result }) {
  if (!r) return null;
  return (
    <p className="xs" role="status" style={{ color: r.ok ? 'var(--t3)' : 'var(--blk-text)', marginTop: 6 }}>
      {r.ok ? r.message : r.refused}
    </p>
  );
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

export function OrphanFinder({ channelId, phrase }: { channelId: string; phrase: string }) {
  const [report, setReport] = useState<OrphanReport | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [typed, setTyped] = useState('');
  const [count, setCount] = useState('');
  const [pending, start] = useTransition();

  return (
    <div className="col">
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setResult(null);
              const r = await findOrphansAction();
              if (r.ok) setReport(r.report);
              else setResult(r);
            })
          }
        >
          {pending && !report ? 'Looking…' : 'Find orphans (dry run)'}
        </button>
        <span className="xs t3">Lists only. Nothing is deleted by this button.</span>
      </div>
      {report && (
        <>
          <p className="sm">
            {report.orphans.length === 0 ? (
              <>No orphans among {report.scanned} assets.</>
            ) : (
              <>
                <strong>{report.orphans.length}</strong> of {report.scanned} assets are referenced by nothing — {mb(report.knownBytes)}
                {report.unknownSize ? ` plus ${report.unknownSize} with no recorded size (—)` : ''}.
              </>
            )}
          </p>
          {report.orphans.length > 0 && (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Key</th>
                    <th style={{ textAlign: 'right' }}>Size</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {report.orphans.slice(0, 50).map((o) => (
                    <tr key={o.id}>
                      <td>{o.kind}</td>
                      <td className="mono xs">{o.storageKey}</td>
                      <td className="mono xs" style={{ textAlign: 'right' }}>{o.bytes === null ? '—' : mb(o.bytes)}</td>
                      <td className="mono xs">{o.createdAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.orphans.length > 50 && <p className="xs t3">…and {report.orphans.length - 50} more, all in the delete below.</p>}
            </div>
          )}
          {report.orphans.length > 0 && (
            <div className="col" style={{ gap: 6, marginTop: 8 }}>
              <div className="row">
                <div className="field" style={{ flex: '1 1 200px' }}>
                  <label htmlFor="orph-slug">Type {phrase} to confirm</label>
                  <input id="orph-slug" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" />
                </div>
                <div className="field" style={{ width: '14ch' }}>
                  <label htmlFor="orph-n">and the count, {report.orphans.length}</label>
                  <input id="orph-n" className="input mono" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} autoComplete="off" />
                </div>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn dan"
                  disabled={pending || typed !== phrase || Number(count) !== report.orphans.length}
                  onClick={() =>
                    start(async () => {
                      const r = await requestOrphanPurgeAction(channelId, { confirm: typed, count: Number(count), assetIds: report.orphans.map((o) => o.id) });
                      setResult(r);
                      if (r.ok) setReport(null);
                    })
                  }
                >
                  Delete {report.orphans.length} on the worker
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <Outcome r={result} />
    </div>
  );
}

export function UnstickEpisode({
  channelId,
  phrase,
  episodes,
}: {
  channelId: string;
  phrase: string;
  episodes: { id: string; label: string }[];
}) {
  const [id, setId] = useState(episodes[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<Result>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!episodes.length) {
    return <p className="sm t3">No failed episodes, and none has gone 30 minutes without writing. Nothing to unstick.</p>;
  }
  return (
    <div className="col">
      <div className="field">
        <label htmlFor="un-ep">Episode</label>
        <select id="un-ep" className="input" value={id} onChange={(e) => setId(e.target.value)}>
          {episodes.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <div className="field" style={{ flex: '2 1 260px' }}>
          <label htmlFor="un-why">Why</label>
          <input id="un-why" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="worker died during render" />
        </div>
        <div className="field" style={{ flex: '1 1 180px' }}>
          <label htmlFor="un-slug">Type {phrase} to confirm</label>
          <input id="un-slug" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" />
        </div>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn dan"
          disabled={pending || typed !== phrase || reason.trim().length < 3}
          onClick={() =>
            start(async () => {
              const r = await unstickEpisodeAction(channelId, { episodeId: id, reason, confirm: typed });
              setResult(r);
              if (r.ok) router.refresh();
            })
          }
        >
          {pending ? 'Halting…' : 'Halt it so Restart appears'}
        </button>
      </div>
      <Outcome r={result} />
    </div>
  );
}
