import Link from 'next/link';

import { Hint } from '@/components/shell/hint';
import { readCostByStage } from '@/lib/cost/by-stage';
import { readObservability, withheld } from '@/lib/pipeline/observability';
import { readVideoCosts, type VideoCostRow } from '@/lib/cost/video';

/**
 * Costs — cost per video, from the ledger.
 *
 * ── The trap this screen was designed against, before it was written ─────────
 *
 * A costs page's obvious shape is a big number at the top. That number looks identical
 * after one video and after a hundred: it goes up, and nothing on screen says whether that
 * is a hundred cheap videos or one ruinous one. It is the same defect as a board deriving
 * its state from row counts — wired, plausible, and unable to distinguish the two
 * situations you actually care about.
 *
 * So the rows are the artifact and the average is derived, with the count it was divided by
 * printed beside it and every excluded video named. Reading down the page you can see which
 * video cost what, which ones could not be counted, and why — none of which a total carries.
 *
 * ── What this renders today ─────────────────────────────────────────────────
 *
 * Almost nothing, and it says so rather than looking broken. Only stages 3 and 4 have ever
 * run against a real vendor: four ledger rows, ₹6.07, on a single script that has never
 * been generated or rendered. So cost per video is *undefined* — there is no video — and
 * the empty state says that in those words. Rendering ₹0.00 per video would be the
 * absent-versus-zero violation on the one number CLAUDE.md rule 5 calls the project's
 * headline metric.
 *
 * Three outcomes, never two: rows, empty, or broken.
 */

const MAX_W = 'mx-auto w-full max-w-[1400px]';

