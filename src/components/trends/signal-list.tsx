'use client';

import { useMemo, useState } from 'react';

/**
 * "Everything else" on /trends: the signals below the channel's relevance threshold (or never
 * scored), filterable by source and by text. A table at desktop width; stacked rows on a phone,
 * so nothing scrolls sideways. Numbers right-aligned with their unit; absent is "—", never 0.
 */

export interface SignalRow {
  key: string;
  term: string;
  source: string;
  sourceLabel: string;
  relevance: number | null;
  daysSeen: number;
  velocity: string | null;
  volume: string | null;
  last: string;
  url: string | null;
  workspaceWide: boolean;
}

export function SignalList({ rows, sources, unscoredWhy }: { rows: SignalRow[]; sources: { slug: string; label: string; n: number }[]; unscoredWhy: string }) {
  const [source, setSource] = useState<string>('all');
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => (source === 'all' || r.source === source) && (!needle || r.term.toLowerCase().includes(needle)));
  }, [rows, source, q]);

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <div className="seg" role="group" aria-label="Filter by source" style={{ flexWrap: 'wrap', maxWidth: '100%' }}>
          <button type="button" className={source === 'all' ? 'on' : ''} aria-pressed={source === 'all'} onClick={() => setSource('all')}>
            All {rows.length}
          </button>
          {sources.map((s) => (
            <button key={s.slug} type="button" className={source === s.slug ? 'on' : ''} aria-pressed={source === s.slug} onClick={() => setSource(s.slug)}>
              {s.label} {s.n}
            </button>
          ))}
        </div>
        <input className="input" type="search" placeholder="Search terms" aria-label="Search terms" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 200px', maxWidth: 320 }} />
      </div>

      {shown.length === 0 ? (
        <div className="empty">No signal matches{q ? ` “${q}”` : ''}{source !== 'all' ? ` from ${sources.find((s) => s.slug === source)?.label}` : ''}.</div>
      ) : (
        <>
          <div className="desk-only">
            <table className="tbl" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col />
                <col style={{ width: 124 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 64 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 176 }} />
                <col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Term</th>
                  <th>Source</th>
                  <th className="r">Relevance</th>
                  <th className="r">Days</th>
                  <th className="r">Velocity</th>
                  <th className="r">Volume</th>
                  <th className="r">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.key}>
                    <td style={{ overflowWrap: 'anywhere' }}>
                      <Term r={r} />
                    </td>
                    <td className="t2">{r.sourceLabel}</td>
                    <td style={{ whiteSpace: 'nowrap' }} className="r mono">{r.relevance === null ? <span className="t3" title={unscoredWhy}>—</span> : r.relevance.toFixed(2)}</td>
                    <td style={{ whiteSpace: 'nowrap' }} className="r mono">{r.daysSeen}</td>
                    <td style={{ whiteSpace: 'nowrap' }} className="r mono t2">{r.velocity ?? <span className="t3">—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }} className="r mono t2">{r.volume ?? <span className="t3">—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }} className="r mono t3">{r.last}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mob-only col" style={{ gap: 0, listStyle: 'none', padding: 0, margin: 0 }}>
            {shown.map((r) => (
              <li key={r.key} style={{ padding: '10px 0', borderBottom: '1px solid var(--b1)' }}>
                <div className="sm" style={{ overflowWrap: 'anywhere' }}>
                  <Term r={r} />
                </div>
                <div className="xs t3 mono" style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
                  <span>{r.sourceLabel}</span>
                  <span>rel {r.relevance === null ? '—' : r.relevance.toFixed(2)}</span>
                  <span>{r.daysSeen} d</span>
                  {r.velocity && <span>{r.velocity}</span>}
                  {r.volume && <span>{r.volume}</span>}
                  <span>{r.last}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="xs t3">Relevance “—” = not scored ({unscoredWhy}) — not the same as 0. Velocity and volume “—” = the source gives none.</p>
    </div>
  );
}

function Term({ r }: { r: SignalRow }) {
  return (
    <>
      {r.url ? (
        <a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecorationColor: 'var(--b3)' }}>
          {r.term}
        </a>
      ) : (
        r.term
      )}
      {r.workspaceWide && <span className="xs t3"> · workspace-wide (before multichannel)</span>}
    </>
  );
}
