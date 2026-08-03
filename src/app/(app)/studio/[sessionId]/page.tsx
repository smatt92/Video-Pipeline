import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Panel } from '@/components/settings/parts';
import { Composer } from '@/components/studio/forms';
import { Transcript } from '@/components/studio/transcript';
import { serverClient } from '@/lib/db/server';
import { readSession } from '@/lib/studio/read';

/**
 * One session: the conversation, and the artifact it is building.
 *
 * Two columns because they answer two different questions. The left one is *what was
 * said* — the evidence trail, kept whole. The right one is *what exists* — the script,
 * the shots and the money, read from the tables rather than from the model's account of
 * them. Those disagreeing is the single most useful thing this screen can show, and it
 * cannot show it if the canvas is rendered from the transcript.
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
      <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
        <p className="text-[13px]" style={{ color: 'var(--state-blocked)' }}>
          This session could not be read.
        </p>
        <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {read.detail}
        </p>
      </div>
    );
  }

  const { summary, transcript, script, shots, ledger } = read.detail;
  const stopped = summary.status !== 'active';
  const capUsed =
    summary.spendCapInr && summary.spendCapInr > 0
      ? Math.min(1, summary.costInr / summary.spendCapInr)
      : 0;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <header className="mb-5 flex items-start gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <h2 className="truncate text-[15px] font-medium tracking-tight">
              {summary.title ?? 'Untitled session'}
            </h2>
            <span
              className="font-mono text-[10px] uppercase tracking-[0.09em]"
              style={{
                color: stopped ? 'var(--state-blocked)' : 'var(--state-live)',
              }}
            >
              {summary.status}
            </span>
          </div>
          <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
            {summary.model} · {summary.inputTokens.toLocaleString('en-IN')} in ·{' '}
            {summary.outputTokens.toLocaleString('en-IN')} out
          </p>
        </div>
        <Link
          href="/studio"
          className="ml-auto shrink-0 text-[12px]"
          style={{ color: 'var(--text-muted)' }}
        >
          ← all sessions
        </Link>
      </header>

      {summary.stoppedReason && (
        <div
          className="mb-5 rounded-md border px-4 py-3"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--state-blocked)' }}
        >
          <p className="text-[12.5px] leading-relaxed">{summary.stoppedReason}</p>
        </div>
      )}

      <div
        className="grid gap-5"
        style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 380px)' }}
      >
        {/* ── Conversation ──────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
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
        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <div
              className="border-b px-4 py-3 text-[13px] font-medium"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              Spend
            </div>
            <div className="px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[15px]">₹{summary.costInr.toFixed(2)}</span>
                {summary.spendCapInr !== null && (
                  <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
                    of ₹{summary.spendCapInr.toFixed(0)}
                  </span>
                )}
              </div>
              <div
                className="mt-2 h-[3px] w-full rounded-full"
                style={{ background: 'var(--surface-inset)' }}
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
                    background: capUsed > 0.8 ? 'var(--state-blocked)' : 'var(--state-ready)',
                  }}
                />
              </div>
              {/* The count is shown because it is the check on the figure above it: the
                  session total is derived from these rows by a trigger, so a total with no
                  rows behind it would be a bug this line makes visible. */}
              <p className="mt-2 font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {summary.ledgerRows} ledger row{summary.ledgerRows === 1 ? '' : 's'} ·{' '}
                {summary.turns} transcript turn{summary.turns === 1 ? '' : 's'}
              </p>
            </div>
          </Panel>

          <Panel>
            <div
              className="border-b px-4 py-3 text-[13px] font-medium"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              Script
            </div>
            {script ? (
              <div className="px-4 py-3">
                <p className="text-[12.5px] leading-relaxed">{script.hook}</p>
                <p
                  className="mt-2 font-mono text-[10.5px]"
                  style={{ color: 'var(--text-faint)' }}
                >
                  drafted_by={script.draftedBy} · {script.humanEditCount} human edit
                  {script.humanEditCount === 1 ? '' : 's'}
                </p>
                {script.voText && (
                  <p
                    className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {script.voText}
                  </p>
                )}
              </div>
            ) : (
              <p className="px-4 py-3 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Not materialised. A session writes a script row on its first successful
                generation, not when it opens — most sessions should produce nothing, and a
                concepts row per exploration would fill the originality trail with videos
                nobody decided to make.
              </p>
            )}
          </Panel>

          <Panel>
            <div
              className="flex items-baseline gap-2 border-b px-4 py-3"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="text-[13px] font-medium">Shots</span>
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
                {shots.length}
              </span>
            </div>
            {shots.length === 0 ? (
              <p className="px-4 py-3 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                None yet.
              </p>
            ) : (
              shots.map((s) => (
                <div
                  key={s.id}
                  className="border-b px-4 py-2 last:border-b-0"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                      {String(s.idx).padStart(2, '0')}
                    </span>
                    <span className="truncate text-[12px]">{s.description}</span>
                    <span
                      className="ml-auto font-mono text-[10.5px]"
                      style={{ color: 'var(--text-faint)' }}
                    >
                      {s.durationS.toFixed(1)}s · {s.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </Panel>

          {ledger.length > 0 && (
            <Panel>
              <div
                className="border-b px-4 py-3 text-[13px] font-medium"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                Ledger
              </div>
              {ledger.map((l, i) => (
                <div
                  key={`${l.occurredAt}-${l.unit}-${i}`}
                  className="flex items-baseline gap-2 border-b px-4 py-[6px] font-mono text-[10.5px] last:border-b-0"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
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
