import Link from 'next/link';

import { ApprovalDesk } from '@/components/bureau/approval-card';
import { ScreenHeader } from '@/components/shell/screen-header';
import { Bust } from '@/components/ui/bust';
import { inr, Note } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Basis, CastChip, Gate, Pill, Stag } from '@/components/ui/tags';
import { pendingBriefs } from '@/lib/bureau/briefs';
import { formatOptions } from '@/lib/bureau/format-estimates';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { castFor, channelPolicy, longDate, titleOf, todayIn, tzAbbrev, upcomingSlots } from '@/lib/screens/common';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approvals' };

/**
 * Approvals (canvas: Approvals, Approvals-m). One brief at a time in slot order — the oldest
 * pending first, or `?id=` from the queue. Premise, cast, the three punchlines, beat sheet,
 * script, shot list, fact and source, titles, the estimate with its basis, and the server's
 * own check results. Approve and Reject are the same server actions Claude chat calls.
 */

interface Beat {
  beat_id?: string;
  summary?: string;
}
interface Shot {
  route?: string;
  description?: string;
  duration_s?: number;
  characters?: string[];
}
interface EstimateBasis {
  total_inr?: number | null;
  voice_inr?: number | null;
  shots?: { route: string; planned_inr: number | null; basis: string }[];
  unpriced?: string[];
}

const ROUTE_LABEL: Record<string, string> = {
  overlay: 'Overlay',
  still: 'Scene still',
  character_beat: 'Character beat',
  money_shot: 'Money shot',
};

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

