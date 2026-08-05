import { SnapshotForm } from '@/components/measure/snapshot-form';
import { HEADLINE_BUCKET, readMeasureBoard } from '@/lib/measure/read';

/**
 * Analytics — stage 11. What the videos actually did, and what has not been looked at.
 *
 * ── The trap this screen was designed against, before it was written ─────────
 *
 * The operator's spec for this stage put the inverse test first: **a metrics screen that
 * looks the same after one video and after a hundred.** This project has found that shape
 * four times already — the costs page, the trends list, the review queue, the Studio list —
 * plus three silent `.limit()` caps.
 *
 * So the top of this page is not a headline retention figure. It is the denominator: how
 * many videos are live, how many measurement points their ages have made due, and how many
 * of those have actually been read. Every derived number below is printed with the count it
 * was computed over. A page whose first number is a count of rows cannot render identically
 * at two scales.
 *
 * ── And the rollup's own blind spot, on the same screen ──────────────────────
 *
 * `v_hook_performance` groups on `hook_pattern`, so a video whose hook was never classified
 * is absent from *every* row rather than under-counted in one — the rollup reads as
 * complete however many are missing. `v_hook_unclassified` is the view that reads that
 * silence back, and this page is what reads the view. A view with no caller is the original
 * problem wearing the costume of its solution.
 *
 * ── What it renders today ───────────────────────────────────────────────────
 *
 * Nothing, and it says so in those words. No video has been published, so nothing is due,
 * so every rate here is undefined rather than zero. "0% measured" would accuse an operator
 * of neglecting work that does not exist yet.
 */

const MAX_W = 'mx-auto w-full max-w-[1400px]';

const pct = (v: number | null, digits = 0) => (v === null ? '—' : `${v.toFixed(digits)}%`);
const inr = (v: number | null) => (v === null ? '—' : `₹${v.toFixed(2)}`);

const WHY_NO_FIGURE: Record<string, string> = {
  not_measured: 'not measured yet',
  no_views_yet: 'no views yet — undefined, not zero',
  cost_unknown: 'cost unknown — a contributing call has no verified rate',
  countable: '',
};

