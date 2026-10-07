import Link from 'next/link';

import { StartRun } from '@/components/bureau/start-run';
import { KillAll } from '@/components/shell/kill-all';
import { SwitchButton } from '@/components/shell/switch-button';
import { ScreenHeader } from '@/components/shell/screen-header';
import { inr } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Basis, episodeState, Pill } from '@/components/ui/tags';
import { currentChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { channelPolicy, channelSpend, longDate, titleOf, todayIn, upcomingSlots } from '@/lib/screens/common';
import { initials } from '@/lib/shell/initials';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'All channels' };

/**
 * All channels (canvas: AllChannels, AllChannels-m) — the combined home. Totals sum across
 * channels; caps are per channel and never pooled, so each channel's spend is shown against
 * its own cap and the combined figure has no cap at all. Every row says which channel it is.
 */
export default async function AllChannelsPage() {
  const db = serverClient();
  const { all } = await currentChannel();

  const per = await Promise.all(
    all.map(async (c) => {
      const policy = await channelPolicy(db, c.id).catch(() => null);
      const tz = policy?.tz ?? 'Asia/Kolkata';
      const [spend, slots, { data: briefs }, { data: eps }] = await Promise.all([
        channelSpend(db, c.id).catch(() => null),
        upcomingSlots(db, c.id, todayIn(tz), 14).catch(() => []),
        db.from('briefs').select('id, slot_id, premise').eq('channel_id', c.id).eq('status', 'pending').order('created_at'),
        db.from('episodes').select('id, slot_id, status, status_detail, brief_id').eq('channel_id', c.id).in('status', ['awaiting_cut', 'halted', 'failed', 'scripting', 'voicing', 'generating', 'assembling', 'qc', 'shotlisting', 'estimating', 'queued']),
      ]);
      return { c, policy, spend, slots, briefs: briefs ?? [], eps: eps ?? [] };
    }),
  );

  const totalMonth = per.reduce<number | null>((a, p) => (p.spend?.monthInr == null ? a : (a ?? 0) + p.spend.monthInr), null);
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10));

  type Need = { ch: string; chId: string; slot: string; tone: ReturnType<typeof episodeState>['tone']; stage: string; why: string; action: React.ReactNode; key: string };
  const needs: Need[] = [];
  for (const p of per) {
    for (const b of p.briefs)
      needs.push({ ch: p.c.name, chId: p.c.id, slot: b.slot_id ?? 'bank', tone: 'draft', stage: 'Needs approval', why: `Brief waiting for a punchline pick — ${titleOf(b.premise)}`, action: <span className="xs t3">switch channel to approve</span>, key: b.id });
    for (const e of p.eps.filter((x) => ['awaiting_cut', 'halted', 'failed'].includes(x.status))) {
      const st = episodeState(e.status);
      needs.push({
        ch: p.c.name,
        chId: p.c.id,
        slot: e.slot_id ?? 'bank',
        tone: st.tone,
        stage: st.label,
        why: e.status === 'awaiting_cut' ? 'The cut is waiting for your review' : e.status_detail ?? 'The run stopped without saying why',
        action: e.status === 'awaiting_cut' ? <span className="xs t3">switch channel to review</span> : <StartRun episodeId={e.id} restart />,
        key: e.id,
      });
    }
  }

  return (
    <main className="main">
      <ScreenHeader
        channel={null}
        crumb="Home"
        title="All channels"
        sub={`${all.length} channel${all.length === 1 ? '' : 's'} · totals sum across channels · each channel keeps its own caps`}
        actions={
          <>
            <Link className="btn" href="/channels/new">
              <Icon name="plus" />
              Add channel
            </Link>
          </>
        }
      />

      <section className="kgrid ga-380" aria-label="Channels">
        {per.map(({ c, spend, slots, briefs, eps, policy }) => {
          const blocked = eps.filter((e) => e.status === 'halted' || e.status === 'failed').length;
          const cuts = eps.filter((e) => e.status === 'awaiting_cut').length;
          const next = slots[0];
          const share = spend?.monthInr != null && spend.monthlyCap ? spend.monthInr / spend.monthlyCap : null;
          return (
            <article className="card" key={c.id} style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="card-b row" style={{ gap: 14, flexWrap: 'nowrap' }}>
                <div className="av lg" aria-hidden="true">
                  {initials(c.name)}
                </div>
                <div className="col grow" style={{ gap: 2 }}>
                  <h2 className="h2">{c.name}</h2>
                  <span className="mono xs t3">{c.handle ?? 'no handle'}{c.hasBible ? '' : ' · no bible yet'}</span>
                </div>
                {blocked > 0 ? <Pill tone="blk">{blocked} blocked</Pill> : policy?.kill ? <Pill tone="blk">stopped</Pill> : <Pill tone="live">running</Pill>}
              </div>
              <div className="hr" />
              <div className="kgrid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', padding: 16, gap: 12 }}>
                <div className="col" style={{ gap: 4 }}>
                  <span className="lbl">Next slot</span>
                  <span className="mono" style={{ fontSize: 18 }}>
                    {next?.id ?? '—'}
                  </span>
                  <span className="xs t3">{next ? `${longDate(next.date)}${policy ? ` · ${policy.slotTime.slice(0, 5)}` : ''}` : 'none on the calendar'}</span>
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <span className="lbl">Needs you</span>
                  <span className="mono" style={{ fontSize: 18 }}>
                    {briefs.length} <span className="t3 sm">brief{briefs.length === 1 ? '' : 's'}</span>
                  </span>
                  <span className="xs t3">
                    {cuts} cut{cuts === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <span className="lbl">
                    Month {spend?.monthInr != null && <Basis kind="est" short />}
                  </span>
                  <span className="mono" style={{ fontSize: 18 }}>
                    {spend?.monthInr == null ? '—' : inr(spend.monthInr)}
                  </span>
                  <span className="xs t3">{spend?.monthlyCap != null ? `of ${inr(spend.monthlyCap)}` : 'no cap set'}</span>
                </div>
              </div>
              <div style={{ padding: '0 16px 16px' }}>
                <div className="bar">
                  <i style={{ width: `${Math.min(100, (share ?? 0) * 100)}%`, minWidth: share ? 2 : 0 }} />
                </div>
              </div>
              <div className="card-b" style={{ borderTop: '1px solid var(--b1)', paddingTop: 12, paddingBottom: 12 }}>
                <SwitchButton id={c.id} name={c.name} />
              </div>
            </article>
          );
        })}
        <Link
          className="card"
          href="/channels/new"
          style={{ textDecoration: 'none', color: 'inherit', borderStyle: 'dashed', borderColor: 'var(--b3)', background: 'transparent', boxShadow: 'none', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 12, padding: 28, minHeight: 200 }}
        >
          <div className="av lg add" style={{ fontSize: 20 }} aria-hidden="true">
            +
          </div>
          <span className="h3">Add a channel</span>
          <span className="xs t3" style={{ textAlign: 'center', maxWidth: 280 }}>
            Its own bible, cast, accent, publish targets, and its own daily and monthly caps.
          </span>
        </Link>
      </section>

      <div className="split">
        <section className="card wide" aria-label="Needs you — every channel">
          <div className="card-h">
            <h2 className="h3">Needs you — every channel</h2>
            <span className="mono xs t3">{needs.length} items</span>
          </div>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Slot</th>
                  <th>Stage</th>
                  <th>Why it’s here</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {needs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="sm t3">
                      Nothing needs you on any channel.
                    </td>
                  </tr>
                )}
                {needs.map((n) => (
                  <tr key={n.key}>
                    <td>
                      <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <span className="chm" aria-hidden="true" />
                        <span className="sm">{n.ch.split(' ')[0]}</span>
                      </span>
                    </td>
                    <td className="mono">{n.slot}</td>
                    <td>
                      <Pill tone={n.tone}>{n.stage}</Pill>
                    </td>
                    <td className="sm t2">{n.why}</td>
                    <td className="r">{n.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="side">
          <div className="card">
            <div className="card-h">
              <h2 className="h3">Spend · all channels</h2>
              {totalMonth !== null && <Basis kind="est" />}
            </div>
            <div className="card-b col" style={{ gap: 12 }}>
              <div className="row sb" style={{ alignItems: 'baseline' }}>
                {totalMonth === null ? <span className="unk" style={{ fontSize: 24 }}>—</span> : <span className="tv" style={{ fontSize: 24 }}>{inr(totalMonth)}</span>}
                <span className="mono xs t3">this month</span>
              </div>
              {per.map(({ c, spend }) => (
                <div className="row sb sm" key={c.id}>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="chm" aria-hidden="true" />
                    {c.name}
                  </span>
                  <span className="mono">{spend?.monthInr == null ? '—' : inr(spend.monthInr)}</span>
                </div>
              ))}
              <p className="xs t3">Caps are enforced per channel, never pooled.</p>
            </div>
          </div>
          <KillAll channels={per.map((p) => ({ id: p.c.id, name: p.c.name, on: p.policy?.kill ?? false }))} />
        </section>
      </div>

      <section className="card desk-only" aria-label="Next 14 days">
        <div className="card-h">
          <h2 className="h3">Next 14 days</h2>
          <span className="xs t3">fill shows state</span>
        </div>
        <div className="scroll-x">
          <div style={{ minWidth: 900, padding: 16, display: 'grid', gridTemplateColumns: '180px repeat(14, minmax(0, 1fr))', gap: '6px 4px', alignItems: 'center' }}>
            <span />
            {days.map((d) => (
              <span className="mono xs t3" style={{ textAlign: 'center' }} key={d}>
                {Number(d.slice(8))} {new Date(`${d}T00:00:00Z`).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}
              </span>
            ))}
            {per.map(({ c, slots, briefs, eps }) => (
              <Row key={c.id} name={c.name} days={days} slots={slots} pending={new Set(briefs.map((b) => b.slot_id))} eps={eps} />
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function Row({ name, days, slots, pending, eps }: { name: string; days: string[]; slots: { id: string; date: string }[]; pending: Set<string | null>; eps: { slot_id: string | null; status: string }[] }) {
  return (
    <>
      <span className="row sm" style={{ gap: 8 }}>
        <span className="chm" aria-hidden="true" />
        {name}
      </span>
      {days.map((d) => {
        const s = slots.find((x) => x.date === d);
        const ep = s ? eps.find((e) => e.slot_id === s.id) : undefined;
        const tone = ep ? episodeState(ep.status).tone : 'draft';
        return (
          <div key={d} style={{ height: 40, borderRadius: 8, background: 'var(--in)', border: '1px solid var(--b1)', display: 'grid', placeItems: 'center' }}>
            {s && (
              <span className={`pill s-${tone}${ep || pending.has(s.id) ? '' : ' nodot'}`} style={{ height: 26, padding: '0 7px' }} title={ep ? episodeState(ep.status).label : pending.has(s.id) ? 'brief waiting' : 'no brief yet'}>
                {s.id}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