function status(v: unknown): string | null {
  const s = (v as { status?: unknown } | null)?.status;
  return typeof s === 'string' ? s : null;
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const channel = await requireChannel();
  const bible = bibleOrNull(channel);
  const db = serverClient();
  const [briefs, policy] = await Promise.all([pendingBriefs(db, channel.id), channelPolicy(db, channel.id)]);
  const tz = policy?.tz ?? 'Asia/Kolkata';
  const slots = await upcomingSlots(db, channel.id, todayIn(tz), 8).catch(() => []);
  const briefSlots = new Set(briefs.map((b) => b.slot_id));

  const header = (
    <ScreenHeader
      channel={channel}
      crumb="Approvals"
      title="Approvals"
      sub={briefs.length === 0 ? 'Nothing waiting' : `${briefs.length} brief${briefs.length === 1 ? '' : 's'} waiting`}
      actions={
        <>
          <span className="chip on">Briefs · {briefs.length}</span>
          <span className="xs t3">A / B / C to pick · ↵ approve · X reject</span>
        </>
      }
    />
  );

  if (briefs.length === 0) {
    return (
      <main className="main">
        {header}
        <div className="empty" style={{ padding: 40 }}>
          <span style={{ color: 'var(--t2)', fontWeight: 500 }}>Nothing waiting</span>
          <span>New briefs land here when the agent drafts them for a slot. Approving one starts its run.</span>
          <Link className="btn sm" href="/bureau/calendar" style={{ marginTop: 8 }}>
            Open calendar
          </Link>
        </div>
      </main>
    );
  }

  const idx = Math.max(0, briefs.findIndex((b) => b.id === id));
  const b = briefs[idx]!;
  const slot = slots.find((s) => s.id === b.slot_id) ?? null;
  const cast = castFor(bible, b.lead_character, b.supporting_characters ?? []);
  const beats = (Array.isArray(b.beat_sheet) ? b.beat_sheet : []) as Beat[];
  const shots = (Array.isArray(b.shot_list) ? b.shot_list : []) as Shot[];
  const fact = (b.fact ?? {}) as { claim?: string; source_url?: string; source_title?: string };
  const titles = (Array.isArray(b.titles) ? b.titles : []).map((t) => (typeof t === 'string' ? t : String((t as { text?: unknown }).text ?? '')));
  const est = (b.estimate_basis ?? {}) as EstimateBasis;
  const estimateInr = b.estimate_inr === null ? null : Number(b.estimate_inr);
  const scriptLines = b.script_text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const totalS = shots.reduce((n, s) => n + (Number(s.duration_s) || 0), 0);
  const routeCounts = shots.reduce<Record<string, number>>((m, s) => ({ ...m, [s.route ?? '?']: (m[s.route ?? '?'] ?? 0) + 1 }), {});
  const byRoute = (est.shots ?? []).reduce<Record<string, { n: number; inr: number | null; basis: string }>>((m, l) => {
    const cur = m[l.route] ?? { n: 0, inr: 0, basis: l.basis };
    return { ...m, [l.route]: { n: cur.n + 1, inr: cur.inr === null || l.planned_inr === null ? null : cur.inr + l.planned_inr, basis: l.basis } };
  }, {});
  const policyStatus = status(b.policy);
  const variationStatus = status(b.variation);
  const fmts = await formatOptions(db, channel.id, { series: b.series, shot_list: b.shot_list, script_text: b.script_text, lead_character: b.lead_character });
  const seriesName = slot?.seriesName ?? bible?.series[b.series as keyof typeof bible.series]?.name ?? b.series;

  const briefCard = (
    <section className="card" aria-label="Brief">
      <div className="card-b col" style={{ gap: 16 }}>
        <div className="row sb">
          <div className="row" style={{ gap: 10 }}>
            <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
              {b.slot_id ?? 'bank'}
            </span>
            <span className="mono sm t3">
              {b.slot_date ? `${longDate(b.slot_date)}${policy ? ` · ${policy.slotTime.slice(0, 5)} ${tzAbbrev(tz)}` : ''}` : 'no slot — bank'}
            </span>
            <span className={`slot ${SERIES_CLASS[b.series] ?? ''}`} style={{ flexDirection: 'row', padding: '2px 8px' }}>
              <span className="sid">
                <span className="sdot" />
                {seriesName}
              </span>
            </span>
            {slot?.seasonalTag && <Stag>{slot.seasonalTag}</Stag>}
          </div>
          <Pill tone="draft">Needs approval</Pill>
        </div>
        <div className="row" style={{ gap: 14, flexWrap: 'nowrap', alignItems: 'center' }}>
          {cast.slice(0, 3).map((c, i) => (
            <Bust key={c.slug} slug={c.slug} accent={c.accent} size={i === 0 ? 'md' : 'sm'} />
          ))}
          <div className="col grow" style={{ gap: 8, marginLeft: 6 }}>
            <h2 className="h1" style={{ fontSize: 22 }}>
              {titleOf(b.premise)}
            </h2>
            <p className="t2">{b.premise}</p>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {cast.map((c) => (
            <CastChip key={c.slug} slug={c.slug} name={c.name} accent={c.accent} lead={c.lead} />
          ))}
        </div>
      </div>
    </section>
  );

  const details = (
    <div style={{ display: 'contents' }}>
      <div className="kgrid ga-380">
        <details className="card" open>
          <summary className="card-h">
            <h2 className="h3">Beat sheet</h2>
            <span className="mono xs t3 row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              {beats.length} beats{totalS ? ` · ≈ ${Math.round(totalS)} s` : ''} <Icon name="chevron" className="chev" size={12} />
            </span>
          </summary>
          <div className="card-b col" style={{ gap: 0 }}>
            {beats.length === 0 && <p className="sm t3">No beat sheet on this brief.</p>}
            {beats.map((x, i) => (
              <div className="ln" key={i}>
                <span className="mono xs t3">{x.beat_id ?? i + 1}</span>
                <span>{x.summary ?? '—'}</span>
              </div>
            ))}
          </div>
        </details>
        <details className="card" open>
          <summary className="card-h">
            <h2 className="h3">Script</h2>
            <span className="mono xs t3 row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              {scriptLines.length} lines · {b.script_text.length} chars <Icon name="chevron" className="chev" size={12} />
            </span>
          </summary>
          <div className="card-b col" style={{ gap: 0 }}>
            {scriptLines.map((l, i) => {
              const m = /^([A-Za-z .'-]{2,24}):\s*(.+)$/.exec(l);
              const who = m ? cast.find((c) => c.name.toLowerCase().includes(m[1]!.trim().toLowerCase()) || c.slug === m[1]!.trim().toLowerCase()) : null;
              return (
                <div className="ln" key={i}>
                  {who ? (
                    <span className={`cast c-${who.slug === 'complaint_box' ? 'box' : who.slug === 'auditor' ? 'aud' : who.slug}`} style={{ height: 24 }}>
                      <i style={{ width: 18, height: 18 }} />
                      {who.name.split(' ').slice(-1)[0]}
                    </span>
                  ) : (
                    <span className="mono xs t3">{m ? m[1] : i + 1}</span>
                  )}
                  <span>{m ? m[2] : l}</span>
                </div>
              );
            })}
            <div className="ln">
              <span className="mono xs t3">punchline</span>
              <span className="t3">— inserted from your pick —</span>
            </div>
          </div>
        </details>
      </div>

      <details className="card" open>
        <summary className="card-h">
          <h2 className="h3">Shot list</h2>
          <div className="row">
            {Object.entries(routeCounts).map(([r, n]) => (
              <span key={r} className={`pill ${r === 'overlay' || r === 'still' ? 's-ac' : 's-draft'} nodot`}>
                {n} {(ROUTE_LABEL[r] ?? r).toLowerCase()}
              </span>
            ))}
            <Icon name="chevron" className="chev t3" size={12} />
          </div>
        </summary>
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>Route</th>
                <th className="r">Dur</th>
                <th>Shot</th>
              </tr>
            </thead>
            <tbody>
              {shots.length === 0 && (
                <tr>
                  <td colSpan={4} className="sm t3">
                    No shots planned on this brief.
                  </td>
                </tr>
              )}
              {shots.map((s, i) => (
                <tr key={i}>
                  <td className="mono">{i + 1}</td>
                  <td>
                    <span className="chip">{ROUTE_LABEL[s.route ?? ''] ?? s.route ?? '—'}</span>
                  </td>
                  <td className="r mono">{s.duration_s != null ? `${Number(s.duration_s).toFixed(1)} s` : '—'}</td>
                  <td className="sm t2">{s.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="kgrid ga-380">
        <section className="card card-b col" style={{ gap: 10 }}>
          <span className="lbl">Fact + source</span>
          <p>{fact.claim ?? '—'}</p>
          {fact.source_url ? (
            <a className="sm tlink" href={fact.source_url} target="_blank" rel="noreferrer">
              {fact.source_title ?? new URL(fact.source_url).hostname} ↗
            </a>
          ) : (
            <span className="sm t3">No source on this brief.</span>
          )}
        </section>
        <section className="card card-b col" style={{ gap: 8 }}>
          <span className="lbl">Titles</span>
          {titles.map((t, i) => (
            <span className="row sm" style={{ gap: 10 }} key={i}>
              <span className="mono xs t3">{i + 1}</span>
              {t}
            </span>
          ))}
          <span className="xs t3">Chosen at bundle time; listed here so a weak set can be a reject reason.</span>
        </section>
      </div>
    </div>
  );

  const decision = (
    <div style={{ display: 'contents' }}>
      <div className="col" style={{ gap: 6 }}>
        {est.voice_inr !== undefined && (
          <div className="row sb">
            <span className="sm t2">Voice · {b.script_text.length} chars</span>
            <span className="mono sm">
              {est.voice_inr === null ? (
                <span className="t3">unpriced</span>
              ) : (
                <>
                  {inr(est.voice_inr)} <Basis kind="est" short />
                </>
              )}
            </span>
          </div>
        )}
        {Object.entries(byRoute).map(([r, v]) => (
          <div className="row sb" key={r}>
            <span className="sm t2">
              {v.n} {(ROUTE_LABEL[r] ?? r).toLowerCase()}
              {v.n === 1 ? '' : 's'}
            </span>
            <span className="mono sm">
              {v.inr === null ? (
                <span className="t3">
                  — <span className="xs">unpriced</span>
                </span>
              ) : v.inr === 0 ? (
                <span className="t3">
                  — <span className="xs">in-house, not ledgered</span>
                </span>
              ) : (
                <>
                  {inr(v.inr)} <Basis kind="est" short />
                </>
              )}
            </span>
          </div>
        ))}
        <div className="hr" style={{ margin: '4px 0' }} />
        <div className="row sb">
          <span className="sm">Total</span>
          <span className="mono">
            {estimateInr === null ? (
              <span className="t3">— unpriced</span>
            ) : (
              <>
                {inr(estimateInr)} <Basis kind="est" short />
              </>
            )}
          </span>
        </div>
        {estimateInr === null && (est.unpriced?.length ?? 0) > 0 && <span className="xs t3">Unpriced: {est.unpriced!.join('; ')}.</span>}
        {policy?.perShortCap != null && <span className="xs t3">Per-Short cap {inr(policy.perShortCap)}</span>}
      </div>
      <div className="col" style={{ gap: 8 }}>
        <span className="lbl">Checks</span>
        <div className="row" style={{ gap: 6 }}>
          <Gate state={policyStatus === 'pass' ? 'pass' : policyStatus ? 'fail' : 'unknown'}>Policy {policyStatus === 'pass' ? '✓' : policyStatus ? `· ${policyStatus}` : '—'}</Gate>
          <Gate state={variationStatus === 'pass' ? 'pass' : variationStatus ? 'fail' : 'unknown'}>
            Variation {variationStatus === 'pass' ? '✓' : variationStatus ? `· ${variationStatus}` : '—'}
          </Gate>
        </div>
        {b.flagged && (b.flag_reasons ?? []).map((f) => <Note key={f}>{f}</Note>)}
      </div>
    </div>
  );

  const queue = (
    <section className="card" aria-label="Queue">
      <div className="card-h">
        <h2 className="h3">Queue</h2>
      </div>
      <div className="feed">
        {briefs.map((q) => (
          <Link key={q.id} href={`/bureau/approvals?id=${q.id}`} className="fi link" style={q.id === b.id ? { background: 'var(--s2)' } : undefined} aria-current={q.id === b.id ? 'true' : undefined}>
            <span className="mono sm">{q.slot_id ?? 'bank'}</span>
            <span className="sm grow">{titleOf(q.premise)}</span>
            {q.id === b.id ? <Pill tone="draft">Now</Pill> : <span className="xs t3">waiting</span>}
          </Link>
        ))}
        {slots
          .filter((s) => !briefSlots.has(s.id))
          .slice(0, 3)
          .map((s) => (
            <div className="fi" key={s.id}>
              <span className="mono sm t3">{s.id}</span>
              <span className="sm grow t3">{s.topic ?? s.seriesName}</span>
              <span className="xs t3">no brief yet</span>
            </div>
          ))}
      </div>
    </section>
  );

  return (
    <main className="main">
      {header}
      <ApprovalDesk
        key={b.id}
        brief={{ id: b.id, slot: b.slot_id, premise: b.premise, punchlines: (Array.isArray(b.punchlines) ? b.punchlines : []).map(String) }}
        header={briefCard}
        details={details}
        decision={decision}
        aside={queue}
        position={`${idx + 1} of ${briefs.length}`}
        formats={fmts.options}
        defaultFormat={fmts.seriesDefault}
        defaultPace={fmts.seriesPace}
      />
    </main>
  );
}
