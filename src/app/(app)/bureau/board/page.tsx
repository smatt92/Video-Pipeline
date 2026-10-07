import Link from 'next/link';

import { LiveRefresh, LiveStatus } from '@/components/bureau/live-status';
import { StartRun } from '@/components/bureau/start-run';
import { ScreenHeader } from '@/components/shell/screen-header';
import { Note } from '@/components/ui/card';
import { Canister, FlatStages, runCones } from '@/components/ui/episode';
import { CastChip, episodeState, Pill, Stag } from '@/components/ui/tags';
import { channelGeneration, episodeClips } from '@/lib/bureau/overlay-only';
import { isRunning, stalled } from '@/lib/bureau/running';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { castFor, channelEpisodes, shortDate, titleOf, type EpisodeRow } from '@/lib/screens/common';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Board' };

/**
 * Board (canvas: Board, Board-m). Every episode by stage, blockers first; each card says in
 * one sentence why it stopped and offers the one action that moves it. Desktop is the kanban;
 * the phone picks one stage at a time from the strip. Filters and the phone's stage are links
 * (?f=, ?stage=), so the screen stays a Server Component and a filtered view is shareable.
 */

const COLUMNS: { key: string; label: string; dot: string; statuses: string[]; empty: string }[] = [
  { key: 'approval', label: 'Needs approval', dot: 'var(--draft)', statuses: [], empty: 'Briefs waiting for your punchline pick land here.' },
  { key: 'render', label: 'Rendering', dot: 'var(--gen)', statuses: ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'assembling'], empty: 'Nothing is rendering.' },
  { key: 'qc', label: 'QC', dot: 'var(--gen)', statuses: ['qc'], empty: 'Loudness, captions and policy checks run here.' },
  { key: 'cut', label: 'Needs cut review', dot: 'var(--rev)', statuses: ['awaiting_cut', 'cut_rejected'], empty: 'You watch every cut before it can be scheduled.' },
  { key: 'ready', label: 'Ready', dot: 'var(--rdy)', statuses: ['cut_approved', 'bundled'], empty: 'Approved cuts with a publish bundle.' },
  { key: 'scheduled', label: 'Scheduled', dot: 'var(--rdy)', statuses: ['scheduled'], empty: 'Marked scheduled with the platform link.' },
  { key: 'live', label: 'Live', dot: 'var(--live)', statuses: ['live'], empty: 'Nothing is live yet.' },
  { key: 'stopped', label: 'Stopped', dot: 'var(--t4)', statuses: ['halted', 'failed'], empty: 'Halted or failed runs.' },
];

const RENDER_SUB: { label: string; statuses: string[] }[] = [
  { label: 'Queued', statuses: ['queued'] },
  { label: 'Scripting', statuses: ['scripting', 'shotlisting', 'estimating'] },
  { label: 'Voicing', statuses: ['voicing'] },
  { label: 'Generating', statuses: ['generating'] },
  { label: 'Assembling', statuses: ['assembling'] },
];

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'short', label: 'Shorts' },
  { key: 'long', label: 'Long-form' },
] as const;

