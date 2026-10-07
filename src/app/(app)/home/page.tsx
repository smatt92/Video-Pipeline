import Link from 'next/link';

import { StartRun } from '@/components/bureau/start-run';
import { JumpButton } from '@/components/shell/jump-button';
import { KillSwitchCard } from '@/components/shell/kill-switch-card';
import { ScreenHeader } from '@/components/shell/screen-header';
import { BureauBuilding } from '@/components/ui/bureau-building';
import { Blocker, inr } from '@/components/ui/card';
import { Countdown, Clock } from '@/components/ui/countdown';
import { Canister, FlatStages, runCones } from '@/components/ui/episode';
import { Icon } from '@/components/ui/icon';
import { Basis, CastChip, episodeState, Gate, Pill, Stag } from '@/components/ui/tags';
import { metricsSummary } from '@/lib/bureau/read';
import { isRunning } from '@/lib/bureau/running';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import {
  castFor,
  channelEpisodes,
  channelPolicy,
  channelSpend,
  ledgerBasis,
  longDate,
  shortDate,
  titleOf,
  todayIn,
  tzAbbrev,
  upcomingSlots,
  zonedInstant,
} from '@/lib/screens/common';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Home' };

/**
 * Channel Home (canvas: Home, Home-m). Next slot with its countdown and its one blocker, what
 * needs you, what is coming up, the episodes in production, spend against the caps, the last
 * seven days against the gates, alerts, and the kill switch. Every number is a row; every
 * unknown is an em dash with the reason.
 */

const IN_PRODUCTION = ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'qc', 'assembling', 'awaiting_cut', 'cut_rejected', 'halted', 'failed'];
const STOPPED = new Set(['halted', 'failed']);

const ALERT_DOT: Record<string, string> = {
  qc_failed: 'var(--blk)',
  policy_flag: 'var(--rev)',
  kill_switch: 'var(--blk)',
  cap_80: 'var(--rev)',
  cut_ready: 'var(--ac)',
  briefs_pending: 'var(--ac)',
  info: 'var(--t3)',
};
const ALERT_LINK: Record<string, { href: string; label: string }> = {
  qc_failed: { href: '/bureau/board', label: 'Board' },
  policy_flag: { href: '/bureau/approvals', label: 'Approvals' },
  kill_switch: { href: '/bureau/monitor', label: 'Generation' },
  cap_80: { href: '/costs', label: 'Costs' },
  cut_ready: { href: '/bureau/cuts', label: 'Review cut' },
  briefs_pending: { href: '/bureau/approvals', label: 'Review' },
};

