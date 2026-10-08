import Link from 'next/link';

import { Panel, SectionHeader } from '@/components/settings/parts';
import { StartSessionForm } from '@/components/studio/forms';
import { serverClient } from '@/lib/db/server';
import { proposedSessionCap } from '@/lib/studio/actions';
import { Hint } from '@/components/shell/hint';
import { listSessions, type SessionList } from '@/lib/studio/read';
import { currentChannel } from '@/lib/channels/active';

/**
 * The Studio lane.
 *
 * Addendum 01 §1: the entry is a conversation; the brain is Opus with this app's own MCP
 * server attached; the unit of work is a session rather than a job. What keeps it from
 * becoming a second codebase is that a session drafts a brief on the active channel and the
 * approver's approval starts the same episode run every video takes (studio/front-end.ts).
 *
 * Three outcomes, like the board: sessions, empty, or broken. The last is why this reads
 * through a result type rather than an array — a list that renders blank when the query
 * failed is a failure nobody sees.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — studio' };

/**
 * The count, and what the count cannot say.
 *
 * A bare "12" reads the same after twelve sessions and after a hundred and twelve. What
 * changes when this lane is being used hard — or misconfigured — is what it has *spent* and
 * how many sessions ran into their cap. A cap that stops sessions regularly is either too
 * low or the loop is going in circles, and neither is visible from a count.
 *
 * Total spend is a sum of `cost_inr` from the spend view, so a session with no turns
 * contributes a real zero rather than an unknown — money genuinely did not move.
 */
function SessionSummaryLine({ list }: { list: Extract<SessionList, { ok: true }> }) {
  const totalInr = list.sessions.reduce((sum, s) => sum + s.costInr, 0);

  // Capped means the cap stopped it, which the session records as its stop reason — not
  // inferred by comparing cost to cap, because a session can stop exactly at its cap for
  // other reasons and the row already says which.
  const capped = list.sessions.filter((s) => /cap/i.test(s.stoppedReason ?? '')).length;

  return (
    <span className="font-mono text-2xs" style={{ color: 'var(--t3)' }}>
      {list.sessions.length}
      {list.truncated && (
        <Hint content={`Only the most recent ${list.limit} are shown, so this count is a floor rather than a total.`}>
          <span style={{ color: 'var(--rev)' }}>+</span>
        </Hint>
      )}
      {list.sessions.length > 0 && (
        <>
          {' · '}₹{totalInr.toFixed(2)} spent
          {capped > 0 && (
            <Hint content="A cap that stops sessions regularly is either set too low or the loop is going in circles. Neither is visible from a session count.">
              <span style={{ color: 'var(--rev)' }}>{` · ${capped} hit the cap`}</span>
            </Hint>
          )}
        </>
      )}
    </span>
  );
}

export default async function StudioPage() {
  const [list, cap, { active }] = await Promise.all([listSessions(serverClient()), proposedSessionCap(), currentChannel()]);

  return (
    <div className="main">
      <SectionHeader
        title="Studio"
        hint="Talk an idea through with Opus; it drafts a brief for the active channel in the video type you pick, prices it against the cap and hands it to Approvals. Approving it starts the real run — voice, pictures, graphics, cut, bundle — and the session follows it. Every turn is costed and kept as editorial evidence; the session stops at its spend cap."
      />

      <Panel className="mb-6">
        <div
          className="border-b px-4 py-3 text-md font-medium"
          style={{ borderColor: 'var(--b1)' }}
        >
          New session{active ? ` · ${active.name}` : ''}
        </div>
        <div className="px-4 py-4">
          <StartSessionForm proposedCap={cap} />
        </div>
      </Panel>

      <Panel>
        <div
          className="flex items-baseline gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--b1)' }}
        >
          <span className="text-md font-medium">Sessions</span>
          {list.ok && (
            <SessionSummaryLine list={list} />
          )}
        </div>

        {!list.ok ? (
          <div className="px-4 py-4">
            <p className="text-sm" style={{ color: 'var(--blk)' }}>
              The session list could not be read.
            </p>
            <p className="mt-1 font-mono text-2xs" style={{ color: 'var(--t3)' }}>
              {list.detail}
            </p>
            <p className="mt-2 text-xs" style={{ color: 'var(--t3)' }}>
              If this names a missing relation, migration 0017 has not been applied. Run{' '}
              <code>pnpm db:doctor</code>.
            </p>
          </div>
        ) : list.sessions.length === 0 ? (
          <p className="px-4 py-4 text-sm" style={{ color: 'var(--t3)' }}>
            No sessions yet. A session ends in a brief on Approvals; approving it there makes
            the video. A session that decides not to make anything still records what it cost.
          </p>
        ) : (
          <div>
            {list.sessions.map((s) => (
              <Link
                key={s.id}
                href={`/studio/${s.id}`}
                className="grid items-baseline gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-[var(--s2)]"
                style={{
                  gridTemplateColumns: 'minmax(0,1fr) 90px 130px 90px',
                  borderColor: 'var(--b1)',
                }}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{s.title ?? 'Untitled session'}</div>
                  {s.stoppedReason && (
                    <div
                      className="truncate text-xs"
                      style={{ color: 'var(--t3)' }}
                    >
                      {s.stoppedReason}
                    </div>
                  )}
                </div>
                <span
                  className="font-mono text-2xs"
                  style={{
                    color: s.status === 'active' ? 'var(--live)' : 'var(--t3)',
                  }}
                >
                  {s.status}
                </span>
                <span className="font-mono text-2xs" style={{ color: 'var(--t3)' }}>
                  ₹{s.costInr.toFixed(2)}
                  {s.spendCapInr !== null && ` / ₹${s.spendCapInr.toFixed(0)}`}
                </span>
                <span className="font-mono text-2xs" style={{ color: 'var(--t3)' }}>
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
