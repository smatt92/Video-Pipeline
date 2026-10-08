import Link from 'next/link';

import { LiveRefresh } from '@/components/bureau/live-status';
import { Chain } from '@/components/glass/chain';
import { DotMatrix } from '@/components/glass/dot-matrix';
import { Orb } from '@/components/glass/orb';
import { FallbackDecision } from '@/components/notifications/controls';
import { inr } from '@/components/ui/card';
import { Countdown } from '@/components/ui/countdown';
import { episodeState, Gate, Pill, Stag } from '@/components/ui/tags';
import { chainStates } from '@/lib/bureau/chain';
import { metricsSummary } from '@/lib/bureau/read';
import { shouldAutoRefresh } from '@/lib/bureau/screen-state';
import { currentChannel, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { channelEpisodes, channelPolicy, channelSpend, ledgerBasis, shortDate, titleOf, todayIn, tzAbbrev, upcomingSlots, zonedInstant } from '@/lib/screens/common';
import { chainEpisodes, cutsWaiting, fallbacks, lastDays, monthCostPerVideo, slotsAhead, spendByDay, spentNodesOf } from '@/lib/screens/home';
import { daysBanked, slotLevel } from '@/lib/bureau/chain';
import { initials } from '@/lib/shell/initials';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Home' };

/**
 * Channel Home (canvas: GlassHome, GlassHomeM). Five hero numerals — spend this month against
 * the cap, cost per video, cap left today, days banked, cuts waiting — the next slot with its
 * countdown, the episodes in production as pipeline chains with what each stage cost, and the
 * orb cards for what needs you. Below the fold, what is coming up and the last seven days.
 *
 * Every number is a row and every unknown an em dash with the reason. Cost per video with no
 * finished video is undefined ("—"), never ₹0; a node with no ledger row shows "—".
 */

const IN_PRODUCTION = ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'qc', 'assembling', 'awaiting_cut', 'cut_rejected', 'cut_approved', 'halted', 'failed'];

const money = (v: number | null) => (v === null ? null : v < 100 ? `₹${Math.round(v)}` : inr(v));