const inr = (v: number | null) =>
  v === null
    ? '—'
    : `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EXCLUSION: Record<VideoCostRow['denominatorState'], string> = {
  countable_measured: 'counted — measured',
  countable_estimated: 'counted — from rate card',
  not_rendered: 'not a video yet — nothing has rendered',
  unpriced: 'cost unknown — a contributing call has no verified rate',
  nothing_incurred: 'nothing incurred yet — every charge is still committed',
};

export default async function CostsPage() {
  const [result, stages, observed] = await Promise.all([
    readVideoCosts(),
    readCostByStage(),
    readObservability(),
  ]);

  if (!result.ok) {
    return (
      <main className={`${MAX_W} px-6 py-8`}>
        <Header />
        <div
          className="mt-6 rounded-md border px-4 py-4 text-sm"
          style={{ borderColor: 'var(--state-blocked)', background: 'var(--state-blocked-bg)' }}
        >
          <div className="font-medium">The cost read failed.</div>
          <div className="mt-1" style={{ color: 'var(--text-muted)' }}>
            {result.hint}
          </div>
          <div className="mt-2 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
            {result.error}
          </div>
        </div>
      </main>
    );
  }

  const { rows, unattributed, countable, costPerVideoInr, excluded } = result;

  return (
    <main className={`${MAX_W} px-6 py-8`}>
      <Header />

      {/* The headline, with its denominator attached. Never one without the other. */}
      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        {/*
          The basis is part of the number, not a footnote.

          A figure built from rate-card estimates is a different claim from one built from
          what the vendor charged, and the moment they are shown identically somebody quotes
          the first as the second. Today it is always "from the rate card" — nothing writes
          a measured figure — and the label says so rather than the page implying a
          precision it does not have.
        */}
        <Figure
          label="Cost per video"
          value={inr(costPerVideoInr)}
          sub={
            countable === 0
              ? 'undefined — no video has both rendered and incurred a priced charge'
              : `over ${countable} video${countable === 1 ? '' : 's'} · ${
                  result.costPerVideoBasis === 'measured'
                    ? 'measured'
                    : result.costPerVideoBasis === 'mixed'
                      ? 'part measured, part rate card'
                      : 'from the rate card, not what the vendor charged'
                }`
          }
          emphasis
        />
        <Figure
          label="Measured"
          value={inr(result.measuredTotalInr)}
          sub="what the vendor charged, or a balance seen to move"
        />
        <Figure
          label="From rate card"
          value={inr(result.estimatedTotalInr)}
          sub="incurred, priced by us rather than by them"
        />
      </section>

      {countable === 0 && (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          {result.ledgerEmpty
            ? 'Nothing has cost anything yet. This is an empty ledger, not a free pipeline.'
            : 'There is spend on the ledger but no finished video to divide it by, so the ' +
              'per-video figure is undefined rather than zero. It becomes a number when a ' +
              'script has rendered and every call it made has a verified rate.'}
        </p>
      )}

      {/*
        Why nothing will settle, said once rather than inferred from every row.

        `denominator_state = nothing_settled` is honest about the row and silent about the
        fact that it is permanent: nothing writes a reconcile row against a generation, so a
        video that generates stays "in flight" for ever and can never become countable.
        This line is computed from the data — the day a reconcile row exists it stops
        appearing, without anyone remembering to remove it.
      */}
      {!observed.generation_settled.observed && countable > 0 && (
        <p
          className="mt-3 rounded-md border px-4 py-2 text-2xs"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
        >
          <span className="font-medium">This average is priced by us, not by the vendor.</span>{' '}
          {withheld('generation_settled').missingWriter} A completed generation is counted
          from its estimate rather than skipped — inventing a reconcile equal to the estimate
          would put a fabricated figure in the ledger everything derives from. The real one
          lands when a credit-balance delta is observable, the same way a rate is verified:
          by watching a balance move, not by reading a response body.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <h2 className="mt-8 mb-2 text-sm font-medium">Per video</h2>
          <div
            className="overflow-x-auto rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--text-faint)' }} className="text-left text-2xs">
                  <th className="px-4 py-2 font-normal">Concept</th>
                  <th className="px-4 py-2 text-right font-normal">Incurred</th>
                  <th className="px-4 py-2 text-right font-normal">Committed</th>
                  <th className="px-4 py-2 font-normal">Where it went</th>
                  <th className="px-4 py-2 text-right font-normal">Renders</th>
                  <th className="px-4 py-2 font-normal">Counted?</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.scriptId}
                    className="border-t"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <td className="px-4 py-2">{r.title}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {inr(r.measuredInr === null && r.estimatedInr === null
                        ? null
                        : (r.measuredInr ?? 0) + (r.estimatedInr ?? 0))}
                      {r.measuredRows === 0 && (r.estimatedInr ?? 0) > 0 && (
                        <span className="ml-1 text-2xs" style={{ color: 'var(--text-faint)' }}>
                          est
                        </span>
                      )}
                    </td>
                    <td
                      className="px-4 py-2 text-right font-mono"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {inr(r.committedInr)}
                    </td>
                    <td
                      className="px-4 py-2 font-mono text-2xs"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {Object.entries(r.componentInr)
                        .map(
                          ([k, v]) =>
                            `${k} ${v.inr === null ? '—' : `₹${Number(v.inr).toFixed(2)}`}`,
                        )
                        .join('  ·  ') || '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      {r.renders === 0 ? '—' : `${r.rendersReady}/${r.renders}`}
                    </td>
                    <td className="px-4 py-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
                      {EXCLUSION[r.denominatorState]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
            {excluded.notRendered + excluded.unpriced + excluded.nothingIncurred} of {rows.length}{' '}
            excluded from the average — {excluded.notRendered} not rendered, {excluded.unpriced}{' '}
            unpriced, {excluded.nothingIncurred} with nothing incurred. Excluded, and listed: an
            average whose denominator you cannot see is not a measurement.
          </p>
        </>
      )}

      {/*
        Cost by stage.
        The same inverse test as the page above it, one level down: a bar per stage looks
        identical after one video and after a hundred, so every row carries the number of
        scripts the stage charged and the per-script figure derived from it. A stage that has
        never run says so rather than showing ₹0 — "assembly is free" and "assembly has never
        been built" are different claims and only one is true here.
      */}
      <h2 className="mt-8 mb-2 text-sm font-medium">By stage</h2>
      {!stages.ok ? (
        <div
          className="rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--state-blocked)', background: 'var(--state-blocked-bg)' }}
        >
          <div>{stages.hint}</div>
          <div className="mt-1 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
            {stages.error}
          </div>
        </div>
      ) : (
        <>
          <div
            className="overflow-x-auto rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
          >
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--text-faint)' }} className="text-left text-2xs">
                  <th className="px-4 py-2 font-normal">Stage</th>
                  <th className="px-4 py-2 text-right font-normal">Incurred</th>
                  <th className="px-4 py-2 text-right font-normal">Committed</th>
                  <th className="px-4 py-2 text-right font-normal">Scripts</th>
                  <th className="px-4 py-2 text-right font-normal">Per script</th>
                  <th className="px-4 py-2 font-normal">What it buys</th>
                </tr>
              </thead>
              <tbody>
                {stages.rows.map((r) => (
                  <tr
                    key={r.stage}
                    className="border-t"
                    style={{ borderColor: 'var(--border-subtle)', opacity: r.hasRun ? 1 : 0.55 }}
                  >
                    <td className="px-4 py-2">
                      {r.label}{' '}
                      <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
                        {r.stage}
                      </span>
                    </td>
                    {r.hasRun ? (
                      <>
                        <td className="px-4 py-2 text-right font-mono">{inr(r.settledInr)}</td>
                        <td
                          className="px-4 py-2 text-right font-mono"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {inr(r.openEstimateInr)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono">{r.scripts}</td>
                        <td className="px-4 py-2 text-right font-mono">{inr(r.inrPerScript)}</td>
                      </>
                    ) : (
                      <td className="px-4 py-2 text-2xs" colSpan={4} style={{ color: 'var(--text-faint)' }}>
                        never run — not ₹0
                      </td>
                    )}
                    <td className="px-4 py-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
                      {r.what}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
            {stages.stagesRun} of {stages.rows.length} charging stages have ever written a ledger
            row. A per-script figure is undefined for a stage that has charged no script, and is
            shown as an em dash rather than as zero.
          </p>
        </>
      )}

      {unattributed.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-sm font-medium">
            <Hint content="A Studio session that decided not to make anything, a draft the model refused, a stage-2 batch charged to the channel. Real money, and not part of any video's cost — a cost-per-video figure is only honest alongside what it excludes.">
              Spend that belongs to no video
            </Hint>
          </h2>
          <div
            className="overflow-x-auto rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
          >
            <table className="w-full text-sm">
              <tbody>
                {unattributed.map((u) => (
                  <tr
                    key={`${u.component}-${u.entryKind}`}
                    className="border-b last:border-b-0"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <td className="px-4 py-2">{u.component}</td>
                    <td className="px-4 py-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
                      {u.entryKind}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{inr(u.inr)}</td>
                    <td
                      className="px-4 py-2 text-right text-2xs"
                      style={{ color: 'var(--text-faint)' }}
                    >
                      {u.rowsN} row{u.rowsN === 1 ? '' : 's'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-medium tracking-tight">Costs</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
        Per video, from the cost ledger. The average is shown with the number of videos it was
        divided by, because a total looks the same after one video and after a hundred.
      </p>
    </header>
  );
}

function Figure({
  label,
  value,
  sub,
  emphasis = false,
}: {
  label: string;
  value: string;
  sub: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="rounded-md border px-4 py-3"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
    >
      <div className="text-2xs" style={{ color: 'var(--text-faint)' }}>
        {label}
      </div>
      <div className={`mt-1 font-mono ${emphasis ? 'text-2xl' : 'text-lg'}`}>{value}</div>
      <div className="mt-1 text-2xs" style={{ color: 'var(--text-muted)' }}>
        {sub}
      </div>
    </div>
  );
}

/**
 * What is true today, said plainly, rather than a page that looks broken until the first
 * real generation lands.
 */
function EmptyState() {
  return (
    <div
      className="mt-8 rounded-md border px-5 py-5 text-sm"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
    >
      <div className="font-medium">No video has cost anything yet.</div>
      <p className="mt-2 max-w-[70ch]" style={{ color: 'var(--text-muted)' }}>
        Two stages have ever run against a real vendor — drafting and shotlist compilation,
        both Anthropic calls on a single script. Nothing has been generated, rendered or
        published, so there is no video for a per-video figure to be about.
      </p>
      <p className="mt-2 max-w-[70ch]" style={{ color: 'var(--text-muted)' }}>
        A row appears here the moment any spend attaches to a script. It becomes countable
        towards the average once that script has a ready render and every call it made has a
        verified rate — an unverified rate leaves the video&apos;s cost unknown, which is not
        the same as cheap.
      </p>
      <p className="mt-3 text-2xs" style={{ color: 'var(--text-faint)' }}>
        <Link href="/settings/rate-card" className="underline">
          Settings → Rate card
        </Link>{' '}
        is where an observed rate gets recorded.
      </p>
    </div>
  );
}
