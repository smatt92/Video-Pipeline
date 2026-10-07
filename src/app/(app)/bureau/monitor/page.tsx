import Link from 'next/link';

import { LiveRefresh } from '@/components/bureau/live-status';
import { KillSwitchCard } from '@/components/shell/kill-switch-card';
import { ScreenHeader } from '@/components/shell/screen-header';
import { inr, Note } from '@/components/ui/card';
import { Basis, Pill } from '@/components/ui/tags';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { channelPolicy, channelSpend } from '@/lib/screens/common';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Generation' };

/**
 * Generation monitor (canvas: Generation, Generation-m): what is in flight and queued per
 * provider, what failed and why, spend by provider this month against the caps, the alerts
 * and the kill switch. Provider names are the rows' own (`v_gen_queue.provider`,
 * `cost_ledger.driver`) — this screen names no vendor itself. `?w=7d` widens the window.
 */
export default async function MonitorPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const window = w === '7d' ? '7d' : '24h';
  const since = new Date(Date.now() - (window === '7d' ? 7 : 1) * 86_400_000).toISOString();
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const channel = await requireChannel();
  const db = serverClient();
  const [{ data: queues }, { data: failures }, spend, policy, { data: alerts }, { data: ledger }, { data: okRows }] = await Promise.all([
    db.from('v_gen_queue').select('*').order('provider'),
    db
      .from('gen_jobs')
      .select('id, episode_id, provider, model, render_route, last_error, last_error_code, attempts, updated_at')
      .eq('status', 'failed')
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(20),
    channelSpend(db, channel.id),
    channelPolicy(db, channel.id),
    db.from('notifications').select('id, kind, text, delivered, detail, created_at').eq('channel_id', channel.id).order('created_at', { ascending: false }).limit(10),
    db.from('cost_ledger').select('driver, cost_inr, cost_source').eq('channel_id', channel.id).gte('occurred_at', monthStart),
    db.from('gen_jobs').select('id, provider').eq('status', 'succeeded').gte('updated_at', since),
  ]);
  const q = queues ?? [];
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const inFlight = q.reduce((a, r) => a + n(r.in_flight), 0);
  const queued = q.reduce((a, r) => a + n(r.queued), 0);
  const okN = (okRows ?? []).length;
  const fails = failures ?? [];
  const okBy = (okRows ?? []).reduce<Record<string, number>>((m, r) => ({ ...m, [r.provider]: (m[r.provider] ?? 0) + 1 }), {});

  // Failed jobs → their episode's slot, for the sentence.
  const epIds = [...new Set(fails.map((f) => f.episode_id).filter((x): x is string => !!x))];
  const eps = epIds.length ? (await db.from('episodes').select('id, slot_id, status').in('id', epIds)).data ?? [] : [];
  const epOf = new Map(eps.map((e) => [e.id, e]));

  // Spend by provider, this month. A row with no rupee figure is unpriced, never ₹0.
  const byDriver = new Map<string, { inr: number; unpriced: number; measured: number; rows: number }>();
  for (const l of ledger ?? []) {
    const cur = byDriver.get(l.driver) ?? { inr: 0, unpriced: 0, measured: 0, rows: 0 };
    cur.rows += 1;
    if (l.cost_inr === null) cur.unpriced += 1;
    else cur.inr += Number(l.cost_inr);
    if (l.cost_source === 'measured') cur.measured += 1;
    byDriver.set(l.driver, cur);
  }
  const drivers = [...byDriver.entries()].sort((a, b) => b[1].inr - a[1].inr);
  const monthTotal = drivers.reduce((a, [, v]) => a + v.inr, 0);
  const allMeasured = drivers.length > 0 && drivers.every(([, v]) => v.measured === v.rows);
  const todayShare = spend?.todayInr != null && spend.dailyCap ? spend.todayInr / spend.dailyCap : null;

  return (
    <main className="main">
      <LiveRefresh active={inFlight > 0 || queued > 0} everyMs={15_000} />
      <ScreenHeader
        channel={channel}
        crumb="Generation"
        title="Generation monitor"
        mobileTitle="Generation"
        sub={policy?.kill ? `Kill switch ON — ${policy.killReason ?? 'stopped'}` : `${inFlight} in flight · ${queued} queued`}
        actions={
          <>
            <span className="row sm t3" style={{ gap: 6 }}>
              <span className="dot" style={{ background: inFlight + queued > 0 ? 'var(--live)' : 'var(--t3)' }} aria-hidden="true" />
              {inFlight + queued > 0 ? 'live · refreshes every 15 s' : 'idle'}
            </span>
            <div className="seg" role="group" aria-label="Window">
              <Link className={window === '24h' ? 'on' : undefined} href="/bureau/monitor">
                24h
              </Link>
              <Link className={window === '7d' ? 'on' : undefined} href="/bureau/monitor?w=7d">
                7d
              </Link>
            </div>
          </>
        }
      />

      {policy?.kill && (
        <Note>
          Kill switch ON since {policy.killAt ? new Date(policy.killAt).toLocaleString('en-IN') : '—'}: {policy.killReason}. No new generation claims and no publishing until it is turned off.
        </Note>
      )}

      <section className="kgrid ga-220" aria-label="Totals">
        <div className="card tile">
          <span className="lbl">In flight</span>
          <span className="tv">{inFlight}</span>
          <span className="why">{inFlight === 0 ? 'nothing generating right now' : `across ${q.filter((r) => n(r.in_flight) > 0).length} provider(s)`}</span>
        </div>
        <div className="card tile">
          <span className="lbl">Queued</span>
          <span className="tv">{queued}</span>
          <span className="why">{queued === 0 ? 'nothing waiting for a slot' : 'waiting on a provider limit'}</span>
        </div>
        <div className="card tile">
          <span className="lbl">Jobs OK · {window}</span>
          <span className="tv">{okN}</span>
          <span className="why">{Object.entries(okBy).map(([p, c]) => `${p} ${c}`).join(' · ') || 'none finished in the window'}</span>
        </div>
        <div className={`card tile${fails.length ? ' is-blk' : ''}`}>
          <span className="lbl">Failed · {window}</span>
          <span className={`tv${fails.length ? ' tblk' : ''}`}>{fails.length}</span>
          <span className="why">{fails.length ? [...new Set(fails.map((f) => f.last_error_code ?? 'error'))].join(' · ') : 'no failures in the window'}</span>
        </div>
      </section>

      <section className="card" aria-label="Providers">
        <div className="card-h">
          <h2 className="h3">Providers</h2>
          <span className="xs t3">limit = max concurrent jobs Kiln will send · OK/failed in the last 24 h</span>
        </div>
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Provider</th>
                <th className="r">Limit</th>
                <th>In flight</th>
                <th className="r">Queued</th>
                <th className="r">Throttled</th>
                <th className="r">OK 24h</th>
                <th className="r">Failed 24h</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {q.length === 0 && (
                <tr>
                  <td colSpan={8} className="sm t3">
                    No provider rows — the generation queue view returned nothing.
                  </td>
                </tr>
              )}
              {q.map((r) => {
                const limit = n(r.max_concurrency);
                const fl = n(r.in_flight);
                const failed = n(r.failed_24h);
                const ok = n(r.succeeded_24h);
                const health = failed > 0 && ok === 0 ? { tone: 'blk' as const, label: 'Failing' } : failed > 0 ? { tone: 'rev' as const, label: 'Some failures' } : ok > 0 ? { tone: 'live' as const, label: 'OK' } : { tone: 'draft' as const, label: 'Idle' };
                return (
                  <tr key={r.provider}>
                    <td style={{ fontWeight: 500 }}>{r.provider}</td>
                    <td className="r mono">{limit}</td>
                    <td>
                      <span className="q" role="img" aria-label={`${fl} of ${limit} in flight`}>
                        {Array.from({ length: Math.min(limit, 12) }, (_, i) => (
                          <i key={i} className={i < fl ? 'f' : undefined} />
                        ))}
                      </span>
                    </td>
                    <td className="r mono">{n(r.queued)}</td>
                    <td className="r mono">{n(r.throttled)}</td>
                    <td className="r mono">{ok}</td>
                    <td className="r mono" style={failed ? { color: 'var(--blk)' } : undefined}>
                      {failed}
                    </td>
                    <td>
                      <Pill tone={health.tone}>{health.label}</Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split">
        <section className="wide card" aria-label="Recent failures">
          <div className="card-h">
            <h2 className="h3">Recent failures</h2>
            <span className="mono xs t3">
              {fails.length} in {window}
            </span>
          </div>
          <div className="feed">
            {fails.length === 0 && <div className="fi sm t3">No failed job in the window.</div>}
            {fails.map((f) => {
              const ep = f.episode_id ? epOf.get(f.episode_id) : undefined;
              return (
                <div className="fi" key={f.id} style={{ alignItems: 'center' }}>
                  <span className="t">{new Date(f.updated_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}</span>
                  <div className="col grow" style={{ gap: 4 }}>
                    <div className="row" style={{ gap: 8 }}>
                      {ep && (
                        <span className="mono sm" style={{ fontWeight: 600 }}>
                          {ep.slot_id ?? 'bank'}
                        </span>
                      )}
                      <span className="sm">
                        {f.provider} · {f.render_route}
                      </span>
                    </div>
                    <span className="mono xs t3">
                      {f.last_error_code ?? 'error'} · {f.attempts} attempt{f.attempts === 1 ? '' : 's'}
                    </span>
                    {f.last_error && <span className="sm t2">{f.last_error.slice(0, 200)}</span>}
                  </div>
                  {ep && (
                    <Link className="btn sm" href={`/bureau/board#${ep.id}`}>
                      Open
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <aside className="side">
          <section className="card" aria-label="Spend by provider">
            <div className="card-h">
              <h2 className="h3">Spend by provider · month</h2>
              {drivers.length > 0 && <Basis kind={allMeasured ? 'meas' : 'est'} />}
            </div>
            <div className="card-b col" style={{ gap: 12 }}>
              {drivers.length === 0 && <p className="sm t3">No ledger row this month — nothing has been charged, so there is nothing to split.</p>}
              {drivers.map(([d, v]) => (
                <div className="col" style={{ gap: 6 }} key={d}>
                  <div className="row sb sm">
                    <span>{d}</span>
                    <span className="mono">
                      {inr(v.inr)}
                      {v.unpriced ? <span className="xs t3"> + {v.unpriced} unpriced</span> : null}
                    </span>
                  </div>
                  <div className="bar">
                    <i style={{ width: `${monthTotal ? (v.inr / monthTotal) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
              <div className="row sb sm">
                <span className="t2">Render worker</span>
                <span className="mono t3">
                  — <span className="xs">compute not ledgered</span>
                </span>
              </div>
              <div className="hr" />
              <div className="row sb sm">
                <span className="t2">Today vs {spend?.dailyCap != null ? `${inr(spend.dailyCap)} cap` : 'no cap'}</span>
                <span className="mono">{spend?.todayInr == null ? '—' : inr(spend.todayInr)}</span>
              </div>
              <div className={`bar${todayShare !== null && todayShare >= 0.8 ? ' blk' : ''}`}>
                <i style={{ width: `${Math.min(100, (todayShare ?? 0) * 100)}%`, minWidth: todayShare ? 2 : 0 }} />
              </div>
              <div className="row sb sm">
                <span className="t2">Month vs {spend?.monthlyCap != null ? `${inr(spend.monthlyCap)} cap` : 'no cap'}</span>
                <span className="mono">{spend?.monthInr == null ? '—' : inr(spend.monthInr)}</span>
              </div>
            </div>
          </section>
          <section className="card" aria-label="Alerts">
            <div className="card-h">
              <h2 className="h3">Alerts</h2>
            </div>
            <div className="feed">
              {(alerts ?? []).length === 0 && <div className="fi sm t3">No alerts for this channel.</div>}
              {(alerts ?? []).map((a) => (
                <div className="fi" key={a.id}>
                  <span className="t">{new Date(a.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                  <div className="col grow" style={{ gap: 2 }}>
                    <span className="sm">{a.text}</span>
                    <span className="xs" style={{ color: a.delivered ? 'var(--t3)' : 'var(--blk-text)' }}>
                      {a.kind} · {a.delivered ? 'sent' : `not delivered: ${a.detail ?? 'no reason recorded'}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <KillSwitchCard channelId={channel.id} channelName={channel.name} on={policy?.kill ?? false} reason={policy?.killReason ?? null} known={policy !== null} />
        </aside>
      </div>
    </main>
  );
}
