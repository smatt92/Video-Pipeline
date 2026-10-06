import { BureauNav } from '@/components/bureau/bureau-nav';
import { KillSwitch } from '@/components/bureau/kill-switch';
import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

const inr = (v: unknown) => (v === null || v === undefined ? '—' : `₹${Number(v).toFixed(0)}`);

/** Generation queues per provider, recent failures, spend against the caps, the kill switch. */
export default async function MonitorPage() {
  const db = serverClient();
  const [{ data: queues }, { data: failures }, { data: spend }, { data: pol }, { data: alerts }] = await Promise.all([
    db.from('v_gen_queue').select('*').order('provider'),
    db.from('gen_jobs').select('id, provider, model, render_route, last_error, last_error_code, attempts, updated_at').eq('status', 'failed').order('updated_at', { ascending: false }).limit(20),
    db.from('v_channel_spend').select('*').eq('channel_id', BUREAU_CHANNEL_ID).maybeSingle(),
    db.from('channel_policy').select('*').eq('channel_id', BUREAU_CHANNEL_ID).single(),
    db.from('notifications').select('kind, text, delivered, detail, created_at').eq('channel_id', BUREAU_CHANNEL_ID).order('created_at', { ascending: false }).limit(15),
  ]);
  const caps = [
    ['Today', spend?.today_inr, spend?.daily_cap_inr],
    ['This month', spend?.month_inr, spend?.monthly_cap_effective_inr],
  ] as const;
  return (
    <main className="mx-auto w-full max-w-[1100px] px-4 py-6">
      <BureauNav active="monitor" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Generation monitor</h1>
          <p className="mt-1 text-sm" style={{ color: pol?.kill_switch ? 'var(--state-blocked)' : 'var(--text-muted)' }}>
            {pol?.kill_switch ? `Kill switch ON since ${new Date(pol.kill_switch_at!).toLocaleString('en-IN')}: ${pol.kill_switch_reason}` : 'Running. Concurrency is enforced by the database per provider.'}
          </p>
        </div>
        <KillSwitch on={!!pol?.kill_switch} />
      </div>

      <section className="mt-5 grid gap-3 sm:grid-cols-2">
        {caps.map(([label, used, cap]) => {
          const pct = used !== null && used !== undefined && cap ? (Number(used) / Number(cap)) * 100 : null;
          return (
            <div key={label} className="rounded-md border p-3" style={{ borderColor: 'var(--border-default)' }}>
              <div className="text-2xs" style={{ color: 'var(--text-muted)' }}>{label} (rate-card estimates)</div>
              <div className="mt-1 font-mono text-md tabular-nums">{inr(used)} / {inr(cap)}</div>
              <div className="text-2xs" style={{ color: pct !== null && pct >= 80 ? 'var(--state-blocked)' : 'var(--text-faint)' }}>{pct === null ? '—' : `${pct.toFixed(0)}% of cap`}</div>
            </div>
          );
        })}
      </section>

      <h2 className="mt-6 text-sm font-medium">Queues</h2>
      <table className="mt-2 w-full text-sm tabular-nums">
        <thead className="text-left text-2xs" style={{ color: 'var(--text-muted)' }}>
          <tr><th className="py-1">Provider</th><th>Limit</th><th>In flight</th><th>Queued</th><th>Throttled</th><th>OK 24h</th><th>Failed 24h</th></tr>
        </thead>
        <tbody>
          {(queues ?? []).map((q) => (
            <tr key={q.provider}>
              <td className="py-1">{q.provider}</td><td>{q.max_concurrency}</td><td>{q.in_flight}</td><td>{q.queued}</td><td>{q.throttled}</td><td>{q.succeeded_24h}</td>
              <td style={{ color: Number(q.failed_24h) > 0 ? 'var(--state-blocked)' : undefined }}>{q.failed_24h}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-6 text-sm font-medium">Recent failures</h2>
      {(failures ?? []).length === 0 ? <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>None.</p> : (
        <ul className="mt-2 grid gap-1 text-2xs">
          {(failures ?? []).map((f) => (
            <li key={f.id}><span className="font-mono">{f.provider}/{f.render_route}</span> · {f.last_error_code ?? 'error'} · {f.last_error?.slice(0, 160)} · {f.attempts} attempt(s)</li>
          ))}
        </ul>
      )}

      <h2 className="mt-6 text-sm font-medium">Alerts</h2>
      <ul className="mt-2 grid gap-1 text-2xs">
        {(alerts ?? []).map((a, i) => (
          <li key={i}>
            <span className="font-mono">{new Date(a.created_at).toLocaleString('en-IN')}</span> · {a.kind} · {a.text}{' '}
            <span style={{ color: a.delivered ? 'var(--text-faint)' : 'var(--state-blocked)' }}>{a.delivered ? 'sent' : `not delivered: ${a.detail}`}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
