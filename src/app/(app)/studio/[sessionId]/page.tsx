import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LiveRefresh, LiveStatus } from '@/components/bureau/live-status';
import { Filmstrip } from '@/components/studio/filmstrip';
import { StudioPanel } from '@/components/studio/glass-studio';
import { StudioHeader, type NextStep } from '@/components/studio/studio-header';
import { Transcript } from '@/components/studio/transcript';
import { EpisodeStatePill, Pill } from '@/components/ui/tags';
import { DEFAULT_MOTION, DEFAULT_VISUAL_FORMAT, DEFAULT_VOICE_PACE, MotionLevelSchema, VisualFormatSchema } from '@/lib/bureau/formats';
import { isRunning } from '@/lib/bureau/running';
import { serverClient } from '@/lib/db/server';
import { channelSpend } from '@/lib/screens/common';
import { filmstrip, studioPrices } from '@/lib/studio/canvas';
import { readSession } from '@/lib/studio/read';

/**
 * One session (canvas: GlassStudio): the conversation on the left, the prompt panel and the
 * Video settings in the middle and right, the episode's shots along the bottom, and the
 * contextual pill naming the next thing the newest video needs.
 *
 * Two kinds of truth side by side, as before: *what was said* (the transcript, kept whole)
 * and *what exists* (the briefs, the episode, the shots and the money, read from the tables
 * rather than from the model's account of them). While the episode runs the page re-reads
 * itself (LiveRefresh). The ambient glow is the only thing behind the controls — no full-bleed
 * picture for now (design README, 08-Oct); frames appear as filmstrip thumbnails.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function generateMetadata({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return { title: `Studio ${sessionId.slice(0, 8)}` };
}

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const db = serverClient();
  const read = await readSession(db, sessionId);

  if (!read.ok) {
    if (read.detail.startsWith('No session')) notFound();
    return (
      <main className="main">
        <div className="blocker" role="alert">
          <p>
            This session could not be read. <span className="mono xs">{read.detail}</span>
          </p>
        </div>
      </main>
    );
  }

  const { summary, transcript, channel, briefs } = read.detail;
  const newest = briefs[0] ?? null;
  const ep = newest?.episode ?? null;
  const running = briefs.some((b) => b.episode && isRunning(b.episode.status));
  const stopped = summary.status !== 'active';

  const [epRow, spend, prices] = await Promise.all([
    ep ? db.from('episodes').select('script_id').eq('id', ep.id).maybeSingle().then((r) => r.data) : Promise.resolve(null),
    channel ? channelSpend(db, channel.id) : Promise.resolve(null),
    channel && newest ? studioPrices(db, channel.id, newest.id) : Promise.resolve(null),
  ]);
  const shots = epRow?.script_id ? await filmstrip(db, epRow.script_id) : [];
  const epSpend = ep && epRow?.script_id ? (await db.from('v_ledger_effective').select('cost_inr').eq('eff_script_id', epRow.script_id)).data : null;
  const soFar = epSpend && epSpend.length ? epSpend.reduce((a, r) => a + Number(r.cost_inr ?? 0), 0) : null;

  const next: NextStep = !newest
    ? { kind: 'wait', label: 'Open on Approvals', why: 'appears when a brief is drafted' }
    : newest.status === 'pending'
      ? { kind: 'approve', briefId: newest.id }
      : !ep
        ? { kind: 'wait', label: 'Watch cut', why: newest.status === 'rejected' ? 'the brief was rejected' : 'the run has not started' }
        : ep.status === 'awaiting_cut' || ep.status === 'cut_rejected'
          ? { kind: 'cut', episodeId: ep.id }
          : ['bundled', 'scheduled', 'live'].includes(ep.status)
            ? { kind: 'ready' }
            : { kind: 'wait', label: 'Watch cut', why: 'opens when the cut is ready' };

  return (
    <main className="main">
      <LiveRefresh active={running} />
      <StudioHeader tab={null} back={{ href: '/studio?tab=sessions', label: 'Sessions' }} next={next} title={`${channel?.name ?? 'no channel'} · ${summary.title ?? 'Untitled session'}`} />
      <h1 className="sr-only">Studio session — {summary.title ?? 'Untitled session'}</h1>

      {ep && isRunning(ep.status) && (
        <div className="studio-run" role="status">
          <span className="spin" aria-hidden="true" />
          <span>{ep.statusDetail ?? 'Working'}</span>
          <span className="t4" aria-hidden="true">
            ·
          </span>
          <span className="mono sm">{soFar === null ? 'nothing charged yet' : `₹${Math.round(soFar)} so far`}</span>
        </div>
      )}
      {summary.stoppedReason && (
        <div className="blocker" role="status">
          <p>{summary.stoppedReason}</p>
        </div>
      )}

      <StudioPanel
        mode="turn"
        sessionId={sessionId}
        disabled={stopped}
        channelName={channel?.name}
        prices={prices}
        perShortCap={spend?.perShortCap ?? null}
        initial={{
          video_type: VisualFormatSchema.safeParse(newest?.videoType).data ?? DEFAULT_VISUAL_FORMAT,
          motion: MotionLevelSchema.safeParse(newest?.motion).data ?? DEFAULT_MOTION,
          pace: DEFAULT_VOICE_PACE,
        }}
        left={
          <>
            <section className="gp col" style={{ gap: 10 }} aria-label="Conversation">
              <div className="row sb">
                <h2 className="h3">Conversation</h2>
                <span className="mono xs t3">
                  ₹{summary.costInr.toFixed(2)}
                  {summary.spendCapInr !== null && ` of ₹${summary.spendCapInr.toFixed(0)}`} · {summary.turns} turn{summary.turns === 1 ? '' : 's'}
                </span>
              </div>
              <Transcript entries={transcript} />
            </section>
            {briefs.length > 0 && (
              <section className="gp col" style={{ gap: 10, marginTop: 16 }} aria-label="Videos">
                <h2 className="h3">Videos · {briefs.length}</h2>
                {briefs.map((b) => (
                  <div key={b.id} className="col" style={{ gap: 6, paddingTop: 8, borderTop: '1px solid var(--b1)' }}>
                    <div className="row">
                      {b.episode ? (
                        <EpisodeStatePill status={b.episode.status} />
                      ) : (
                        <Pill tone={b.status === 'pending' ? 'rev' : b.status === 'rejected' ? 'blk' : 'draft'}>{b.status === 'pending' ? 'Waiting for approval' : b.status === 'rejected' ? 'Rejected' : b.status}</Pill>
                      )}
                      <span className="mono xs t3">
                        {b.videoType ?? 'type not given'}
                        {b.motion ? ` · ${b.motion}` : ''} · {b.estimateInr === null ? 'unpriced' : `₹${b.estimateInr.toFixed(0)} est`}
                      </span>
                    </div>
                    <span className="sm">{b.premise}</span>
                    {b.flagged && b.flagReasons.length > 0 && <span className="xs" style={{ color: 'var(--s-rev-text)' }}>Flagged: {b.flagReasons.join(' · ')}</span>}
                    {b.episode && <LiveStatus status={b.episode.status} detail={b.episode.statusDetail} updatedAt={b.episode.updatedAt} />}
                    <div className="row" style={{ gap: 12 }}>
                      {b.status === 'pending' && (
                        <Link className="xs tlink" href={`/bureau/approvals?id=${b.id}`}>
                          Approve on Approvals →
                        </Link>
                      )}
                      {b.episode && (
                        <Link className="xs tlink" href={`/bureau/board#${b.episode.id}`}>
                          Board
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
          </>
        }
      />
      <Filmstrip
        shots={shots}
        episodeId={ep?.id ?? null}
        note={!newest ? 'No brief yet. Talk it through, then ask for a brief — it lands on Approvals, and approving it there starts the video.' : !ep ? 'The shots appear once the brief is approved and the run plans them.' : 'The run has not planned its shots yet.'}
      />
    </main>
  );
}
