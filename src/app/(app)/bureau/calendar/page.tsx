import Link from 'next/link';

import { ScreenHeader } from '@/components/shell/screen-header';
import { Icon } from '@/components/ui/icon';
import { Pill, Stag, type StateTone } from '@/components/ui/tags';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { channelPolicy, todayIn, tzAbbrev } from '@/lib/screens/common';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Calendar' };

/**
 * Calendar (canvas: Calendar, Calendar-m). A month of slots, each coloured by series, with its
 * seasonal tag and where production stands. A slot two days out with no approved brief is
 * flagged "produce now": an episode needs a day to render and a day to review. `?m=YYYY-MM`.
 * The phone gets the month as a dot grid and the agenda below it.
 */

const SERIES_CLASS: Record<string, string> = {
  incident: 'sr-incident',
  desk_tour: 'sr-desk',
  pip: 'sr-pip',
  archive: 'sr-archive',
  myth: 'sr-myth',
  deep: 'sr-deep',
  complaint: 'sr-complaint',
  long_form: 'sr-long',
};

const STATUS: Record<string, { label: string; cls: string; tone: StateTone; href: string }> = {
  open: { label: 'open', cls: 'st', tone: 'draft', href: '/bureau/approvals' },
  needs_approval: { label: 'brief', cls: 'st drf', tone: 'draft', href: '/bureau/approvals' },
  generating: { label: 'making', cls: 'st gen', tone: 'gen', href: '/bureau/board' },
  awaiting_cut: { label: 'cut', cls: 'st rev', tone: 'rev', href: '/bureau/cuts' },
  bundled: { label: 'ready', cls: 'st rdy', tone: 'rdy', href: '/bureau/ready' },
  scheduled: { label: 'scheduled', cls: 'st rdy', tone: 'rdy', href: '/bureau/ready' },
  live: { label: 'live', cls: 'st rdy', tone: 'live', href: '/bureau/metrics' },
  halted: { label: 'blocked', cls: 'st blk', tone: 'blk', href: '/bureau/board' },
  failed: { label: 'blocked', cls: 'st blk', tone: 'blk', href: '/bureau/board' },
};
const statusOf = (s: string | null) => STATUS[s ?? 'open'] ?? { label: s ?? '—', cls: 'st', tone: 'draft' as StateTone, href: '/bureau/board' };

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const { m } = await searchParams;
  const channel = await requireChannel();
  const cb = bibleOrNull(channel);
  const db = serverClient();
  const policy = await channelPolicy(db, channel.id);
  const tz = policy?.tz ?? 'Asia/Kolkata';
  const today = todayIn(tz);
  const [ty, tm] = (m && /^\d{4}-\d{2}$/.test(m) ? m : today.slice(0, 7)).split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(ty, tm - 1, 1));
  const last = new Date(Date.UTC(ty, tm, 0));
  const lead = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(first.getTime() - lead * 86_400_000);
  const cells = Math.ceil((lead + last.getUTCDate()) / 7) * 7;
  const gridEnd = new Date(gridStart.getTime() + (cells - 1) * 86_400_000);

  const [{ data: slots }, { count: bank }] = await Promise.all([
    db
      .from('v_slot_status')
      .select('id, slot_date, series, series_name, lead, topic, seasonal_tag, production_status, kind')
      .eq('channel_id', channel.id)
      .gte('slot_date', iso(gridStart))
      .lte('slot_date', iso(gridEnd))
      .order('slot_date'),
    db.from('slots').select('id', { count: 'exact', head: true }).eq('channel_id', channel.id).eq('kind', 'bank'),
  ]);
  const byDate = new Map<string, NonNullable<typeof slots>>();
  for (const s of slots ?? []) byDate.set(s.slot_date!, [...(byDate.get(s.slot_date!) ?? []), s]);
  const produceBy = iso(new Date(new Date(`${today}T00:00:00Z`).getTime() + 2 * 86_400_000));
  const late = (date: string, st: string | null) => date <= produceBy && date >= today && ['open', 'needs_approval', null].includes(st);

  const monthName = first.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const prev = `${new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7)}`;
  const next = `${new Date(Date.UTC(ty, tm, 1)).toISOString().slice(0, 7)}`;
  const series = [...new Map((slots ?? []).map((s) => [s.series, s.series_name ?? s.series])).entries()];
  const inMonth = (slots ?? []).filter((s) => s.slot_date && s.slot_date.slice(0, 7) === iso(first).slice(0, 7));
  const agenda = inMonth.filter((s) => s.slot_date! >= (today.slice(0, 7) === iso(first).slice(0, 7) ? today : iso(first))).slice(0, 10);
  const days = Array.from({ length: cells }, (_, i) => iso(new Date(gridStart.getTime() + i * 86_400_000)));

  const nav = (
    <div className="row" style={{ gap: 4 }}>
      <Link className="btn sm icon" href={`/bureau/calendar?m=${prev}`} aria-label="Previous month">
        <Icon name="back" />
      </Link>
      <Link className="btn sm icon" href={`/bureau/calendar?m=${next}`} aria-label="Next month">
        <Icon name="chevron" />
      </Link>
    </div>
  );

  return (
    <main className="main">
      <ScreenHeader
        channel={channel}
        crumb="Calendar"
        title={
          <span className="row" style={{ gap: 12 }}>
            {monthName}
            {nav}
          </span>
        }
        mobileTitle={first.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })}
        sub={`${inMonth.length} slots · ${policy ? `${policy.slotTime.slice(0, 5)} ${tzAbbrev(tz)} daily` : 'no slot time'} · ${bank ?? '—'} in the bank`}
        actions={<span className="sm t3">Flagged: within two days and no approved brief</span>}
      />

      <div className="row desk-only" style={{ gap: 8 }}>
        {series.map(([id, name]) => (
          <span key={id} className={`slot ${SERIES_CLASS[id ?? ''] ?? ''}`} style={{ flexDirection: 'row', padding: '3px 8px' }}>
            <span className="sid">
              <span className="sdot" />
              {name}
            </span>
          </span>
        ))}
      </div>

      <div className="scroll-x desk-only">
        <div className="cal" style={{ minWidth: 880 }}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <span className="dow" key={d}>
              {d}
            </span>
          ))}
          {days.map((date) => {
            const out = date.slice(0, 7) !== iso(first).slice(0, 7);
            const list = byDate.get(date) ?? [];
            const tag = list.find((s) => s.seasonal_tag)?.seasonal_tag;
            return (
              <div key={date} className={`day${out ? ' out' : ''}${date === today ? ' today' : ''}`}>
                <div className="row sb" style={{ flexWrap: 'nowrap' }}>
                  <span className="dn">{Number(date.slice(8))}</span>
                  {tag && <Stag>{tag}</Stag>}
                </div>
                {list.map((s) => {
                  const st = statusOf(s.production_status);
                  const isLate = late(date, s.production_status);
                  const c = cb?.characterBySlug(cb?.leadsFromCalendar(s.lead)[0] ?? '');
                  return (
                    <Link key={s.id} className={`slot ${SERIES_CLASS[s.series ?? ''] ?? ''}${isLate ? ' late' : ''}`} href={st.href} title={`${s.topic ?? ''}${c ? ` · ${c.name}` : ''}`}>
                      <span className="sid">
                        <span className="chm" style={{ width: 6, height: 6 }} />
                        {s.id}
                        <span className={isLate ? 'st blk' : st.cls}>{isLate ? 'produce now' : st.label}</span>
                      </span>
                      <span className="tt">{s.topic ?? s.series_name}</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mob-only col" style={{ gap: 14 }}>
        <div className="row sb">
          <span className="lbl">{monthName}</span>
          {nav}
        </div>
        <div className="card card-b">
          <div className="mg" role="grid" aria-label={monthName}>
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span className="h" key={i} aria-hidden="true">
                {d}
              </span>
            ))}
            {days.map((date) => {
              const out = date.slice(0, 7) !== iso(first).slice(0, 7);
              const s = (byDate.get(date) ?? [])[0];
              const st = s ? statusOf(s.production_status) : null;
              return (
                <div key={date} className={`mc${out ? ' out' : ''}${date === today ? ' today' : ''}`} aria-label={`${date}${s ? ` ${s.id} ${st?.label}` : ''}`}>
                  <span>{Number(date.slice(8))}</span>
                  <i className={s && !out ? `s-${st!.tone}` : undefined} style={s && !out ? undefined : { background: 'transparent' }} />
                </div>
              );
            })}
          </div>
        </div>
        <span className="lbl">Coming up</span>
        <section className="card">
          {agenda.length === 0 && <div className="ag sm t3">No slots left this month.</div>}
          {agenda.map((s) => {
            const st = statusOf(s.production_status);
            const d = new Date(`${s.slot_date}T00:00:00Z`);
            const isLate = late(s.slot_date!, s.production_status);
            return (
              <Link className="ag" key={s.id} href={st.href}>
                <div className="col" style={{ width: 40, gap: 0 }}>
                  <span className="mono xs t3">{d.toLocaleString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase()}</span>
                  <span className="mono" style={{ fontSize: 18 }}>
                    {d.getUTCDate()}
                  </span>
                </div>
                <span className={`slot ${SERIES_CLASS[s.series ?? ''] ?? ''} grow`} style={{ padding: '8px 10px' }}>
                  <span className="sid">
                    <span className="chm" style={{ width: 6, height: 6 }} />
                    {s.id} · {s.series_name}
                  </span>
                  <span className="tt">{s.topic}</span>
                </span>
                <Pill tone={isLate ? 'blk' : st.tone} dot={!['open', 'needs_approval'].includes(s.production_status ?? 'open')}>
                  {isLate ? 'produce now' : st.label}
                </Pill>
              </Link>
            );
          })}
        </section>
      </div>
    </main>
  );
}
