import Link from 'next/link';

import { Filmstrip } from '@/components/studio/filmstrip';
import { StudioPanel } from '@/components/studio/glass-studio';
import { StudioHeader } from '@/components/studio/studio-header';
import { Hint } from '@/components/shell/hint';
import { formatOf, motionOf, paceOf } from '@/lib/bureau/formats';
import { getBible } from '@/lib/bureau/bible';
import { currentChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { channelSpend } from '@/lib/screens/common';
import { proposedSessionCap } from '@/lib/studio/actions';
import { listSessions, type SessionList } from '@/lib/studio/read';

/**
 * The Studio lane (canvas: GlassStudio), Create and Sessions.
 *
 * Addendum 01 §1: the entry is a conversation; the brain is Opus with this app's own MCP
 * server attached; the unit of work is a session rather than a job. What keeps it from
 * becoming a second codebase is that a session drafts a brief on the active channel and the
 * approver's approval starts the same episode run every video takes (studio/front-end.ts).
 *
 * Create: the floating prompt panel and the Video settings panel over the ambient glow — no
 * picture behind the controls (design README, 08-Oct). Sessions: the list, with what they
 * spent. Three outcomes for the list: sessions, empty, or broken — a list that renders blank
 * when the query failed is a failure nobody sees.
 */

export const dynamic = 'force-dynamic';
// The start form can send the first turn (a tool loop that drafts a brief): give it the room a turn on the session page has.
export const maxDuration = 300;

export const metadata = { title: 'Studio' };

function SessionRows({ list, limit }: { list: Extract<SessionList, { ok: true }>; limit?: number }) {
  const rows = limit ? list.sessions.slice(0, limit) : list.sessions;
  return (
    <div className="feed">
      {rows.map((s) => (
        <Link key={s.id} href={`/studio/${s.id}`} className="fi link">
          <div className="col grow" style={{ gap: 2 }}>
            <span className="sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.title ?? 'Untitled session'}
            </span>
            {s.stoppedReason && <span className="xs t3">{s.stoppedReason}</span>}
          </div>
          <span className={`pill ${s.status === 'active' ? 's-live' : 's-draft'}`}>{s.status}</span>
          <span className="mono xs t3" style={{ whiteSpace: 'nowrap' }}>
            ₹{s.costInr.toFixed(2)}
            {s.spendCapInr !== null && ` / ₹${s.spendCapInr.toFixed(0)}`}
          </span>
        </Link>
      ))}
    </div>
  );
}

export default async function StudioPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const db = serverClient();
  const [list, cap, { active }] = await Promise.all([listSessions(db), proposedSessionCap(), currentChannel()]);
  const [spend, bible] = active ? await Promise.all([channelSpend(db, active.id), getBible(db, active.id).catch(() => null)]) : [null, null];
  // The first series' own defaults, so the panel opens on what this channel usually makes.
  const series = (bible ? Object.values(bible.series)[0] : undefined) as { visual_format?: unknown; voice_pace?: unknown; motion?: unknown } | undefined;
  const initial = {
    video_type: formatOf({ seriesFormat: series?.visual_format }).format,
    motion: motionOf({ seriesMotion: series?.motion }).motion,
    pace: paceOf({ seriesPace: series?.voice_pace }).pace,
  };

  const failed = !list.ok ? (
    <div className="blocker" role="alert">
      <p>
        The session list could not be read. <span className="mono xs">{list.detail}</span>
        <br />
        <span>If this names a missing relation, migration 0017 has not been applied. Run `pnpm db:doctor`.</span>
      </p>
    </div>
  ) : null;

  if (tab === 'sessions') {
    const capped = list.ok ? list.sessions.filter((s) => /cap/i.test(s.stoppedReason ?? '')).length : 0;
    return (
      <main className="main">
        <StudioHeader tab="sessions" back={{ href: '/home', label: 'Home' }} next={{ kind: 'wait', label: 'Open on Approvals', why: 'opens a session first' }} />
        <section className="card">
          <div className="card-h">
            <h1 className="h3">Sessions</h1>
            {list.ok && (
              <span className="mono xs t3">
                {list.sessions.length}
                {list.truncated && (
                  <Hint content={`Only the most recent ${list.limit} are shown, so this count is a floor rather than a total.`}>
                    <span style={{ color: 'var(--rev)' }}>+</span>
                  </Hint>
                )}
                {list.sessions.length > 0 && ` · ₹${list.sessions.reduce((a, s) => a + s.costInr, 0).toFixed(2)} spent`}
                {capped > 0 && ` · ${capped} hit the cap`}
              </span>
            )}
          </div>
          {failed ?? (list.ok && list.sessions.length === 0 ? (
            <p className="card-b sm t3">No sessions yet. A session ends in a brief on Approvals; approving it there makes the video. A session that decides not to make anything still records what it cost.</p>
          ) : list.ok ? (
            <SessionRows list={list} />
          ) : null)}
        </section>
      </main>
    );
  }

  return (
    <main className="main">
      <StudioHeader tab="create" back={{ href: '/home', label: 'Home' }} next={{ kind: 'wait', label: 'Open on Approvals', why: 'appears when a brief is drafted' }} title={active ? `${active.name} · new session` : 'No channel selected'} />
      <h1 className="sr-only">Studio — new session</h1>
      <StudioPanel
        mode="start"
        proposedCap={cap}
        channelName={active?.name}
        prices={null}
        perShortCap={spend?.perShortCap ?? null}
        initial={initial}
        left={
          <section className="gp" aria-label="Recent sessions">
            <div className="row sb" style={{ marginBottom: 6 }}>
              <h2 className="h3">Recent sessions</h2>
              <Link className="xs tlink" href="/studio?tab=sessions">
                All
              </Link>
            </div>
            {failed ?? (list.ok && list.sessions.length ? <SessionRows list={list} limit={6} /> : <p className="xs t3">None yet — this one will be the first.</p>)}
          </section>
        }
      />
      <Filmstrip shots={[]} episodeId={null} note="Shots appear here once the brief is approved and the run draws them — each with its picture, its line and a re-roll." />
    </main>
  );
}