function pct(used: number | null, cap: number | null): number | null {
  return used === null || !cap ? null : used / cap;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { range: rangeParam } = await searchParams;
  const range = rangeParam === '28d' ? '28d' : '7d';
  const channel = await requireChannel();
  const bible = bibleOrNull(channel);
  const db = serverClient();

  const policy = await channelPolicy(db, channel.id);
  const tz = policy?.tz ?? 'Asia/Kolkata';
  const today = todayIn(tz);

  const [episodes, slots, spend, basis, metrics, ypp, pendingRes, alertsRes] = await Promise.all([
    channelEpisodes(db, channel.id, 200),
    upcomingSlots(db, channel.id, today, 6),
    channelSpend(db, channel.id),
    ledgerBasis(db, channel.id),
    metricsSummary(db, channel.id, range).catch(() => null),
    metricsSummary(db, channel.id, '90d').catch(() => null),
    db.from('briefs').select('id, slot_id, premise, series, lead_character, estimate_inr, flagged').eq('channel_id', channel.id).eq('status', 'pending').order('created_at'),
    db
      .from('notifications')
      .select('id, kind, text, detail, created_at')
      .eq('channel_id', channel.id)
      .gte('created_at', new Date(Date.now() - 2 * 86400_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(8),
  ]);
  const pending = pendingRes.data ?? [];
  const alerts = alertsRes.data ?? [];

  const bySlot = new Map(episodes.map((e) => [e.slot, e]));
  const pendingBySlot = new Map(pending.filter((b) => b.slot_id).map((b) => [b.slot_id!, b]));
  const cutsWaiting = episodes.filter((e) => e.status === 'awaiting_cut');
  const blocked = episodes.filter((e) => STOPPED.has(e.status));
  const production = episodes.filter((e) => IN_PRODUCTION.includes(e.status));

  const next = slots[0] ?? null;
  const nextEp = next ? bySlot.get(next.id) ?? null : null;
  const nextBrief = next ? pendingBySlot.get(next.id) ?? null : null;
  const nextTarget = next && policy ? zonedInstant(next.date, policy.slotTime, tz).toISOString() : null;
  const nextState = nextEp
    ? episodeState(nextEp.status)
    : nextBrief
      ? { tone: 'draft' as const, label: 'Needs approval' }
      : { tone: 'draft' as const, label: 'No brief yet' };

  const slotState = (id: string) => {
    const e = bySlot.get(id);
    if (e) return episodeState(e.status);
    if (pendingBySlot.has(id)) return { tone: 'draft' as const, label: 'Brief' };
    return { tone: 'draft' as const, label: 'No brief' };
  };

  const dateLine = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const firstPending = pending[0];

  const needs = [
    {
      n: pending.length,
      label: pending.length === 1 ? 'Brief waiting' : 'Briefs waiting',
      sub: firstPending ? `${firstPending.slot_id ?? 'bank'} · ${titleOf(firstPending.premise)}` : 'Nothing to approve',
      href: '/bureau/approvals',
      action: pending.length ? 'Review' : null,
      tone: 'var(--t1)',
    },
    {
      n: cutsWaiting.length,
      label: cutsWaiting.length === 1 ? 'Cut waiting' : 'Cuts waiting',
      sub: cutsWaiting.length ? cutsWaiting.map((e) => e.slot).join(' · ') : 'Nothing has reached cut review',
      href: '/bureau/cuts',
      action: cutsWaiting.length ? 'Review cut' : null,
      tone: 'var(--t1)',
    },
    {
      n: blocked.length,
      label: 'Blocked',
      sub: blocked.length ? blocked.map((e) => e.slot).join(' · ') : 'Nothing is stopped',
      href: '/bureau/board',
      action: blocked.length ? 'Open board' : null,
      tone: blocked.length ? 'var(--blk)' : 'var(--t1)',
    },
  ];

  const prodCards = [
    ...production.slice(0, 6).map((e) => ({ kind: 'ep' as const, e })),
    ...pending.slice(0, Math.max(0, 6 - production.length)).map((b) => ({ kind: 'brief' as const, b })),
  ];

  const spendRows = [
    { label: 'Today', used: spend?.todayInr ?? null, cap: spend?.dailyCap ?? null },
    { label: 'This month', used: spend?.monthInr ?? null, cap: spend?.monthlyCap ?? null },
  ];
  const measuredShare = basis.rows && basis.measured !== null ? basis.measured / basis.rows : null;
  const spendBasis: 'est' | 'meas' = measuredShare === 1 ? 'meas' : 'est';

  const noVideo = (metrics?.shorts_measured ?? 0) === 0;
  const why = (m: number | null, gate?: string) =>
    m !== null ? gate ?? '' : noVideo ? `undefined — no measured video in ${range}${gate ? ` · ${gate}` : ''}` : 'not reported for these videos';

  return (
    <main className="main">
      <ScreenHeader
        channel={channel}
        crumb="Home"
        title={dateLine}
        mobileTitle="Home"
        sub={<span className="mob-only">{dateLine}</span>}
        actions={
          <>
            <Clock tz={tz} label={tzAbbrev(tz)} />
            <JumpButton />
            {pending.length > 0 && (
              <Link className="btn pri" href="/bureau/approvals">
                Review {pending.length} brief{pending.length === 1 ? '' : 's'}
              </Link>
            )}
          </>
        }
      />

      <div className="split">
        <section className="card bp wide" style={{ overflow: 'hidden', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 28px 8px 8px' }} aria-label="Next slot">
          {bible?.slug === 'bureau-of-reality' && (
            <div style={{ flex: '1 1 300px', maxWidth: 470, minWidth: 0 }}>
              <BureauBuilding lit={Math.min(12, production.length * 2)} />
            </div>
          )}
          <div className="col" style={{ flex: '1 1 300px', gap: 14, padding: '20px 0 20px 16px', minWidth: 0 }}>
            {next ? (
              <>
                <div className="row sb">
                  <span className="lbl">Next slot</span>
                  <Pill tone={nextState.tone}>{nextState.label}</Pill>
                </div>
                <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                  <span className="mono bp-text" style={{ fontSize: 20, fontWeight: 600 }}>
                    {next.id}
                  </span>
                  <span className="bp-text-2">{nextEp?.premise ? titleOf(nextEp.premise) : nextBrief ? titleOf(nextBrief.premise) : next.topic ?? '—'}</span>
                </div>
                {nextTarget ? <Countdown target={nextTarget} serverNow={Date.now()} className="cd bp-text" /> : <span className="unk">—</span>}
                <span className="mono sm bp-dim">
                  {longDate(next.date)} · {policy ? `${policy.slotTime.slice(0, 5)} ${tzAbbrev(tz)}` : 'no slot time — no policy row'} · {next.seriesName ?? next.series ?? '—'}
                  {next.seasonalTag ? ' · ' : ''}
                  {next.seasonalTag && <Stag>{next.seasonalTag}</Stag>}
                </span>
                <div className="row" style={{ gap: 6 }}>
                  {castFor(bible, nextEp?.lead ?? next.lead, nextEp?.supporting).map((c) => (
                    <CastChip key={c.slug} slug={c.slug} name={c.name} accent={c.accent} lead={c.lead} />
                  ))}
                </div>
                {nextEp && STOPPED.has(nextEp.status) ? (
                  <Blocker wrap action={<StartRun episodeId={nextEp.id} restart />}>
                    {nextEp.statusDetail ?? 'The run stopped without saying why.'}
                  </Blocker>
                ) : !nextEp && !nextBrief ? (
                  <Blocker wrap action={<Link className="btn sm" href="/bureau/calendar">Calendar</Link>}>
                    Nothing can render for this slot until a brief exists for it.
                  </Blocker>
                ) : !nextEp && nextBrief ? (
                  <Blocker wrap action={<Link className="btn sm pri" href="/bureau/approvals">Review brief</Link>}>
                    Nothing can render until you approve the brief.
                  </Blocker>
                ) : null}
              </>
            ) : (
              <>
                <span className="lbl">Next slot</span>
                <span className="unk">—</span>
                <span className="sm bp-dim">No slot on the calendar from today on.</span>
                <Link className="btn sm" href="/bureau/calendar" style={{ alignSelf: 'flex-start' }}>
                  Open calendar
                </Link>
              </>
            )}
          </div>
        </section>

        <section className="side">
          <div className="card">
            <div className="card-h">
              <h2 className="h3">Needs you</h2>
              <span className="mono xs t3">{needs.reduce((a, b) => a + b.n, 0)} items</span>
            </div>
            {needs.map((n) => (
              <Link key={n.label} href={n.href} className="fi link" style={{ minHeight: 64 }}>
                <span className="tv" style={{ fontSize: 26, width: 36, color: n.n === 0 ? 'var(--t3)' : n.tone }}>
                  {n.n}
                </span>
                <span className="col grow" style={{ gap: 2 }}>
                  <span style={{ fontWeight: 500 }}>{n.label}</span>
                  <span className="xs t3 mono">{n.sub}</span>
                </span>
                {n.action ? <span className={`btn sm${n.label.startsWith('Brief') ? ' pri' : ''} desk-only`}>{n.action}</span> : null}
                <Icon name="chevron" className="t3 mob-only" />
              </Link>
            ))}
          </div>
          <div className="card desk-only">
            <div className="card-h">
              <h2 className="h3">Coming up</h2>
              <Link className="xs" href="/bureau/calendar">
                Calendar
              </Link>
            </div>
            <div className="feed">
              {slots.length === 0 && <div className="fi sm t3">No slots from today on.</div>}
              {slots.slice(0, 4).map((s) => {
                const st = slotState(s.id);
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
        </section>
      </div>

      <div className="split">
        <section className="card wide" style={{ gap: 0 }} aria-label="Episodes in production">
          <div className="card-h">
            <h2 className="h3">Episodes in production</h2>
            <div className="row">
              <span className="xs t3 desk-only">script → voice → shots → cut</span>
              <Link className="btn sm ghost" href="/bureau/board">
                Board
              </Link>
            </div>
          </div>
          {prodCards.length === 0 ? (
            <div style={{ padding: 16 }}>
              <div className="empty">
                <span style={{ color: 'var(--t2)', fontWeight: 500 }}>Nothing in production</span>
                <span>An approved brief starts a run; nothing is waiting on one.</span>
              </div>
            </div>
          ) : (
            <div className="kgrid ga-300" style={{ padding: 16 }}>
              {prodCards.map((c) => {
                if (c.kind === 'brief') {
                  const b = c.b;
                  return (
                    <div className="inset col" style={{ padding: 14, gap: 12 }} key={b.id}>
                      <div className="row" style={{ gap: 12, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                        <Canister tone="draft" size={52} />
                        <div className="col grow" style={{ gap: 4 }}>
                          <div className="row sb">
                            <span className="mono" style={{ fontWeight: 600 }}>
                              {b.slot_id ?? 'bank'}
                            </span>
                            <Pill tone="draft">Needs approval</Pill>
                          </div>
                          <span className="sm t2">{titleOf(b.premise)}</span>
                        </div>
                      </div>
                      <FlatStages states={['idle', 'idle', 'idle', 'idle']} />
                      <div className="row sb xs">
                        <span className="t3">Brief drafted{b.flagged ? ' · flagged' : ''}</span>
                        <span className="mono">
                          {b.estimate_inr === null ? (
                            <span className="t3">unpriced</span>
                          ) : (
                            <>
                              {inr(Number(b.estimate_inr))} <Basis kind="est" short />
                            </>
                          )}
                        </span>
                      </div>
                      <div className="row sb" style={{ gap: 8 }}>
                        <span className="xs t3">Waiting on your punchline pick.</span>
                        <Link className="btn sm pri" href="/bureau/approvals">
                          Approve
                        </Link>
                      </div>
                    </div>
                  );
                }
                const e = c.e;
                const cones = runCones(e.status, { running: isRunning(e.status) });
                const st = episodeState(e.status);
                const tone = cones.includes('blk') ? 'blk' : st.tone;
                return (
                  <div className="inset col" style={{ padding: 14, gap: 12 }} key={e.id} id={e.id}>
                    <div className="row" style={{ gap: 12, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      <Canister tone={tone} size={52} />
                      <div className="col grow" style={{ gap: 4 }}>
                        <div className="row sb">
                          <span className="mono" style={{ fontWeight: 600 }}>
                            {e.slot}
                          </span>
                          <Pill tone={tone}>{st.label}</Pill>
                        </div>
                        <span className="sm t2">{titleOf(e.premise)}</span>
                      </div>
                    </div>
                    <FlatStages states={cones} />
                    <div className="row sb xs">
                      <span className="t3">{e.kind === 'long_form' ? 'long-form' : 'Short'}{isRunning(e.status) && e.statusDetail ? ` · ${e.statusDetail}` : ''}</span>
                      <span className="mono">
                        {e.estimateInr === null ? (
                          <span className="t3">unpriced</span>
                        ) : (
                          <>
                            {inr(e.estimateInr)} <Basis kind="est" short />
                          </>
                        )}
                      </span>
                    </div>
                    {STOPPED.has(e.status) ? (
                      <Blocker action={<StartRun episodeId={e.id} restart />}>{e.statusDetail ?? 'The run stopped without saying why.'}</Blocker>
                    ) : e.status === 'awaiting_cut' ? (
                      <div className="row sb" style={{ gap: 8 }}>
                        <span className="xs t3">The cut is waiting for you.</span>
                        <Link className="btn sm pri" href="/bureau/cuts">
                          Review cut
                        </Link>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="side">
          <div className="card">
            <div className="card-h">
              <h2 className="h3">Spend vs cap</h2>
              <Link className="xs" href="/costs">
                Ledger
              </Link>
            </div>
            <div className="card-b col" style={{ gap: 16 }}>
              {spendRows.map((r) => {
                const share = pct(r.used, r.cap);
                return (
                  <div className="col" style={{ gap: 8 }} key={r.label}>
                    <div className="row sb">
                      <span className="sm t2">{r.label}</span>
                      {r.used !== null && <Basis kind={spendBasis} />}
                    </div>
                    <div className="row sb" style={{ alignItems: 'baseline' }}>
                      {r.used === null ? <span className="unk" style={{ fontSize: 24 }}>—</span> : <span className="tv" style={{ fontSize: 24 }}>{inr(r.used)}</span>}
                      <span className="mono xs t3">
                        {r.cap === null ? 'no cap set' : `cap ${inr(r.cap)}`}
                        {share !== null ? ` · ${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%` : ''}
                      </span>
                    </div>
                    <div className={`bar${share !== null && share >= 0.8 ? ' blk' : ''}`}>
                      <i style={{ width: `${Math.min(100, (share ?? 0) * 100)}%`, minWidth: share ? 2 : 0 }} />
                    </div>
                  </div>
                );
              })}
              <p className="xs t3">
                {basis.rows === null ? 'Ledger not readable.' : `${basis.rows} ledger row${basis.rows === 1 ? '' : 's'} · ${basis.measured ?? '—'} measured.`}{' '}
                {spend?.perShortCap != null ? `Per-Short cap ${inr(spend.perShortCap)}` : ''}
                {spend?.longformDayCap != null ? `; long-form day cap ${inr(spend.longformDayCap)}.` : ''}
              </p>
            </div>
          </div>
          <div className="card tile">
            <div className="row sb">
              <span className="lbl">Publish cap today</span>
            </div>
            {policy?.dailyPublishCap == null ? (
              <span className="unk">—</span>
            ) : (
              <span className="tv">
                {policy.dailyPublishCap}
                <small>per day</small>
              </span>
            )}
            <span className="why">
              {policy?.dailyPublishCap == null ? 'no policy row for this channel' : 'Publishing is manual: download the bundle, then Mark scheduled.'}
            </span>
          </div>
        </section>
      </div>

      <div className="split">
        <section className="wide card" aria-label="Recent performance">
          <div className="card-h">
            <h2 className="h3">Last {range === '7d' ? '7' : '28'} days</h2>
            <div className="seg" role="group" aria-label="Range">
              <Link className={range === '7d' ? 'on' : undefined} href="/home?range=7d" aria-current={range === '7d' ? 'true' : undefined}>
                7d
              </Link>
              <Link className={range === '28d' ? 'on' : undefined} href="/home?range=28d" aria-current={range === '28d' ? 'true' : undefined}>
                28d
              </Link>
            </div>
          </div>
          <div className="kgrid ga-160" style={{ padding: 16 }}>
            <div className="col" style={{ gap: 8 }}>
              <span className="lbl">Views</span>
              {metrics?.views == null ? <span className="unk">—</span> : <span className="tv">{metrics.views.toLocaleString('en-IN')}</span>}
              <span className="why">{why(metrics?.views ?? null, `${metrics?.shorts_measured ?? 0} measured`)}</span>
            </div>
            <div className="col" style={{ gap: 8 }}>
              <span className="lbl">APV median</span>
              {metrics?.apv_median == null ? <span className="unk">—</span> : <span className="tv">{metrics.apv_median.toFixed(0)}<small>%</small></span>}
              <span className="why">{why(metrics?.apv_median ?? null, 'gate 70%')}</span>
            </div>
            <div className="col" style={{ gap: 8 }}>
              <span className="lbl">Viewed vs swiped</span>
              {metrics?.viewed_vs_swiped_median_last20 == null ? (
                <span className="unk">—</span>
              ) : (
                <span className="tv">{metrics.viewed_vs_swiped_median_last20.toFixed(0)}<small>%</small></span>
              )}
              <span className="why">{why(metrics?.viewed_vs_swiped_median_last20 ?? null, 'gate 70%')}</span>
            </div>
            <div className="col" style={{ gap: 8 }}>
              <span className="lbl">Policy gate</span>
              {metrics ? (
                <Gate state={metrics.gates.policy === 'pass' ? 'pass' : 'fail'}>
                  {metrics.gates.policy === 'pass' ? 'pass' : `fail · ${metrics.policy_or_qc_flags} flag${metrics.policy_or_qc_flags === 1 ? '' : 's'}`}
                </Gate>
              ) : (
                <Gate state="unknown">—</Gate>
              )}
              <span className="why">{metrics ? `${metrics.policy_or_qc_flags} policy/QC flags in ${range}` : 'metrics not readable'}</span>
            </div>
          </div>
        </section>
        <section className="side card desk-only" aria-label="YouTube Partner Program">
          <div className="card-h">
            <h2 className="h3">Partner Program</h2>
            <span className="xs t3">YouTube’s thresholds</span>
          </div>
          <div className="card-b col" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 6 }}>
              <div className="row sb">
                <span className="sm">Subscribers</span>
                <span className="mono sm">
                  <span className="t3">—</span> / 500
                </span>
              </div>
              <div className="bar">
                <i style={{ width: 0, minWidth: 0 }} />
              </div>
              <span className="why">not read — the channel total is not captured by any snapshot yet</span>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <div className="row sb">
                <span className="sm">Shorts views · 90 days</span>
                <span className="mono sm">
                  {ypp?.views == null ? <span className="t3">—</span> : ypp.views.toLocaleString('en-IN')} / 3,000,000
                </span>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.min(100, ((ypp?.views ?? 0) / 3_000_000) * 100)}%`, minWidth: ypp?.views ? 2 : 0 }} />
              </div>
              <span className="why">{ypp?.views == null ? 'undefined — no measured Short in 90 days' : `${ypp.shorts_measured} Shorts measured`}</span>
            </div>
          </div>
        </section>
      </div>

      <div className="split">
        <section className="wide card" aria-label="Alerts">
          <div className="card-h">
            <h2 className="h3">Alerts</h2>
            <span className="mono xs t3">today + yesterday</span>
          </div>
          <div className="feed">
            {alerts.length === 0 && <div className="fi sm t3">No alerts in the last two days.</div>}
            {alerts.map((a) => {
              const link = ALERT_LINK[a.kind];
              return (
                <div className="fi" key={a.id}>
                  <span className="t">
                    {new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(a.created_at))}
                  </span>
                  <span className="dot" style={{ background: ALERT_DOT[a.kind] ?? 'var(--t3)', marginTop: 7 }} aria-hidden="true" />
                  <div className="col grow" style={{ gap: 2 }}>
                    <span className="sm">{a.text}</span>
                    {a.detail && <span className="mono xs t3">{a.detail}</span>}
                  </div>
                  {link && (
                    <Link className="btn sm ghost" href={link.href}>
                      {link.label}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <KillSwitchCard channelId={channel.id} channelName={channel.name} on={policy?.kill ?? false} reason={policy?.killReason ?? null} known={policy !== null} />
      </div>
    </main>
  );
}
