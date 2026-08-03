import Link from 'next/link';
import { Suspense } from 'react';

import { IntegrityAlert } from '@/components/pipeline/integrity-alert';
import { Hint } from '@/components/shell/hint';
import { StateGlyph } from '@/components/shell/state-glyph';
import type { VideoState } from '@/lib/fixtures/pipeline';
import { deferralState, inertBecause } from '@/lib/onboarding/deferred';
import { readBoard, type BoardRow, type ConceptState } from '@/lib/pipeline/board';

/**
 * The pipeline board — from the database.
 *
 * Calm density: answer "is everything okay?" first, let everything else wait a layer down.
 * Sorted so what needs a human is at the top.
 *
 * ── Three outcomes, never two ────────────────────────────────────────────────
 *
 * Rows, empty, or broken. The distinction between the last two is why this was rewritten
 * off fixtures rather than merely pointed at a different source: a blank board that could
 * mean "no concepts yet" or "the query failed" makes the second case invisible until
 * somebody independently suspects it. The empty state says what would put something here
 * and names anything deferred that will stop it; the broken state says what failed.
 *
 * `src/lib/fixtures/pipeline.ts` stays — `/studio` and the design-system screens render it
 * and it is Gate 1's artefact. Nothing here reads it except the glyph's state vocabulary,
 * which is a design-system type rather than data.
 */

const MAX_W = 'mx-auto w-full max-w-[1400px]';

const STATE_LABEL: Record<ConceptState, string> = {
  draft: 'Draft',
  scripted: 'Scripted',
  shot_listed: 'Shot-listed',
  generating: 'Generating',
  needs_review: 'Needs review',
  blocked: 'Blocked',
  stalled: 'Stalled',
  ready: 'Ready',
  published: 'Published',
};

/**
 * Pipeline states are finer-grained than the glyph's vocabulary, on purpose: "scripted"
 * and "shot-listed" are different places to be and the same colour of dot. The mapping
 * lives here rather than widening the design system for a distinction only this screen
 * makes.
 */
const GLYPH: Record<ConceptState, VideoState> = {
  draft: 'drafting',
  scripted: 'drafting',
  shot_listed: 'drafting',
  generating: 'generating',
  needs_review: 'needs_review',
  blocked: 'blocked',
  // The same glyph as blocked, and that is deliberate. To the eye scanning for "is
  // everything okay?", stalled and blocked are the same answer — something needs you. The
  // *label* and the reason underneath are where they differ, because what you do about them
  // differs: blocked means read the error, stalled means fix the named configuration.
  stalled: 'blocked',
  ready: 'ready',
  published: 'live',
};

// Attention first, archive last.
const STATE_ORDER: ConceptState[] = [
  'blocked',
  // Second, above needs_review. A stalled concept is not waiting for a decision — it is
  // waiting for something nobody has been told about, and it will wait for ever.
  'stalled',
  'needs_review',
  'generating',
  'shot_listed',
  'scripted',
  'draft',
  'ready',
  'published',
];

const GRID = '1fr 130px 150px 120px';

function formatInr(n: number): string {
  return `₹${n.toFixed(2)}`;
}

function Row({ row }: { row: BoardRow }) {
  return (
    <Link
      href={`/concepts/${row.id}`}
      className="grid items-center gap-5 border-b px-5 py-3 transition-colors"
      style={{
        gridTemplateColumns: GRID,
        borderColor: 'var(--border-subtle)',
        transitionDuration: 'var(--duration-fast)',
      }}
    >
      <span className="truncate text-sm">{row.title}</span>

      <span
        className="flex items-center gap-2 text-xs"
        style={{ color: 'var(--text-secondary)' }}
      >
        <StateGlyph state={GLYPH[row.state]} size={8} />
        {/* The reason, on the row, not behind a click. A stalled concept is one whose
            problem is invisible by construction — putting the explanation one interaction
            away would preserve exactly the silence this state exists to break. */}
        {row.blocker ? (
          <Hint content={row.blocker}>
            <span style={{ borderBottom: '1px dotted var(--border-strong)' }}>
              {STATE_LABEL[row.state]}
            </span>
          </Hint>
        ) : (
          STATE_LABEL[row.state]
        )}
      </span>

      <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
        {row.scripts} script · {row.shots} shot · {row.generations} gen
      </span>

      <span className="text-right font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
        {row.costInr === null ? (
          <Hint content="No priced call has been recorded against this concept. Not zero — unknown. A submit that cannot be priced refuses rather than proceeding uncosted.">
            <span style={{ color: 'var(--text-faint)' }}>—</span>
          </Hint>
        ) : (
          <>
            {formatInr(row.costInr)}
            {row.unpricedCalls > 0 && (
              <Hint content="Some calls against this concept could not be priced, so this total is knowingly incomplete rather than wrong.">
                <span style={{ color: 'var(--text-faint)' }}> ·{row.unpricedCalls}?</span>
              </Hint>
            )}
          </>
        )}
      </span>
    </Link>
  );
}

