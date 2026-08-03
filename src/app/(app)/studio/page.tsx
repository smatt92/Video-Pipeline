import Link from 'next/link';

import { Panel, SectionHeader } from '@/components/settings/parts';
import { StartSessionForm } from '@/components/studio/forms';
import { serverClient } from '@/lib/db/server';
import { proposedSessionCap } from '@/lib/studio/actions';
import { listSessions } from '@/lib/studio/read';

/**
 * The Studio lane.
 *
 * Addendum 01 §1: this and the pipeline lane are different products sharing a database.
 * The entry is a brief typed into a chat surface; the brain is Opus 5 with this app's own
 * MCP server attached; the unit of work is a session rather than a job. What keeps it from
 * becoming a second codebase is that a session materialises a `scripts` row and everything
 * downstream is identical.
 *
 * Three outcomes, like the board: sessions, empty, or broken. The last is why this reads
 * through a result type rather than an array — a list that renders blank when the query
 * failed is a failure nobody sees.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — studio' };

export default async function StudioPage() {
  const [list, cap] = await Promise.all([listSessions(serverClient()), proposedSessionCap()]);

  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
      <SectionHeader
        title="Studio"
        hint="A conversation that writes pipeline rows. Every tool call is costed, every turn is kept as editorial evidence, and the session stops at its spend cap rather than warning about it."
      />

      <Panel className="mb-6">
        <div
          className="border-b px-4 py-3 text-md font-medium"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          New session
        </div>
        <div className="px-4 py-4">
          <StartSessionForm proposedCap={cap} />
        </div>
      </Panel>

      <Panel>
        <div
          className="flex items-baseline gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-md font-medium">Sessions</span>
          {list.ok && (
            <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
              {list.sessions.length}
            </span>
          )}
        </div>

        {!list.ok ? (
          <div className="px-4 py-4">
            <p className="text-sm" style={{ color: 'var(--state-blocked)' }}>
              The session list could not be read.
            </p>
            <p className="mt-1 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
              {list.detail}
            </p>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              If this names a missing relation, migration 0017 has not been applied. Run{' '}
              <code>pnpm doctor</code>.
            </p>
          </div>
        ) : list.sessions.length === 0 ? (
          <p className="px-4 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
            No sessions yet. A session that decides not to make anything is the lane working
            correctly — it still records what it cost.
          </p>
        ) : (
          <div>
            {list.sessions.map((s) => (
              <Link
                key={s.id}
                href={`/studio/${s.id}`}
                className="grid items-baseline gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-[var(--surface-2)]"
                style={{
                  gridTemplateColumns: 'minmax(0,1fr) 90px 130px 90px',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{s.title ?? 'Untitled session'}</div>
                  {s.stoppedReason && (
                    <div
                      className="truncate text-xs"
                      style={{ color: 'var(--text-faint)' }}
                    >
                      {s.stoppedReason}
                    </div>
                  )}
                </div>
                <span
                  className="font-mono text-2xs"
                  style={{
                    color: s.status === 'active' ? 'var(--state-live)' : 'var(--text-faint)',
                  }}
                >
                  {s.status}
                </span>
                <span className="font-mono text-2xs" style={{ color: 'var(--text-muted)' }}>
                  ₹{s.costInr.toFixed(2)}
                  {s.spendCapInr !== null && ` / ₹${s.spendCapInr.toFixed(0)}`}
                </span>
                <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
                  {s.turns} turn{s.turns === 1 ? '' : 's'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