export default async function HomePage() {
  const channel = await requireChannel();
  const db = serverClient();

  const policyP = channelPolicy(db, channel.id);
  const [policy, episodes, spend, basis, metrics, pendingRes, waitingFallbacks, { all }] = await Promise.all([
    policyP,
    channelEpisodes(db, channel.id, 200),
    channelSpend(db, channel.id),
    ledgerBasis(db, channel.id),
    metricsSummary(db, channel.id, '7d').catch(() => null),
    db.from('briefs').select('id, slot_id, premise, estimate_inr, flagged').eq('channel_id', channel.id).eq('status', 'pending').order('created_at'),
    fallbacks(db, channel.id),
    currentChannel(),
  ]);
  const tz = policy?.tz ?? 'Asia/Kolkata';
  const today = todayIn(tz);
  const monthStart = `${today.slice(0, 8)}01`;
  const dayOfMonth = Number(today.slice(8, 10));
  const production = episodes.filter((e) => IN_PRODUCTION.includes(e.status));

  const [byDay, chains, cpv, ahead, slots, cuts] = await Promise.all([
    spendByDay(db, channel.id, tz, Math.max(dayOfMonth, 12)),
    chainEpisodes(db, production.slice(0, 4)),
    monthCostPerVideo(channel.id, monthStart),
    slotsAhead(db, channel.id, today, 14),
    upcomingSlots(db, channel.id, today, 6),
    cutsWaiting(db, episodes),
  ]);
  const pending = pendingRes.data ?? [];
  const chIdx = all.findIndex((c) => c.id === channel.id);
  const chMark = { initials: initials(channel.name), alt: chIdx % 2 === 1 };

  // ── Hero figures ─────────────────────────────────────────────────────────
  const neverSpent = basis.rows === 0;
  const allMeasured = basis.rows !== null && basis.rows > 0 && basis.measured === basis.rows;
  const monthDays = lastDays(today, dayOfMonth);
  const spendSeries = byDay && !neverSpent ? monthDays.map((d) => byDay.get(d) ?? 0) : [];
  const capDays = lastDays(today, 12);
  const capSeries = byDay && !neverSpent ? capDays.map((d) => byDay.get(d) ?? 0) : [];
  const capLeft = spend?.dailyCap == null || spend.todayInr === null ? null : Math.max(0, spend.dailyCap - spend.todayInr);
  const banked = daysBanked(ahead, today);
  const bankSeries = (ahead ?? []).slice(0, 12).map((s) => slotLevel(s.status));

  // ── Next slot ────────────────────────────────────────────────────────────
  const bySlot = new Map(episodes.map((e) => [e.slot, e]));
  const pendingBySlot = new Map(pending.filter((b) => b.slot_id).map((b) => [b.slot_id!, b]));
  const next = slots[0] ?? null;
  const nextEp = next ? (bySlot.get(next.id) ?? null) : null;
  const nextBrief = next ? (pendingBySlot.get(next.id) ?? null) : null;
  const nextTarget = next && policy ? zonedInstant(next.date, policy.slotTime, tz).toISOString() : null;
  const nextTitle = nextEp?.premise ? titleOf(nextEp.premise) : nextBrief ? titleOf(nextBrief.premise) : (next?.topic ?? null);
  const nextState = nextEp ? episodeState(nextEp.status) : nextBrief ? { tone: 'rev' as const, label: 'Brief waiting for you' } : { tone: 'draft' as const, label: 'No brief yet' };
  const nextWhy = nextEp
    ? nextEp.status === 'awaiting_cut'
      ? 'ships only after you approve the cut'
      : ['halted', 'failed'].includes(nextEp.status)
        ? (nextEp.statusDetail ?? 'the run stopped without saying why')
        : null
    : nextBrief
      ? 'nothing renders until you approve the brief'
      : 'nothing can render until a brief exists for it';
  const slotWhen = next ? `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${next.date}T00:00:00Z`))}${policy ? ` · ${policy.slotTime.slice(0, 5)} ${tzAbbrev(tz)}` : ''}` : null;

  const needs = waitingFallbacks.length + cuts.length + pending.length;
  const dateLine = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  return (
    <main className="main home">
      {/* Home shows every episode's state; while any of them is moving, it follows. */}
      <LiveRefresh active={shouldAutoRefresh(episodes.map((e) => e.status))} everyMs={15_000} />
      <h1 className="sr-only">
        Home · {channel.name} · {dateLine}
      </h1>

      <section className="home-hero" aria-label="This month">
        <div className="gp hero h-spend">
          <div className="row sb">
            <span className="lb">Spend this month</span>
            <span className="mono xs t3">
              {allMeasured ? 'measured' : 'estimate'}
              {spend?.monthlyCap != null ? ` · of ${inr(spend.monthlyCap)}` : ' · no monthly cap'}
            </span>
          </div>
          {spend?.monthInr == null ? <span className="disp num xl unk">—</span> : <span className="disp num xl">{inr(spend.monthInr)}</span>}
          <div className="row sb" style={{ alignItems: 'flex-end', flexWrap: 'nowrap' }}>
            {spendSeries.length ? (
              <DotMatrix values={spendSeries} label={`Spend per day, 1 to ${dayOfMonth} this month; highest ${money(Math.max(...spendSeries))}`} />
            ) : (
              <span className="xs t3">{neverSpent ? 'No ledger row yet — nothing has been spent.' : 'Ledger not readable.'}</span>
            )}
            <span className="mono xs t3">
              1–{dayOfMonth} {new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'short' }).format(new Date())}
            </span>
          </div>
        </div>

        <div className="gp hero">
          <span className="lb">Cost per video</span>
          {cpv.inr === null ? <span className="disp num unk">—</span> : <span className="disp num">{money(cpv.inr)}</span>}
          <span className="xs t3" style={{ lineHeight: 1.35 }}>
            {!cpv.readable ? 'The cost view could not be read.' : cpv.inr === null ? 'No video has finished yet this month.' : `${cpv.n} video${cpv.n === 1 ? '' : 's'} this month · estimate`}
          </span>
        </div>

        <div className="gp hero">
          <span className="lb">Cap left today</span>
          {capLeft === null ? <span className="disp num unk">—</span> : <span className="disp num">{money(capLeft)}</span>}
          {capSeries.length && spend?.dailyCap ? (
            <DotMatrix values={capSeries} max={spend.dailyCap} peak={null} label={`Spend per day against the ${inr(spend.dailyCap)} daily cap, last 12 days`} />
          ) : (
            <span className="xs t3">{spend?.dailyCap == null ? 'No daily cap set.' : `of ${inr(spend.dailyCap)} · nothing recorded yet`}</span>
          )}
        </div>

        <div className="gp hero">
          <span className="lb">Days banked</span>
          {banked === null ? (
            <span className="disp num unk">—</span>
          ) : (
            <span className="disp num">
              {banked}
              <small>{banked === 1 ? 'day' : 'days'}</small>
            </span>
          )}
          {bankSeries.length ? (
            <DotMatrix values={bankSeries} max={5} peak={null} label={`How far along each of the next ${bankSeries.length} slots is`} />
          ) : (
            <span className="xs t3">{banked === null ? 'Slots could not be read.' : 'No slots ahead.'}</span>
          )}
        </div>

        <Link className="gp hero h-cuts" href="/bureau/cuts">
          <span className="lb">Cuts waiting</span>
          <span className="disp num">{cuts.length}</span>
          <span className={cuts.length ? 'gbtn sm' : 'xs t3'} style={{ alignSelf: 'flex-start' }}>
            {cuts.length ? 'Watch' : 'Nothing to watch'}
          </span>
        </Link>
      </section>

      <section className="home-main">
        <div className="col home-left" style={{ gap: 16, minWidth: 0 }}>
          <section className="gp home-next" aria-label="Next slot">
            {next ? (
              <>
                <div className="col grow" style={{ gap: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="lb">Next slot</span>
                    <span className={`cav sm${chMark.alt ? ' alt' : ''}`} aria-hidden="true">
                      {chMark.initials}
                    </span>
                    <span className="mono xs t3">
                      {next.id} · {slotWhen}
                    </span>
                    {next.seasonalTag && <Stag>{next.seasonalTag}</Stag>}
                  </div>
                  <h2 className="h2" style={{ lineHeight: 1.25 }}>
                    {nextTitle ?? '—'}
                  </h2>
                  <div className="row">
                    <Pill tone={nextState.tone}>{nextState.label}</Pill>
                    {nextWhy && <span className="xs t3">{nextWhy}</span>}
                    {!nextEp && nextBrief && (
                      <Link className="gbtn sm" href={`/bureau/approvals?id=${nextBrief.id}`}>
                        Open on Approvals
                      </Link>
                    )}
                    {!nextEp && !nextBrief && (
                      <Link className="gbtn sm" href="/bureau/calendar">
                        Calendar
                      </Link>
                    )}
                  </div>
                </div>
                <div className="col home-cd">
                  {nextTarget ? <Countdown target={nextTarget} serverNow={Date.now()} className="disp" /> : <span className="disp t3">—</span>}
                  <span className="mono xs t3">{nextTarget ? 'to publish' : 'no slot time — no policy row'}</span>
                </div>
              </>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                <span className="lb">Next slot</span>
                <span className="h2 t3">No slot on the calendar from today on.</span>
                <Link className="gbtn sm" href="/bureau/calendar" style={{ alignSelf: 'flex-start' }}>
                  Open calendar
                </Link>
              </div>
            )}
          </section>

          <section className="gp home-prod" aria-label="In production">
            <div className="row sb">
              <h2 className="h3">In production · {production.length}</h2>
              <span className="xs t3 desk-only">Brief → Voice → Pictures → Clips → Cut → Bundle</span>
            </div>
            {chains.length === 0 ? (
              <div className="empty">
                <span style={{ color: 'var(--t2)', fontWeight: 500 }}>Nothing in production</span>
                <span>An approved brief starts a run; nothing is running now.</span>
              </div>
            ) : (
              chains.map((c) => {
                const e = c.episode;
                const fallback = waitingFallbacks.some((w) => w.episodeId === e.id);
                const states = chainStates(e.status, { stills: c.stills, clips: c.clips, fallback }, spentNodesOf(c.nodeCost));
                const running = states.some((s) => s.state === 'run');
                const href = e.status === 'awaiting_cut' || e.status === 'cut_rejected' ? `/bureau/cuts?id=${e.id}` : `/bureau/board#${e.id}`;
                return (
                  <Link key={e.id} href={href} className={`chn${running ? ' shim' : ''}`} aria-label={`${titleOf(e.premise)} — ${episodeState(e.status).label}`}>
                    <div className="row sb" style={{ flexWrap: 'nowrap' }}>
                      <div className="row" style={{ gap: 8, minWidth: 0, flexWrap: 'nowrap' }}>
                        <span className={`cav md${chMark.alt ? ' alt' : ''}`} aria-hidden="true">
                          {chMark.initials}
                        </span>
                        <span className="sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span className="mono t3">{e.slot}</span> {titleOf(e.premise)}
                        </span>
                      </div>
                      <span className="mono xs" style={{ whiteSpace: 'nowrap' }}>
                        {c.spentInr === null ? '—' : money(c.spentInr)} <span className="t3">{spend?.perShortCap != null ? `of ${inr(spend.perShortCap)}` : 'no cap'}</span>
                      </span>
                    </div>
                    <Chain
                      nodes={states.map((s) => ({
                        stage: s.stage,
                        state: s.state,
                        label: s.label,
                        note: s.note ?? null,
                        cost: c.nodeCost.has(s.stage) ? (c.nodeCost.get(s.stage) === null ? 'unpriced' : money(c.nodeCost.get(s.stage)!)) : null,
                      }))}
                    />
                  </Link>
                );
              })
            )}
            {production.length > chains.length && (
              <Link className="xs" href="/bureau/board" style={{ alignSelf: 'flex-start' }}>
                {production.length - chains.length} more on the Board
              </Link>
            )}
          </section>
        </div>

        <aside className="col home-needs" style={{ gap: 12, minWidth: 0 }} aria-label="Needs you">
          <div className="row sb" style={{ padding: '0 4px' }}>
            <h2 className="h3">Needs you · {needs}</h2>
            <Link className="xs tlink" href="/notifications">
              All notifications
            </Link>
          </div>
          {needs === 0 && (
            <div className="orb calm">
              <span className="lb calm">All clear</span>
              <span className="what">Nothing is waiting on you.</span>
              <span className="why">Fallbacks, cuts and briefs that need a decision appear here.</span>
            </div>
          )}
          {waitingFallbacks.map((w) => (
            <Orb
              key={w.episodeId}
              tone="alert"
              label="Fallback needs approval"
              channel={chMark}
              what={w.reason}
              why={`${w.slotId ?? 'bank'} · ${w.premise ? titleOf(w.premise) : 'untitled'}`}
              actions={<FallbackDecision episodeId={w.episodeId} glass />}
            />
          ))}
          {cuts.map((c) => (
            <Orb
              key={c.episodeId}
              tone="warm"
              label="Cut ready"
              channel={chMark}
              what={`${titleOf(c.title)}${c.durationS === null ? '' : ` · ${Math.round(c.durationS)} s`}${c.lufs === null ? '' : ` · ${c.lufs.toFixed(0).replace('-', '−')} LUFS`}`}
              why={`${c.slot} ships only after you approve the cut.`}
              actions={
                <Link className="pbtn" href={`/bureau/cuts?id=${c.episodeId}`} style={{ height: 40 }}>
                  Watch
                </Link>
              }
            />
          ))}
          {pending.slice(0, 3).map((b) => (
            <Orb
              key={b.id}
              tone="calm"
              label="Brief waiting"
              channel={chMark}
              what={`${titleOf(b.premise)} — pick a punchline.`}
              why={b.flagged ? 'Flagged by the policy check.' : undefined}
              actions={
                <>
                  <Link className="gbtn" href={`/bureau/approvals?id=${b.id}`}>
                    Open on Approvals
                  </Link>
                  <span className="mono xs t3">{b.estimate_inr === null ? 'unpriced' : `${money(Number(b.estimate_inr))} estimate`}</span>
                </>
              }
            />
          ))}
          {pending.length > 3 && (
            <Link className="xs" href="/bureau/approvals" style={{ padding: '0 4px' }}>
              {pending.length - 3} more briefs on Approvals
            </Link>
          )}
        </aside>
      </section>

      <section className="home-more">
        <div className="card">
          <div className="card-h">
            <h2 className="h3">Coming up</h2>
            <Link className="xs tlink" href="/bureau/calendar">
              Calendar
            </Link>
          </div>
          <div className="feed">
            {slots.length === 0 && <div className="fi sm t3">No slots from today on.</div>}
            {slots.slice(0, 5).map((s) => {
              const e = bySlot.get(s.id);
              const st = e ? episodeState(e.status) : pendingBySlot.has(s.id) ? { tone: 'rev' as const, label: 'Brief' } : { tone: 'draft' as const, label: 'No brief' };
              return (
                <div className="fi" key={s.id}>
                  <span className="t">{shortDate(s.date)}</span>
                  <span className="mono sm" style={{ width: 40 }}>
                    {s.id}
                  </span>
                  <span className="sm grow t2">
                    {s.seriesName ?? s.series} {s.seasonalTag && <Stag>{s.seasonalTag}</Stag>}
                  </span>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h2 className="h3">Last 7 days</h2>
            <Link className="xs tlink" href="/bureau/metrics">
              Metrics
            </Link>
          </div>
          <div className="kgrid ga-160 card-b">
            <div className="col" style={{ gap: 6 }}>
              <span className="lb">Views</span>
              {metrics?.views == null ? <span className="unk">—</span> : <span className="tv">{metrics.views.toLocaleString('en-IN')}</span>}
              <span className="why">{metrics?.views == null ? 'undefined — no measured video in 7 days' : `${metrics.shorts_measured} measured`}</span>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="lb">APV median</span>
              {metrics?.apv_median == null ? (
                <span className="unk">—</span>
              ) : (
                <span className="tv">
                  {metrics.apv_median.toFixed(0)}
                  <small>%</small>
                </span>
              )}
              <span className="why">gate 70%</span>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="lb">Policy gate</span>
              {metrics ? (
                <Gate state={metrics.gates.policy === 'pass' ? 'pass' : 'fail'}>{metrics.gates.policy === 'pass' ? 'pass' : `fail · ${metrics.policy_or_qc_flags}`}</Gate>
              ) : (
                <Gate state="unknown">—</Gate>
              )}
              <span className="why">{metrics ? `${metrics.policy_or_qc_flags} policy/QC flags` : 'metrics not readable'}</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
