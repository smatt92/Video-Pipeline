import { BureauNav } from '@/components/bureau/bureau-nav';
import { CsvImport } from '@/components/bureau/csv-import';
import { BUREAU_CHANNEL_ID, characterBySlug } from '@/lib/bureau/bible';
import { GATES, metricsSummary, topPerformers } from '@/lib/bureau/read';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

const fmt = (v: number | null, d = 1, suffix = '') => (v === null ? '—' : `${v.toFixed(d)}${suffix}`);

/** KPIs against the gates, character-name mentions, top performers, the Studio CSV import. */
export default async function MetricsPage() {
  const db = serverClient();
  const [m28, m7, top] = await Promise.all([metricsSummary(db, BUREAU_CHANNEL_ID, '28d'), metricsSummary(db, BUREAU_CHANNEL_ID, '7d'), topPerformers(db, BUREAU_CHANNEL_ID, 10)]);
  const tiles = [
    { label: 'Viewed vs swiped (median, last 20)', v: fmt(m28.viewed_vs_swiped_median_last20, 1, '%'), gate: `≥ ${GATES.vvsa_pct}%`, verdict: m28.gates.vvsa },
    { label: 'Average % viewed (median)', v: fmt(m28.apv_median, 1, '%'), gate: `≥ ${GATES.apv_pct}%`, verdict: m28.gates.apv },
    { label: 'Subs per 1k views', v: fmt(m28.subs_per_1k_views, 2), gate: `≥ ${GATES.subs_per_1k}`, verdict: m28.gates.subs_per_1k },
    { label: 'Cost per Short (estimates)', v: m28.cost_per_short_inr === null ? '—' : `₹${m28.cost_per_short_inr.toFixed(0)}`, gate: `≤ ₹${GATES.inr_per_short}`, verdict: m28.gates.inr_per_short },
    { label: 'Name mentions per 1k views', v: fmt(m28.mentions_per_1k_views, 2), gate: 'trend', verdict: 'unknown' as const },
  ];
  const tone = (v: string) => (v === 'pass' ? 'var(--state-live)' : v === 'fail' ? 'var(--state-blocked)' : 'var(--text-faint)');
  return (
    <main className="mx-auto w-full max-w-[1100px] px-4 py-6">
      <BureauNav active="metrics" />
      <h1 className="text-lg font-medium">Metrics</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Last 28 days, {m28.shorts_measured} Short(s) measured. {m28.note ?? ''}</p>
      <section className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-md border p-3" style={{ borderColor: 'var(--border-default)' }}>
            <div className="text-2xs" style={{ color: 'var(--text-muted)' }}>{t.label}</div>
            <div className="mt-1 font-mono text-md tabular-nums">{t.v}</div>
            <div className="text-2xs" style={{ color: tone(t.verdict) }}>gate {t.gate} · {t.verdict}</div>
          </div>
        ))}
      </section>
      <section className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="text-sm font-medium">Character-name mentions (7d / 28d)</h2>
          <ul className="mt-2 grid gap-1 text-sm">
            {Object.entries(m28.character_mentions).sort((a, b) => b[1] - a[1]).map(([slug, n]) => (
              <li key={slug} className="flex justify-between"><span>{characterBySlug(slug)?.name ?? slug}</span><span className="font-mono tabular-nums">{m7.character_mentions[slug] ?? 0} / {n}</span></li>
            ))}
            {Object.keys(m28.character_mentions).length === 0 && <li style={{ color: 'var(--text-muted)' }}>No comments ingested yet.</li>}
          </ul>
        </div>
        <div>
          <h2 className="text-sm font-medium">Top performers</h2>
          <ol className="mt-2 grid gap-1 text-sm">
            {top.performers.map((p) => (
              <li key={p.publication_id} className="flex justify-between gap-2"><span>{p.title}</span><span className="font-mono text-2xs tabular-nums">{fmt(p.apv, 0, '%')} APV · {p.views ?? '—'} views · {p.hook_archetype ?? '—'}</span></li>
            ))}
            {top.performers.length === 0 && <li style={{ color: 'var(--text-muted)' }}>{top.note ?? 'Nothing measured yet.'}</li>}
          </ol>
        </div>
      </section>
      <section className="mt-6">
        <h2 className="text-sm font-medium">Viewed vs swiped — Studio CSV</h2>
        <p className="mt-1 text-2xs" style={{ color: 'var(--text-muted)' }}>Not in the Analytics API. Studio → Analytics → Advanced mode → Shorts, export per video, upload here.</p>
        <div className="mt-2"><CsvImport /></div>
      </section>
    </main>
  );
}