export default async function BureauBoardPage({ searchParams }: { searchParams: Promise<{ f?: string; stage?: string }> }) {
  const sp = await searchParams;
  const f = FILTERS.some((x) => x.key === sp.f) ? sp.f! : 'all';
  const channel = await requireChannel();
  const bible = bibleOrNull(channel);
  const db = serverClient();
  const [all, { data: pendingRaw }, readiness] = await Promise.all([
    channelEpisodes(db, channel.id),
    db.from('briefs').select('id, slot_id, premise, flagged, lead_character, supporting_characters, created_at').eq('channel_id', channel.id).eq('status', 'pending').order('created_at'),
    channelGeneration(db, channel.id),
  ]);
  const pending = pendingRaw ?? [];

  const slotIds = [...new Set([...all.map((e) => e.slot), ...pending.map((b) => b.slot_id)].filter((s): s is string => !!s))];
  const slotRows = slotIds.length ? (await db.from('slots').select('id, slot_date, seasonal_tag').in('id', slotIds)).data ?? [] : [];
  const slotOf = new Map(slotRows.map((s) => [s.id, s]));

  const isBlocked = (e: EpisodeRow) => e.status === 'halted' || e.status === 'failed' || stalled(e.status, e.updatedAt);
  const eps = all.filter((e) => (f === 'blocked' ? isBlocked(e) : f === 'short' ? e.kind !== 'long_form' : f === 'long' ? e.kind === 'long_form' : true));
  const blockedN = all.filter(isBlocked).length;

  // Overlay-only, said where the cut exists: the channel's reasons once, each cut's own badge.
  const CUT = ['awaiting_cut', 'cut_rejected', 'cut_approved', 'bundled', 'scheduled', 'live'];
  const overlayOnly = new Set<string>();
  for (const e of eps.filter((x) => CUT.includes(x.status) && x.finalRenderId)) {
    const g = await episodeClips(db, { script_id: e.scriptId, qc: e.qc });
    if (g?.overlayOnly) overlayOnly.add(e.id);
  }

  const showPending = f === 'all' || f === 'short';
  const counts = new Map(COLUMNS.map((c) => [c.key, c.key === 'approval' ? (showPending ? pending.length : 0) : eps.filter((e) => c.statuses.includes(e.status)).length]));
  const stage = COLUMNS.some((c) => c.key === sp.stage) ? sp.stage! : (COLUMNS.find((c) => (counts.get(c.key) ?? 0) > 0)?.key ?? 'render');
  const qs = (o: Record<string, string>) => `/bureau/board?${new URLSearchParams({ ...(f !== 'all' ? { f } : {}), ...(sp.stage ? { stage } : {}), ...o })}`;

  const episodeCard = (e: EpisodeRow) => {
    const st = episodeState(e.status);
    const stopped = e.status === 'halted' || e.status === 'failed';
    const stall = stalled(e.status, e.updatedAt);
    const cones = runCones(e.status, { running: isRunning(e.status) && !stall });
    const tone = stopped ? 'blk' : st.tone;
    const slot = slotOf.get(e.slot);
    return (
      <article className={`kcard${stopped || stall ? ' is-blk' : ''}`} key={e.id} id={e.id}>
        <div className="row sb" style={{ flexWrap: 'nowrap' }}>
          <span className="row" style={{ gap: 6 }}>
            <span className="chm" aria-hidden="true" />
            <span className="mono" style={{ fontWeight: 600 }}>
              {e.slot}
            </span>
            {(stopped || stall) && <Pill tone="blk">{stopped ? st.label : 'Stalled'}</Pill>}
          </span>
          <Canister tone={tone} size={40} />
        </div>
        <span className="sm">{titleOf(e.premise) || '—'}</span>
        <div className="row" style={{ gap: 4 }}>
          {castFor(bible, e.lead, e.supporting)
            .slice(0, 2)
            .map((c) => (
              <CastChip key={c.slug} slug={c.slug} name={c.name.split(' ').slice(-1)[0]!} accent={c.accent} />
            ))}
          {slot?.seasonal_tag && <Stag>{slot.seasonal_tag}</Stag>}
          {slot?.slot_date && <span className="mono xs t3">{shortDate(slot.slot_date)}</span>}
          {e.kind === 'long_form' && <span className="chip">long-form</span>}
        </div>
        <FlatStages states={cones} />
        {overlayOnly.has(e.id) && <span className="xs" style={{ color: 'var(--rev)' }}>Overlay-only cut — none of the cast on screen.</span>}
        {isRunning(e.status) && !stall ? (
          <LiveStatus status={e.status} detail={e.statusDetail} updatedAt={e.updatedAt} />
        ) : stopped || stall ? (
          <p className="sm" style={{ color: 'var(--t1)' }}>
            {stall ? 'No progress for 30 minutes — the worker may have died silently.' : e.statusDetail ?? 'The run stopped without saying why.'}
          </p>
        ) : null}
        {e.status === 'queued' && !e.runId && <StartRun episodeId={e.id} full />}
        {(stopped || stall) && <StartRun episodeId={e.id} restart full />}
        {e.status === 'cut_rejected' && <StartRun episodeId={e.id} restart full label="Re-cut with pictures" />}
        {e.status === 'awaiting_cut' && (
          <Link className="btn sm pri full" href="/bureau/cuts">
            Review cut
          </Link>
        )}
        {(e.status === 'cut_approved' || e.status === 'bundled') && (
          <Link className="btn sm full" href="/bureau/ready">
            Open bundle
          </Link>
        )}
      </article>
    );
  };

  const briefCard = (b: (typeof pending)[number]) => {
    const slot = b.slot_id ? slotOf.get(b.slot_id) : undefined;
    return (
      <article className="kcard" key={b.id}>
        <div className="row sb">
          <span className="row" style={{ gap: 6 }}>
            <span className="chm" aria-hidden="true" />
            <span className="mono" style={{ fontWeight: 600 }}>
              {b.slot_id ?? 'bank'}
            </span>
          </span>
          <span className="mono xs t3">{slot?.slot_date ? shortDate(slot.slot_date) : 'bank'}</span>
        </div>
        <span className="sm">{titleOf(b.premise)}</span>
        <div className="row" style={{ gap: 4 }}>
          {castFor(bible, b.lead_character, b.supporting_characters ?? [])
            .slice(0, 1)
            .map((c) => (
              <CastChip key={c.slug} slug={c.slug} name={c.name.split(' ').slice(-1)[0]!} accent={c.accent} />
            ))}
          {slot?.seasonal_tag && <Stag>{slot.seasonal_tag}</Stag>}
          {b.flagged && <Pill tone="rev">flagged</Pill>}
        </div>
        <div className="row sb">
          <span className="xs t3">Waiting on punchline pick</span>
          <Link className="btn sm pri" href={`/bureau/approvals?id=${b.id}`}>
            Approve
          </Link>
        </div>
      </article>
    );
  };

  const cardsFor = (key: string) => {
    if (key === 'approval') return showPending ? pending.map(briefCard) : [];
    const col = COLUMNS.find((c) => c.key === key)!;
    const items = eps.filter((e) => col.statuses.includes(e.status));
    // Blockers first.
    items.sort((a, b) => Number(isBlocked(b)) - Number(isBlocked(a)));
    return items.map(episodeCard);
  };

  const total = all.length + pending.length;

  return (
    <main className="main">
      <LiveRefresh active={all.some((e) => isRunning(e.status))} />
      <ScreenHeader
        channel={channel}
        crumb="Board"
        title="Board"
        sub={`${total} episode${total === 1 ? '' : 's'} · ${blockedN} blocked`}
        actions={
          <>
            {FILTERS.map((x) => (
              <Link key={x.key} href={x.key === 'all' ? '/bureau/board' : `/bureau/board?f=${x.key}`} className={`chip${f === x.key ? ' on' : ''}`} aria-current={f === x.key ? 'true' : undefined}>
                {x.label}
                {x.key === 'all' ? ` · ${total}` : x.key === 'blocked' ? ` · ${blockedN}` : ''}
              </Link>
            ))}
          </>
        }
      />

      {readiness.summary && <Note>{readiness.summary} Cuts marked overlay-only show the chalk diagrams and none of the cast.</Note>}

      <div className="kb desk-only">
        {COLUMNS.map((c) => {
          const n = counts.get(c.key) ?? 0;
          return (
            <section className="kcol" aria-label={c.label} key={c.key}>
              <div className="kcol-h">
                <span className="dot" style={{ background: c.dot }} aria-hidden="true" />
                {c.label}
                <span className="n">{n}</span>
              </div>
              {c.key === 'render' && n > 0
                ? RENDER_SUB.map((sub) => {
                    const items = eps.filter((e) => sub.statuses.includes(e.status));
                    return (
                      <div className="col" style={{ gap: 8 }} key={sub.label}>
                        <div className="ksub">
                          <span>{sub.label}</span>
                        </div>
                        {items.length ? items.map(episodeCard) : <div className="empty" style={{ padding: 10 }}>—</div>}
                      </div>
                    );
                  })
                : n === 0
                  ? <div className="empty">{c.empty}</div>
                  : cardsFor(c.key)}
            </section>
          );
        })}
      </div>

      <div className="mob-only col" style={{ gap: 14 }}>
        <nav className="strip" aria-label="Stage">
          {COLUMNS.map((c) => (
            <Link key={c.key} href={qs({ stage: c.key })} className={`stp${c.key === stage ? ' on' : ''}`} aria-current={c.key === stage ? 'true' : undefined}>
              <span className="dot" style={{ background: c.dot }} aria-hidden="true" />
              {c.label}
              <b>{counts.get(c.key) ?? 0}</b>
            </Link>
          ))}
        </nav>
        {(() => {
          const cards = cardsFor(stage);
          return cards.length ? cards : <div className="empty" style={{ padding: '40px 16px' }}>{COLUMNS.find((c) => c.key === stage)!.empty}</div>;
        })()}
      </div>
    </main>
  );
}