export default async function AnalyticsPage() {
  const board = await readMeasureBoard();

  const totalDue = board.coverage.reduce((n, c) => n + c.due, 0);
  const totalCaptured = board.coverage.reduce((n, c) => n + c.captured, 0);
  const totalOutstanding = board.coverage.reduce((n, c) => n + c.outstanding, 0);
  const totalUnavailable = board.coverage.reduce((n, c) => n + c.unavailable, 0);

  // Undefined, not zero. There is no denominator until something is due, and a rate over an
  // empty set is not 0% — it is a question nobody has been able to ask yet.
  const capturedShare = totalDue === 0 ? null : (totalCaptured / totalDue) * 100;

  const outstanding = board.due.filter((d) => d.coverageState === 'outstanding');

  return (
    <main className={`${MAX_W} px-6 py-8`}>
      <header>
        <h1 className="text-lg font-medium">Analytics</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Stage 11. 3-second retention is the hook metric; everything else is secondary.
          Figures are typed from the platform&rsquo;s own dashboard — Phase 1 has no
          analytics credential — and every row records that it was.
        </p>
      </header>

      {board.unreadable.length > 0 && (
        <div
          className="mt-6 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--state-blocked)', background: 'var(--state-blocked-bg)' }}
        >
          <div className="font-medium">Part of this screen could not be read.</div>
          <p className="mt-1" style={{ color: 'var(--text-muted)' }}>
            This is a failed read, not an empty result. Usually migration 0034 has not been
            applied — run <code className="font-mono">pnpm db:doctor</code>.
          </p>
          <ul className="mt-2 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
            {board.unreadable.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {/* The denominator, first and largest. See the note at the top of this file. */}
      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        <Figure label="Live videos" value={String(board.publicationsLive)} emphasis />
        <Figure
          label="Measurements due"
          value={String(totalDue)}
          sub="one per (video, age bucket) whose clock has passed"
        />
        <Figure
          label="Read"
          value={totalDue === 0 ? '—' : `${totalCaptured} / ${totalDue}`}
          sub={
            capturedShare === null
              ? 'undefined — nothing is due yet'
              : `${capturedShare.toFixed(0)}% · ${totalUnavailable} unavailable`
          }
        />
        <Figure
          label="Outstanding"
          value={String(totalOutstanding)}
          sub="old enough to read, and read by nobody"
        />
      </section>

      {board.publicationsLive === 0 && (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          No video has been published, so nothing is due and every rate on this page is
          undefined rather than zero. It becomes a number the first time a publication goes
          live and its six-hour mark passes.
        </p>
      )}

      {/* ── What has not been read ──────────────────────────────────────────── */}
      {outstanding.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium">Outstanding — {outstanding.length} to read</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Leave a field blank when the platform withholds it. A blank stays blank; a typed
            0 is a measurement, and there is no way to tell the two apart afterwards.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {outstanding.map((row) => (
              <SnapshotForm key={`${row.publicationId}-${row.ageBucket}`} row={row} />
            ))}
          </div>
        </section>
      )}

      {/* ── Hooks, which is the point of the stage ──────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">Hook shapes at {HEADLINE_BUCKET}</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Grouped by the shape of the hook rather than its words, because every hook is
          unique and grouping on the text scores one video per group.
        </p>

        {board.unclassifiedHooks > 0 && (
          <p className="mt-2 text-xs" style={{ color: 'var(--state-warn)' }}>
            {board.unclassifiedHooks} live video
            {board.unclassifiedHooks === 1 ? '' : 's'} contribute to no row below — their
            hook has no pattern, so this table is complete about a narrower set than the one
            above.{' '}
            {board.neverClassifiedHooks > 0
              ? `${board.neverClassifiedHooks} were never classified at all, which is a backfill rather than a taxonomy gap.`
              : 'All of them were classified and matched nothing, which is a taxonomy gap rather than a backfill.'}
          </p>
        )}

        {board.hooks.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            Nothing measured yet. This is an empty table, not a finding about hooks.
          </p>
        ) : (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-faint)' }}>
                <Th>Shape</Th>
                <Th>Videos</Th>
                <Th>With retention</Th>
                <Th>Median 3s</Th>
                <Th>Worst</Th>
                <Th>Best</Th>
                <Th>Median views</Th>
              </tr>
            </thead>
            <tbody>
              {board.hooks.map((h) => (
                <tr
                  key={h.hookPattern}
                  className="border-t"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <Td>{h.hookPattern.replace(/_/g, ' ')}</Td>
                  <Td>{h.videosMeasured}</Td>
                  {/*
                    Printed beside the median it was computed over, always. A median of one
                    video is not a property of a hook shape, and the two counts differ
                    whenever a platform withheld retention — which is most of the time at
                    low view counts.
                  */}
                  <Td>{h.videosWithRetention}</Td>
                  <Td>{pct(h.medianRetention3sPct, 1)}</Td>
                  <Td>{pct(h.worstRetention3sPct, 1)}</Td>
                  <Td>{pct(h.bestRetention3sPct, 1)}</Td>
                  <Td>{h.medianViews === null ? '—' : h.medianViews.toLocaleString('en-IN')}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── The business question ───────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">Cost per 1,000 views at {HEADLINE_BUCKET}</h2>
        {board.costPerK.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            No live video has a {HEADLINE_BUCKET} snapshot yet.
          </p>
        ) : (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-faint)' }}>
                <Th>Video</Th>
                <Th>Views</Th>
                <Th>Per 1k</Th>
                <Th>Basis</Th>
              </tr>
            </thead>
            <tbody>
              {board.costPerK.map((r) => (
                <tr
                  key={r.publicationId}
                  className="border-t"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <Td>{r.title}</Td>
                  <Td>{r.views === null ? '—' : r.views.toLocaleString('en-IN')}</Td>
                  <Td>{inr(r.costPer1kInr)}</Td>
                  {/*
                    Why there is no number, when there is none — four reasons a bare dash
                    cannot tell apart, each needing a different response: wait, look again,
                    fix the rate card, or nothing is wrong.
                  */}
                  <Td>
                    {r.state === 'countable'
                      ? r.costBasis === 'measured'
                        ? 'measured'
                        : r.costBasis === 'mixed'
                          ? 'part measured, part rate card'
                          : 'from the rate card'
                      : WHY_NO_FIGURE[r.state]}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function Figure({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="rounded-md border px-4 py-3"
      style={{
        borderColor: emphasis ? 'var(--border-strong)' : 'var(--border-subtle)',
        background: 'var(--surface-1)',
      }}
    >
      <div className="text-2xs uppercase" style={{ color: 'var(--text-faint)' }}>
        {label}
      </div>
      <div className={emphasis ? 'mt-1 text-xl' : 'mt-1 text-lg'}>{value}</div>
      {sub && (
        <div className="mt-1 text-2xs" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-1 text-left text-2xs font-normal uppercase">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-1 font-mono text-2xs">{children}</td>;
}
