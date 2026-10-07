import Link from 'next/link';

import { ScreenHeader } from '@/components/shell/screen-header';
import { inr as fmtInr, Note } from '@/components/ui/card';
import { Basis } from '@/components/ui/tags';
import { costsLedger } from '@/lib/bureau/read';
import { requireChannel } from '@/lib/channels/active';
import { readCostByStage } from '@/lib/cost/by-stage';
import { readVideoCosts, type VideoCostRow } from '@/lib/cost/video';
import { serverClient } from '@/lib/db/server';
import { readObservability, withheld } from '@/lib/pipeline/observability';
import { channelSpend } from '@/lib/screens/common';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Costs' };

/**
 * Costs (canvas: Costs, Costs-m) — the headline metric, with its denominator.
 *
 * Cost per video is undefined until a video exists, and the screen says so in those words:
 * "₹0.00 per video" would be a claim that the pipeline produces videos for free, made by a
 * page reporting that it has never produced one. Every ₹ carries its basis (estimate from the
 * rate card, or measured), a stage that has never run says "never run — not ₹0", and spend
 * that belongs to no video is listed rather than folded in.
 *
 * Three outcomes, never two: rows, empty, or broken.
 */

const inr = (v: number | null) => (v === null ? '—' : fmtInr(v));

const EXCLUSION: Record<VideoCostRow['denominatorState'], string> = {
  countable_measured: 'counted — measured',
  countable_estimated: 'counted — from rate card',
  not_rendered: 'not a video yet — nothing has rendered',
  unpriced: 'cost unknown — a contributing call has no verified rate',
  nothing_incurred: 'nothing incurred yet — every charge is still committed',
};

const RANGES = [
  { key: '1d', label: 'Today' },
  { key: '7d', label: '7d' },
  { key: '28d', label: '28d' },
] as const;

