import Link from 'next/link';

import { CsvImport } from '@/components/bureau/csv-import';
import { ScreenHeader } from '@/components/shell/screen-header';
import { inr } from '@/components/ui/card';
import { Basis, Gate } from '@/components/ui/tags';
import { GATES, metricsSummary, parseRange, topPerformers } from '@/lib/bureau/read';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Metrics' };

/**
 * Metrics (canvas: Metrics, Metrics-m) — KPIs against the gates, views per day, viewed vs
 * swiped per Short against its line, the per-Short table, name mentions, and the Studio CSV
 * import. The canvas draws this screen with sample numbers; here every figure is a measured
 * snapshot or an em dash with the reason, and nothing is labelled "sample".
 */

const RANGES = ['24h', '7d', '28d'] as const;
const pctFmt = (v: number | null, d = 0) => (v === null ? null : `${v.toFixed(d)}`);

export default async function MetricsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  const range = (RANGES as readonly string[]).includes(r ?? '') ? r! : '7d';
  const channel = await requireChannel();
  const cb = bibleOrNull(channel);
  const db = serverClient();
  const { from } = parseRange(range);
  const [m, m28, top, { data: pubs }] = await Promise.all([
    metricsSummary(db, channel.id, range),
    metricsSummary(db, channel.id, '28d'),
    topPerformers(db, channel.id, 20),
    db.from('publications').select('id, slot_id, title, platform, status, published_at, scheduled_for').eq('channel_id', channel.id).in('status', ['scheduled', 'live']).order('published_at', { ascending: true }),
  ]);
  const pubIds = (pubs ?? []).map((p) => p.id);
  const { data: snaps } = pubIds.length
    ? await db.from('metrics_snapshots').select('publication_id, captured_at, views, status').in('publication_id', pubIds).eq('status', 'measured').gte('captured_at', from.toISOString()).order('captured_at')
    : { data: [] as { publication_id: string; captured_at: string; views: number | null; status: string }[] };

  // Views per day: for each day, the sum over Shorts of the latest measured cumulative views.
  const days = new Map<string, Map<string, number>>();
  for (const s of snaps ?? []) {
    if (s.views === null) continue;
    const d = s.captured_at.slice(0, 10);
    const per = days.get(d) ?? new Map<string, number>();
    per.set(s.publication_id, Number(s.views));
    days.set(d, per);
  }
  const series: { d: string; v: number }[] = [];
  const running = new Map<string, number>();
  for (const d of [...days.keys()].sort()) {
    for (const [p, v] of days.get(d)!) running.set(p, v);
    series.push({ d, v: [...running.values()].reduce((a, b) => a + b, 0) });
  }

  const perfByPub = new Map(top.performers.map((p) => [p.publication_id, p]));
  const rows = (pubs ?? []).map((p) => ({ pub: p, perf: perfByPub.get(p.id) ?? null }));
  const bars = rows.filter((x) => x.perf?.viewed_vs_swiped != null).slice(-6);

  const tiles = [
    { label: 'Views', value: m.views === null ? null : m.views.toLocaleString('en-IN'), unit: '', gate: null, verdict: 'unknown' as const, why: m.views === null ? `undefined — no measured Short in ${range}` : `${m.shorts_measured} Shorts`, basis: 'meas' as const },
    { label: 'Viewed vs swiped', value: pctFmt(m.viewed_vs_swiped_median_last20), unit: '%', gate: `${GATES.vvsa_pct}%`, verdict: m.gates.vvsa, why: m.viewed_vs_swiped_median_last20 === null ? 'undefined — needs the Studio CSV' : 'median of last 20 · gate 70%' },
    { label: 'APV median', value: pctFmt(m.apv_median), unit: '%', gate: `${GATES.apv_pct}%`, verdict: m.gates.apv, why: m.apv_median === null ? 'undefined — no measured Short' : 'average % viewed' },
    { label: 'Subs / 1k views', value: m.subs_per_1k_views === null ? null : m.subs_per_1k_views.toFixed(2), unit: '', gate: String(GATES.subs_per_1k), verdict: m.gates.subs_per_1k, why: m.subs_gained === null ? 'undefined — no subs reported' : `${m.subs_gained} subs gained` },
    { label: '₹ / Short', value: m.cost_per_short_inr === null ? null : inr(m.cost_per_short_inr), unit: '', gate: `₹${GATES.inr_per_short}`, verdict: m.gates.inr_per_short, why: m.cost_per_short_inr === null ? 'undefined — no published Short with every row priced' : 'unpriced episodes excluded', basis: 'est' as const },
  ];

  const W = 640;
  const H = 220;
  const maxV = Math.max(1, ...series.map((s) => s.v));
  const x = (i: number) => 40 + (series.length <= 1 ? 0 : (i / (series.length - 1)) * (W - 50));
  const y = (v: number) => 190 - (v / maxV) * 170;
  const line = series.map((s, i) => `${x(i)},${y(s.v)}`).join(' ');
  const area = series.length ? `40,190 ${line} ${x(series.length - 1)},190` : '';

  return (
    <main className="main">
      <ScreenHeader
        channel={channel}
        crumb="Metrics"
        title="Metrics"
        sub={`${m.shorts_measured} Short${m.shorts_measured === 1 ? '' : 's'} measured in ${range}`}
        actions={
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((x) => (
              <Link key={x} className={x === range ? 'on' : undefined} href={`/bureau/metrics?r=${x}`} aria-current={x === range ? 'true' : undefined}>
                {x}
              </Link>
            ))}
          </div>
        }
      />

      <section className="kgrid ga-160" aria-label="Gates">
        {tiles.map((t) => (
          <div className="card tile" key={t.label}>
            <div className="row sb">
              <span className="lbl">{t.label}</span>
              {t.gate && <Gate state={t.verdict}>{t.gate}</Gate>}
            </div>
            {t.value === null ? (
              <span className="unk">—</span>
            ) : (
              <span className="tv">
                {t.value}
                {t.unit && <small>{t.unit}</small>}
              </span>
            )}
            <span className="why">
              {t.basis && t.value !== null && <Basis kind={t.basis} short />} {t.why}
            </span>
          </div>
        ))}
      </section>

      <div className="split">
        <section className="card wide" aria-label="Views per day">
          <div className="card-h">
            <h2 className="h3">Views per day</h2>
            <span className="row xs t3" style={{ gap: 6 }}>
              <span className="chm" aria-hidden="true" />
              {channel.name}
            </span>
          </div>
          <div className="card-b">
            {series.length === 0 ? (
              <div className="empty" style={{ minHeight: 180 }}>
                <span className="unk" style={{ fontSize: 22 }}>
                  —
                </span>
                <span>Undefined — no measured snapshot in {range}. The first is taken 48 h after a Short goes live.</span>
              </div>
            ) : (
              <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cumulative views, ${series[0]!.d} to ${series[series.length - 1]!.d}`}>
                {[20, 80, 140, 190].map((gy) => (
                  <line key={gy} className="gl" x1="40" y1={gy} x2={W - 10} y2={gy} />
                ))}
                <text className="ax" x="0" y="24">
                  {maxV.toLocaleString('en-IN')}
                </text>
                <text className="ax" x="0" y="194">
                  0
                </text>
                <polygon className="ar" points={area} />
                <polyline className="ln" points={line} />
                {series.map((s, i) => (
                  <circle key={s.d} className="pt" cx={x(i)} cy={y(s.v)} r="3">
                    <title>
                      {s.d}: {s.v.toLocaleString('en-IN')} views
                    </title>
                  </circle>
                ))}
                <text className="ax" x="40" y="212">
                  {series[0]!.d.slice(5)}
                </text>
                <text className="ax" x={W - 60} y="212">
                  {series[series.length - 1]!.d.slice(5)}
                </text>
              </svg>
            )}
          </div>
        </section>
        <section className="card side" aria-label="Viewed vs swiped per Short">
          <div className="card-h">
            <h2 className="h3">Viewed vs swiped · per Short</h2>
          </div>
          <div className="card-b">
            {bars.length === 0 ? (
              <div className="empty" style={{ minHeight: 180 }}>
                <span className="unk" style={{ fontSize: 22 }}>
                  —
                </span>
                <span>Not in the Analytics API — import the Studio CSV below.</span>
              </div>
            ) : (
              <svg className="chart" viewBox="0 0 300 220" role="img" aria-label="Viewed vs swiped by Short against the 70 percent gate">
                <line className="gl" x1="30" y1="190" x2="290" y2="190" />
                {bars.map((b, i) => {
                  const v = b.perf!.viewed_vs_swiped!;
                  const h = (v / 100) * 170;
                  const bx = 40 + i * (250 / bars.length);
                  return (
                    <g key={b.pub.id}>
                      <rect className="bx" x={bx} y={190 - h} width={Math.min(52, 250 / bars.length - 10)} height={h} rx="4" style={{ opacity: v >= GATES.vvsa_pct ? 1 : 0.55 }} />
                      <text className="ax" x={bx + 4} y={186 - h}>
                        {v.toFixed(0)}%
                      </text>
                      <text className="ax" x={bx + 4} y="208">
                        {b.pub.slot_id ?? '—'}
                      </text>
                    </g>
                  );
                })}
                <line className="th" x1="30" y1={190 - 0.7 * 170} x2="290" y2={190 - 0.7 * 170} />
                <text className="ax" x="0" y={194 - 0.7 * 170} style={{ fill: 'var(--rev)' }}>
                  70%
                </text>
              </svg>
            )}
          </div>
        </section>
      </div>

      <section className="card" aria-label="Per Short">
        <div className="card-h">
          <h2 className="h3">Per Short</h2>
          <span className="xs t3">gates: VVSA 70% · APV 70% · 1 sub/1k · ₹150 · policy</span>
        </div>
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Short</th>
                <th>Live</th>
                <th className="r">Views</th>
                <th className="r">VVSA</th>
                <th className="r">APV</th>
                <th className="r">Subs</th>
                <th>Gates</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="sm t3">
                    Nothing is scheduled or live yet, so there is nothing to measure.
                  </td>
                </tr>
              )}
              {rows.map(({ pub, perf }) => (
                <tr key={pub.id}>
                  <td className={`mono${perf ? '' : ' t3'}`}>{pub.slot_id ?? '—'}</td>
                  <td className="sm">{pub.title}</td>
                  <td className="mono xs t3">{pub.published_at ? new Date(pub.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : pub.status}</td>
                  {perf ? (
                    <>
                      <td className="r mono">{perf.views?.toLocaleString('en-IN') ?? '—'}</td>
                      <td className="r mono">{perf.viewed_vs_swiped === null ? '—' : `${perf.viewed_vs_swiped.toFixed(0)}%`}</td>
                      <td className="r mono">{perf.apv === null ? '—' : `${perf.apv.toFixed(0)}%`}</td>
                      <td className="r mono">{perf.subs_gained ?? '—'}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          <Gate state={perf.viewed_vs_swiped === null ? 'unknown' : perf.viewed_vs_swiped >= GATES.vvsa_pct ? 'pass' : 'fail'}>VVSA</Gate>
                          <Gate state={perf.apv === null ? 'unknown' : perf.apv >= GATES.apv_pct ? 'pass' : 'fail'}>APV</Gate>
                        </div>
                      </td>
                    </>
                  ) : (
                    <td colSpan={5} className="xs t3">
                      undefined — snapshot pending (first at 48 h)
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split">
        <section className="card wide" aria-label="Name mentions">
          <div className="card-h">
            <h2 className="h3">Character-name mentions</h2>
            <span className="mono xs t3">
              {range} / 28d · {m.mentions_per_1k_views === null ? '— per 1k views' : `${m.mentions_per_1k_views.toFixed(2)} per 1k views`}
            </span>
          </div>
          <div className="feed">
            {Object.keys(m28.character_mentions).length === 0 && <div className="fi sm t3">No comments ingested yet.</div>}
            {Object.entries(m28.character_mentions)
              .sort((a, b) => b[1] - a[1])
              .map(([slug, n]) => (
                <div className="fi" key={slug}>
                  <span className="sm grow">{cb?.characterBySlug(slug)?.name ?? slug}</span>
                  <span className="mono sm">
                    {m.character_mentions[slug] ?? 0} / {n}
                  </span>
                </div>
              ))}
          </div>
        </section>
        <section className="card side" aria-label="Studio CSV">
          <div className="card-h">
            <h2 className="h3">Viewed vs swiped — Studio CSV</h2>
          </div>
          <div className="card-b col" style={{ gap: 10 }}>
            <p className="xs t3">Not in the Analytics API. Studio → Analytics → Advanced mode → Shorts, export per video, upload here.</p>
            <CsvImport channelId={channel.id} />
          </div>
        </section>
      </div>
    </main>
  );
}