async function Board() {
  const [result, deferrals] = await Promise.all([readBoard(), deferralState()]);

  if (!result.ok) {
    return (
      <div className={`${MAX_W} px-5 py-10`}>
        <div
          className="rounded-sm border px-4 py-3 text-sm leading-relaxed"
          style={{
            borderColor: 'var(--border-strong)',
            background: 'var(--surface-inset)',
            color: 'var(--state-review)',
          }}
          data-board="error"
        >
          <strong className="font-medium">This board could not be read.</strong>
          <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
            {result.hint}
          </p>
          <p className="mt-2 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
            {result.error}
          </p>
          <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
            This is <em>not</em> an empty database — that renders a different message saying
            so. If you are seeing this, the read itself failed.
          </p>
        </div>
      </div>
    );
  }

  if (result.rows.length === 0) {
    const videoInert = inertBecause(deferrals, 'video');
    const audioInert = inertBecause(deferrals, 'audio');

    return (
      <div className={`${MAX_W} px-5 py-10`} data-board="empty">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          No concepts yet. The database is reachable and this query succeeded — there is
          simply nothing in it.
        </p>
        <p
          className="mt-2 max-w-[62ch] text-sm leading-relaxed"
          style={{ color: 'var(--text-muted)' }}
        >
          A concept appears here as soon as one exists. Stage 3 gives it a script, stage 4 a
          shotlist, stage 5 generations — each moves the row up this list without anything
          else being done to it.
        </p>

        {(videoInert || audioInert) && (
          <div
            className="mt-5 max-w-[62ch] rounded-sm border px-3 py-2 text-xs leading-relaxed"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--surface-inset)',
              color: 'var(--text-muted)',
            }}
          >
            <strong className="font-medium" style={{ color: 'var(--state-review)' }}>
              Some of that will not happen yet.
            </strong>
            {videoInert && <p className="mt-1">{videoInert}</p>}
            {audioInert && <p className="mt-1">{audioInert}</p>}
          </div>
        )}
      </div>
    );
  }

  const sorted = [...result.rows].sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state),
  );

  const priced = result.rows.filter((r) => r.costInr !== null);
  const total = priced.reduce((sum, r) => sum + (r.costInr ?? 0), 0);
  const unpriced = result.rows.length - priced.length;

  return (
    <>
      <div className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className={`${MAX_W} flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4`}>
          {STATE_ORDER.map((state) => ({
            state,
            n: result.rows.filter((r) => r.state === state).length,
          }))
            .filter((c) => c.n > 0)
            .map(({ state, n }) => (
              <div key={state} className="flex items-center gap-2">
                <StateGlyph state={GLYPH[state]} size={8} />
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {n} {STATE_LABEL[state].toLowerCase()}
                </span>
              </div>
            ))}

          <div
            className="ml-auto flex items-baseline gap-2 font-mono text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            <span style={{ color: 'var(--text-primary)' }}>{formatInr(total)}</span>
            <span>across {priced.length}</span>
            {unpriced > 0 && (
              <Hint content="These have no priced call recorded, so their cost is genuinely unknown — not zero. A total that silently excludes rows is the kind of number that gets quoted.">
                <span style={{ color: 'var(--text-faint)' }}>· {unpriced} unpriced</span>
              </Hint>
            )}
          </div>
        </div>
      </div>

      <div style={{ background: 'var(--surface-inset)' }}>
        <div
          className={`${MAX_W} grid gap-5 border-b px-5 py-2 font-mono text-3xs uppercase tracking-[0.09em]`}
          style={{
            gridTemplateColumns: GRID,
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-faint)',
          }}
        >
          <span>Concept</span>
          <span>State</span>
          <span>Rows</span>
          <span className="text-right">Cost</span>
        </div>
      </div>

      <div className={MAX_W}>
        {sorted.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </div>
    </>
  );
}

export default function PipelineBoard() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div
          className={`${MAX_W} flex items-center gap-3 px-5`}
          style={{ height: 'var(--topbar-height)' }}
        >
          <h1 className="text-md font-medium tracking-tight">Pipeline</h1>

          {/* Nothing at all when both integrity counts are zero, which is every ordinary
              day. See the component for the third state. */}
          <Suspense fallback={null}>
            <IntegrityAlert />
          </Suspense>

          <div className="ml-auto flex items-center gap-3">
            <Link
              href="/concepts"
              className="rounded-sm px-[10px] py-[6px] text-xs font-medium transition-colors"
              style={{
                background: 'var(--accent)',
                color: 'var(--accent-contrast)',
                transitionDuration: 'var(--duration-fast)',
              }}
            >
              New concept
            </Link>
          </div>
        </div>
      </header>

      {/* Suspended so a slow database delays the rows rather than the shell — the top bar
          and the deferral banner stay legible while this resolves. */}
      <Suspense
        fallback={
          <div
            className={`${MAX_W} px-5 py-10 text-sm`}
            style={{ color: 'var(--text-faint)' }}
          >
            Reading the pipeline…
          </div>
        }
      >
        <Board />
      </Suspense>
    </div>
  );
}

// Read on every request. A cached board shows a generation as queued after it finished.
export const dynamic = 'force-dynamic';
