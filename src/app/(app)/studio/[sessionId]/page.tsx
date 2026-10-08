import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Panel } from '@/components/settings/parts';
import { LiveRefresh, LiveStatus } from '@/components/bureau/live-status';
import { EpisodeStatePill, Pill } from '@/components/ui/tags';
import { isRunning } from '@/lib/bureau/running';
import { Composer } from '@/components/studio/forms';
import { Transcript } from '@/components/studio/transcript';
import { serverClient } from '@/lib/db/server';
import { readSession } from '@/lib/studio/read';

/**
 * One session: the conversation, and the videos it is making.
 *
 * Two columns because they answer two different questions. One is *what was said* — the
 * evidence trail, kept whole. The other is *what exists* — the briefs this session drafted,
 * the episodes their approval started and the money, read from the tables rather than from
 * the model's account of them. Those disagreeing is the most useful thing this screen can
 * show, and it cannot show it if the canvas is rendered from the transcript.
 *
 * On a phone the videos come first: that is what Sahil opens the screen to check, and the
 * conversation is below it. While any episode runs the page re-reads itself (LiveRefresh,
 * the same component the Cuts and Board screens use).
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return { title: `Kiln — studio ${sessionId.slice(0, 8)}` };
}

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const read = await readSession(serverClient(), sessionId);

  if (!read.ok) {
    if (read.detail.startsWith('No session')) notFound();
    return (
      <div className="main">
        <p className="text-sm" style={{ color: 'var(--blk)' }}>
          This session could not be read.
        </p>
        <p className="mt-1 font-mono text-2xs" style={{ color: 'var(--t3)' }}>
          {read.detail}
        </p>
      </div>
    );
  }

  const { summary, transcript, script, shots, ledger, channel, briefs } = read.detail;
  const running = briefs.some((b) => b.episode && isRunning(b.episode.status));
  const stopped = summary.status !== 'active';
  const capUsed =
    summary.spendCapInr && summary.spendCapInr > 0
      ? Math.min(1, summary.costInr / summary.spendCapInr)
      : 0;

  return (
    <div className="main">
      <header className="mb-5 flex items-start gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <h2 className="truncate text-lg font-medium tracking-tight">
              {summary.title ?? 'Untitled session'}
            </h2>
            <span
              className="font-mono text-3xs uppercase tracking-[0.09em]"
              style={{
                color: stopped ? 'var(--blk)' : 'var(--live)',
              }}
            >
              {summary.status}
            </span>
          </div>
          <p className="mt-1 font-mono text-2xs" style={{ color: 'var(--t3)' }}>
            {channel ? channel.name : 'no channel'} · {summary.model} · {summary.inputTokens.toLocaleString('en-IN')} in ·{' '}
            {summary.outputTokens.toLocaleString('en-IN')} out
          </p>
        </div>
        <Link
          href="/studio"
          className="ml-auto shrink-0 text-xs"
          style={{ color: 'var(--t3)' }}
        >
          ← all sessions
        </Link>
      </header>

      {summary.stoppedReason && (
        <div
          className="mb-5 rounded-md border px-4 py-3"
          style={{ background: 'var(--s1)', borderColor: 'var(--blk)' }}
        >
          <p className="text-sm leading-relaxed">{summary.stoppedReason}</p>
        </div>
      )}

      <LiveRefresh active={running} />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        {/* ── Conversation ──────────────────────────────────────────────── */}
        <div className="order-2 flex min-w-0 flex-col gap-4 lg:order-1">
          <Panel>
            <Transcript entries={transcript} />
          </Panel>

          <Panel>
            <div className="px-4 py-4">
              <Composer sessionId={sessionId} disabled={stopped} />
            </div>
          </Panel>
        </div>

        {/* ── Canvas ────────────────────────────────────────────────────── */}
        <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
          <Panel>
            <div
              className="flex items-baseline gap-2 border-b px-4 py-3"
              style={{ borderColor: 'var(--b1)' }}
            >
              <span className="text-sm font-medium">Videos</span>
              <span className="font-mono text-2xs" style={{ color: 'var(--t3)' }}>
                {briefs.length}
              </span>
            </div>
            {!channel ? (
              <p className="px-4 py-3 text-xs leading-relaxed" style={{ color: 'var(--t3)' }}>
                This session was opened before sessions carried a channel, so it cannot draft
                a brief. Start a new session — it opens on the channel selected in the sidebar.
              </p>
            ) : briefs.length === 0 ? (
              <p className="px-4 py-3 text-xs leading-relaxed" style={{ color: 'var(--t3)' }}>
                No brief yet. Talk the idea through, then ask for a brief in a video type —
                illustrated, diagram, cinematic, characters or the 3D explainer (key or full
                motion). It lands on Approvals; approving it there starts the video.
              </p>
            ) : (
              briefs.map((b) => (
                <div
                  key={b.id}
                  className="border-b px-4 py-3 last:border-b-0"
                  style={{ borderColor: 'var(--b1)' }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {b.episode ? (
                      <EpisodeStatePill status={b.episode.status} />
                    ) : (
                      <Pill tone={b.status === 'pending' ? 'rev' : b.status === 'rejected' ? 'blk' : 'draft'}>
                        {b.status === 'pending' ? 'Waiting for approval' : b.status === 'rejected' ? 'Rejected' : b.status}
                      </Pill>
                    )}
                    <span className="font-mono text-2xs" style={{ color: 'var(--t3)' }}>
                      {b.series}
                      {b.videoType ? ` · ${b.videoType}` : ''}
                      {b.motion ? ` · ${b.motion} motion` : ''}
                      {/* null is unpriced, never ₹0 */}
                      {' · '}
                      {b.estimateInr === null ? 'unpriced' : `₹${b.estimateInr.toFixed(0)} est`}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed">{b.premise}</p>
                  {b.flagged && b.flagReasons.length > 0 && (
                    <p className="mt-1 text-2xs" style={{ color: 'var(--rev)' }}>
                      Flagged: {b.flagReasons.join(' · ')}
                    </p>
                  )}
                  {b.rejectReason && (
                    <p className="mt-1 text-2xs" style={{ color: 'var(--t3)' }}>
                      {b.rejectReason}
                    </p>
                  )}
                  {b.episode && (
                    <LiveStatus status={b.episode.status} detail={b.episode.statusDetail} updatedAt={b.episode.updatedAt} />
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-xs">
                    {b.status === 'pending' && (
                      <Link href={`/bureau/approvals?id=${b.id}`} className="tlink">
                        Approve on Approvals →
                      </Link>
                    )}
                    {b.episode && (
                      <>
                        <Link href={`/bureau/cuts?id=${b.episode.id}`} className="tlink">
                          Cut →
                        </Link>
                        <Link href="/bureau/ready" className="tlink">
                          Ready →
                        </Link>
                        <Link href="/bureau/board" style={{ color: 'var(--t3)' }}>
                          Board
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </Panel>

          <Panel>
            <div
              className="border-b px-4 py-3 text-sm font-medium"
              style={{ borderColor: 'var(--b1)' }}
            >
              Spend
            </div>
            <div className="px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-lg">₹{summary.costInr.toFixed(2)}</span>
                {summary.spendCapInr !== null && (
                  <span className="font-mono text-2xs" style={{ color: 'var(--t3)' }}>
                    of ₹{summary.spendCapInr.toFixed(0)}
                  </span>
                )}
              </div>
              <div
                className="mt-2 h-[3px] w-full rounded-full"
                style={{ background: 'var(--in)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${capUsed * 100}%`,
                    // A state token, not the accent. The accent marks things you can act
                    // on; this bar is a reading, and painting it accent would claim it is
                    // a control. It turns red before the cap rather than at it, because a
                    // bar that only changes colour once the session is dead has told you
                    // nothing you could still act on.
                    background: capUsed > 0.8 ? 'var(--blk)' : 'var(--rdy)',
                  }}
                />
              </div>
              {/* The count is shown because it is the check on the figure above it: the
                  session total is derived from these rows by a trigger, so a total with no
                  rows behind it would be a bug this line makes visible. */}
              <p className="mt-2 font-mono text-2xs" style={{ color: 'var(--t3)' }}>
                {summary.ledgerRows} ledger row{summary.ledgerRows === 1 ? '' : 's'} ·{' '}
                {summary.turns} transcript turn{summary.turns === 1 ? '' : 's'}
              </p>
            </div>
          </Panel>

          {/* Sessions before 08-Oct materialised their own script on the legacy lane. Kept
              readable as history; nothing creates one any more. */}
          {script && (
            <Panel>
              <div
                className="border-b px-4 py-3 text-sm font-medium"
                style={{ borderColor: 'var(--b1)' }}
              >
                Legacy script · {shots.length} shot{shots.length === 1 ? '' : 's'}
              </div>
              <div className="px-4 py-3">
                <p className="text-sm leading-relaxed">{script.hook}</p>
                <p className="mt-2 font-mono text-2xs" style={{ color: 'var(--t3)' }}>
                  drafted_by={script.draftedBy} · {script.humanEditCount} human edit
                  {script.humanEditCount === 1 ? '' : 's'}
                </p>
                {shots.map((s) => (
                  <p key={s.id} className="mt-1 font-mono text-2xs" style={{ color: 'var(--t3)' }}>
                    {String(s.idx).padStart(2, '0')} {s.description} · {s.durationS.toFixed(1)}s · {s.status}
                  </p>
                ))}
              </div>
            </Panel>
          )}

          {ledger.length > 0 && (
            <Panel>
              <div
                className="border-b px-4 py-3 text-sm font-medium"
                style={{ borderColor: 'var(--b1)' }}
              >
                Ledger
              </div>
              {ledger.map((l, i) => (
                <div
                  key={`${l.occurredAt}-${l.unit}-${i}`}
                  className="flex items-baseline gap-2 border-b px-4 py-[6px] font-mono text-2xs last:border-b-0"
                  style={{ borderColor: 'var(--b1)', color: 'var(--t3)' }}
                >
                  <span>{l.occurredAt.slice(11, 19)}</span>
                  <span>{l.unit}</span>
                  <span className="ml-auto">{l.quantity.toLocaleString('en-IN')}</span>
                  <span className="w-[70px] text-right">₹{l.costInr.toFixed(4)}</span>
                </div>
              ))}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
