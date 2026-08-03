import Link from 'next/link';

import { Panel, SectionHeader } from '@/components/settings/parts';
import { serverClient } from '@/lib/db/server';
import { readQueue } from '@/lib/review/read';

/**
 * The review queue.
 *
 * Three outcomes, like every other list here: renders, nothing yet, or a broken query. The
 * middle one names what would put something in it, because "no renders" and "assembly has
 * never run" are the same screen and different problems.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — review' };

const DECISION_TONE: Record<string, string> = {
  pass: 'var(--state-live)',
  reshoot: 'var(--state-review)',
  kill: 'var(--state-blocked)',
};

export default async function ReviewQueuePage() {
  const queue = await readQueue(serverClient());

  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
      <SectionHeader
        title="Review"
        hint="Stage 8 — the editorial gate. A pass here is the row the publish trigger reads; there is no application-level way around it, and adding one would be removing a compliance control."
      />

      <Panel>
        <div
          className="flex items-baseline gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-[13.5px] font-medium">Renders</span>
          {queue.ok && (
            <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {queue.rows.length}
            </span>
          )}
        </div>

        {!queue.ok ? (
          <div className="px-4 py-4">
            <p className="text-[12.5px]" style={{ color: 'var(--state-blocked)' }}>
              The queue could not be read.
            </p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {queue.detail}
            </p>
            <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              If this names a missing relation, migration 0018 has not been applied. Run{' '}
              <code>pnpm doctor</code>.
            </p>
          </div>
        ) : queue.rows.length === 0 ? (
          <p className="px-4 py-4 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            No renders yet. A rough cut appears here once stage 7 has assembled one — which
            needs every shot generated and normalised first, so an empty queue usually means
            the generation stage has not run rather than that assembly is broken.
          </p>
        ) : (
          queue.rows.map((row) => (
            <Link
              key={row.renderId}
              href={`/review/${row.renderId}`}
              className="grid items-baseline gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-[var(--surface-2)]"
              style={{
                gridTemplateColumns: 'minmax(0,1fr) 90px 80px 80px',
                borderColor: 'var(--border-subtle)',
              }}
            >
              <div className="min-w-0">
                <div className="truncate text-[13px]">{row.conceptTitle}</div>
                <div className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                  {row.kind} · {row.variantLabel}
                </div>
              </div>
              <span
                className="font-mono text-[11px]"
                style={{ color: row.status === 'ready' ? 'var(--state-live)' : 'var(--state-blocked)' }}
              >
                {row.status}
              </span>
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {row.durationS === null ? '—' : `${row.durationS.toFixed(1)}s`}
              </span>
              <span
                className="font-mono text-[11px]"
                style={{ color: row.decision ? DECISION_TONE[row.decision] : 'var(--text-faint)' }}
              >
                {row.decision ?? 'unreviewed'}
              </span>
            </Link>
          ))
        )}
      </Panel>
    </div>
  );
}