export default async function CostsPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  const range = RANGES.some((x) => x.key === r) ? r! : '28d';
  const channel = await requireChannel();
  const db = serverClient();
  const [result, stages, observed, ledger, spend] = await Promise.all([
    readVideoCosts(),
    readCostByStage(),
    readObservability(),
    costsLedger(db, channel.id, range).catch(() => null),
    channelSpend(db, channel.id),
  ]);

  const header = (
    <ScreenHeader
      channel={channel}
      crumb="Costs"
      title="Costs"
      sub="Per video, from the cost ledger — with the number of videos it was divided by."
      actions={
        <div className="seg" role="group" aria-label="Ledger range">
          {RANGES.map((x) => (
            <Link key={x.key} className={x.key === range ? 'on' : undefined} href={`/costs?r=${x.key}`} aria-current={x.key === range ? 'true' : undefined}>
              {x.label}
            </Link>
          ))}
        </div>
      }
    />
  );

  if (!result.ok) {
    return (
      <main className="main">
        {header}
        <div className="blocker" role="alert">
          <p>
            The cost read failed. <span>{result.hint}</span>
            <br />
            <span className="mono xs">{result.error}</span>
          </p>
        </div>
      </main>
    );
  }

  const { rows, unattributed, countable, costPerVideoInr, excluded } = result;
  const share = (u: number | null, c: number | null) => (u === null || !c ? null : u / c);
  const todayShare = share(spend?.todayInr ?? null, spend?.dailyCap ?? null);
  const monthShare = share(spend?.monthInr ?? null, spend?.monthlyCap ?? null);
  const ledgerBasis: 'est' | 'meas' = ledger && ledger.rows > 0 && ledger.measured_rows === ledger.rows ? 'meas' : 'est';

  return (
    <main className="main">
      {header}

      <section className="kgrid ga-220" aria-label="Channel spend">
        <div className="card tile">
          <div className="row sb">
            <span className="lbl">Today</span>
            {spend?.todayInr != null && <Basis kind={ledgerBasis} />}
          </div>
          {spend?.todayInr == null ? (
            <span className="unk">—</span>
          ) : (
            <span className="tv">
              {inr(spend.todayInr)}
              <small>/ {inr(spend.dailyCap)}</small>
            </span>
          )}
          <div className={`bar${todayShare !== null && todayShare >= 0.8 ? ' blk' : ''}`}>
            <i style={{ width: `${Math.min(100, (todayShare ?? 0) * 100)}%`, minWidth: todayShare ? 2 : 0 }} />
          </div>
        </div>
        <div className="card tile">
          <div className="row sb">
            <span className="lbl">This month</span>
            {spend?.monthInr != null && <Basis kind={ledgerBasis} />}
          </div>
          {spend?.monthInr == null ? (
            <span className="unk">—</span>
          ) : (
            <span className="tv">
              {inr(spend.monthInr)}
              <small>/ {inr(spend.monthlyCap)}</small>
            </span>
          )}
          <div className={`bar${monthShare !== null && monthShare >= 0.8 ? ' blk' : ''}`}>
            <i style={{ width: `${Math.min(100, (monthShare ?? 0) * 100)}%`, minWidth: monthShare ? 2 : 0 }} />
          </div>
        </div>
        <div className="card tile">
          <span className="lbl">Measured rows · {RANGES.find((x) => x.key === range)!.label}</span>
          {ledger === null ? (
            <span className="unk">—</span>
          ) : (
            <span className="tv">
              {ledger.measured_rows}
              <small>of {ledger.rows}</small>
            </span>
          )}
          <span className="why">
            {ledger === null
              ? 'ledger not readable'
              : ledger.rows === 0
                ? 'no ledger row in this range'
                : ledger.measured_rows === 0
                  ? 'every row so far is a rate-card estimate'
                  : `${ledger.unpriced_rows} unpriced`}
          </span>
        </div>
        <div className="card tile">
          <div className="row sb">
            <span className="lbl">Cost per video</span>
            {costPerVideoInr !== null && <Basis kind={result.costPerVideoBasis === 'measured' ? 'meas' : 'est'} />}
          </div>
          {costPerVideoInr === null ? <span className="unk">—</span> : <span className="tv">{inr(costPerVideoInr)}</span>}
          <span className="why">
            {countable === 0
              ? `undefined — no video has both rendered and incurred a priced charge${spend?.perShortCap != null ? ` · cap ${inr(spend.perShortCap)}` : ''}`
              : `over ${countable} video${countable === 1 ? '' : 's'} · ${
                  result.costPerVideoBasis === 'measured' ? 'measured' : result.costPerVideoBasis === 'mixed' ? 'part measured, part rate card' : 'from the rate card, not what the vendor charged'
                }`}
          </span>
        </div>
      </section>

      <div className="row sm t3" style={{ gap: 16 }}>
        <span>
          Workspace measured {inr(result.measuredTotalInr)} <Basis kind="meas" short />
        </span>
        <span>
          From rate card {inr(result.estimatedTotalInr)} <Basis kind="est" short />
        </span>
      </div>

      {countable === 0 && (
        <p className="sm t3">
          {result.ledgerEmpty
            ? 'Nothing has cost anything yet. This is an empty ledger, not a free pipeline.'
            : 'There is spend on the ledger but no finished video to divide it by, so the per-video figure is undefined rather than zero. It becomes a number when a script has rendered and every call it made has a verified rate.'}
        </p>
      )}

      {/* Why nothing will settle, said once rather than inferred from every row — computed from
          the data, so the day a reconcile row exists it stops appearing. */}
      {!observed.generation_settled.observed && countable > 0 && (
        <Note>
          <b>This average is priced by us, not by the vendor.</b> {withheld('generation_settled').missingWriter} A completed generation is counted from its estimate rather than skipped — inventing a reconcile
          equal to the estimate would put a fabricated figure in the ledger everything derives from.
        </Note>
      )}

      <div className="split">
        <section className="wide card" aria-label="By stage">
          <div className="card-h">
            <h2 className="h3">By stage</h2>
            <span className="xs t3">workspace</span>
          </div>
          {!stages.ok ? (
            <div className="card-b">
              <div className="blocker" role="alert">
                <p>
                  {stages.hint} <span className="mono xs">{stages.error}</span>
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th className="r">Incurred</th>
                      <th className="r">Committed</th>
                      <th className="r">Scripts</th>
                      <th className="r">Per script</th>
                      <th>What it buys</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stages.rows.map((s) => (
                      <tr key={s.stage} style={{ opacity: s.hasRun ? 1 : 0.6 }}>
                        <td>
                          {s.label} <span className="mono xs t3">{s.stage}</span>
                        </td>
                        {s.hasRun ? (
                          <>
                            <td className="r mono">{inr(s.settledInr)}</td>
                            <td className="r mono t3">{inr(s.openEstimateInr)}</td>
                            <td className="r mono">{s.scripts}</td>
                            <td className="r mono">{inr(s.inrPerScript)}</td>
                          </>
                        ) : (
                          <td colSpan={4} className="xs t3">
                            never run — not ₹0
                          </td>
                        )}
                        <td className="xs t2">{s.what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-b xs t3">
                {stages.stagesRun} of {stages.rows.length} charging stages have ever written a ledger row. A per-script figure is undefined for a stage that has charged no script.
              </div>
            </>
          )}
        </section>

        <section className="side card" aria-label="Spend by component">
          <div className="card-h">
            <h2 className="h3">By component · {RANGES.find((x) => x.key === range)!.label}</h2>
            {ledger && ledger.rows > 0 && <Basis kind={ledgerBasis} />}
          </div>
          <div className="card-b col" style={{ gap: 12 }}>
            {(!ledger || ledger.rows === 0) && <p className="sm t3">No ledger row for {channel.name} in this range.</p>}
            {ledger &&
              Object.entries(ledger.by_component)
                .sort((a, b) => b[1].inr - a[1].inr)
                .map(([k, v]) => (
                  <div className="col" style={{ gap: 6 }} key={k}>
                    <div className="row sb sm">
                      <span>{k}</span>
                      <span className="mono">
                        {inr(v.inr)}
                        {v.unpriced ? <span className="xs t3"> + {v.unpriced} unpriced</span> : null}
                      </span>
                    </div>
                    <div className="bar">
                      <i style={{ width: `${ledger.priced_total_inr ? (v.inr / ledger.priced_total_inr) * 100 : 0}%` }} />
                    </div>
                  </div>
                ))}
          </div>
        </section>
      </div>

      <section className="card" aria-label="Per video">
        <div className="card-h">
          <h2 className="h3">Per video</h2>
          <span className="xs t3">workspace · every script with spend</span>
        </div>
        {rows.length === 0 ? (
          <div className="card-b">
            <div className="empty">
              <span style={{ color: 'var(--t2)', fontWeight: 500 }}>No video has cost anything yet</span>
              <span>A row appears the moment any spend attaches to a script. It counts toward the average once that script has a ready render and every call it made has a verified rate.</span>
              <Link className="btn sm" href="/settings/rate-card" style={{ marginTop: 6 }}>
                Rate card
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Concept</th>
                    <th className="r">Incurred</th>
                    <th className="r">Committed</th>
                    <th>Where it went</th>
                    <th className="r">Renders</th>
                    <th>Counted?</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.scriptId}>
                      <td>{v.title}</td>
                      <td className="r mono">
                        {inr(v.measuredInr === null && v.estimatedInr === null ? null : (v.measuredInr ?? 0) + (v.estimatedInr ?? 0))}{' '}
                        {v.measuredRows === 0 && (v.estimatedInr ?? 0) > 0 && <Basis kind="est" short />}
                      </td>
                      <td className="r mono t3">{inr(v.committedInr)}</td>
                      <td className="mono xs t3">
                        {Object.entries(v.componentInr)
                          .map(([k, c]) => `${k} ${c.inr === null ? '—' : fmtInr(Number(c.inr))}`)
                          .join('  ·  ') || '—'}
                      </td>
                      <td className="r mono">{v.renders === 0 ? '—' : `${v.rendersReady}/${v.renders}`}</td>
                      <td className="xs t3">{EXCLUSION[v.denominatorState]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-b xs t3">
              {excluded.notRendered + excluded.unpriced + excluded.nothingIncurred} of {rows.length} excluded from the average — {excluded.notRendered} not rendered, {excluded.unpriced} unpriced,{' '}
              {excluded.nothingIncurred} with nothing incurred. Excluded, and listed: an average whose denominator you cannot see is not a measurement.
            </div>
          </>
        )}
      </section>

      <section className="card" aria-label="Ledger">
        <div className="card-h">
          <h2 className="h3">Ledger · {channel.name}</h2>
          <span className="xs t3">rate card = our price × quantity · measured = vendor figure or observed balance move</span>
        </div>
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Time · IST</th>
                <th>Vendor</th>
                <th>Component</th>
                <th>Unit</th>
                <th>Entry</th>
                <th className="r">₹</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {(!ledger || ledger.recent.length === 0) && (
                <tr>
                  <td colSpan={7} className="sm t3">
                    No ledger row in this range.
                  </td>
                </tr>
              )}
              {ledger?.recent.map((l) => (
                <tr key={l.id ?? `${l.occurred_at}-${l.driver}`}>
                  <td className="mono sm">{l.occurred_at ? new Date(l.occurred_at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td>{l.driver}</td>
                  <td className="sm t2">{l.component ?? '—'}</td>
                  <td className="mono xs t2">{l.unit}</td>
                  <td className="xs t3">{l.entry_kind}</td>
                  <td className="r mono">{l.cost_inr === null ? <span className="t3">unpriced</span> : fmtInr(Number(l.cost_inr))}</td>
                  <td>
                    <Basis kind={l.cost_source === 'measured' ? 'meas' : 'est'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {unattributed.length > 0 && (
        <section className="card" aria-label="Spend that belongs to no video">
          <div className="card-h">
            <h2 className="h3">Spend that belongs to no video</h2>
            <span className="xs t3">real money, not part of any video’s cost</span>
          </div>
          <div className="scroll-x">
            <table className="tbl">
              <tbody>
                {unattributed.map((u) => (
                  <tr key={`${u.component}-${u.entryKind}`}>
                    <td>{u.component}</td>
                    <td className="xs t3">{u.entryKind}</td>
                    <td className="r mono">{inr(u.inr)}</td>
                    <td className="r xs t3">
                      {u.rowsN} row{u.rowsN === 1 ? '' : 's'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
