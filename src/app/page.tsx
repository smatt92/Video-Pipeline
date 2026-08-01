import { ROW_GRID, VideoRow } from '@/components/pipeline/video-row';
import { Hint } from '@/components/shell/hint';
import { StateGlyph } from '@/components/shell/state-glyph';
import {
  STATE_LABEL,
  STATE_ORDER,
  VIDEOS,
  formatInr,
  type VideoState,
} from '@/lib/fixtures/pipeline';

/**
 * The pipeline board.
 *
 * Calm density: answer "is everything okay?" first, let everything else wait a layer
 * down. The summary strip is that answer. Sorted so what needs a human is at the top and
 * the archive is at the bottom.
 *
 * Content is capped at 1400px and centred. Past that width the title column grows into
 * space it has no use for while the numbers stay pinned to the far edge, and the eye has
 * to cross a dead zone to connect a row to its cost.
 *
 * Fixture data, no database. Gate 1.
 */

const MAX_W = 'mx-auto w-full max-w-[1400px]';

function Summary() {
  const counts = STATE_ORDER.map((state) => ({
    state,
    n: VIDEOS.filter((v) => v.state === state).length,
  })).filter((c) => c.n > 0);

  const priced = VIDEOS.filter((v) => v.cost.kind === 'priced');
  const total = priced.reduce((sum, v) => sum + (v.cost.kind === 'priced' ? v.cost.inr : 0), 0);
  const unpriced = VIDEOS.length - priced.length;

  return (
    <div className={`${MAX_W} flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4`}>
      {counts.map(({ state, n }) => (
        <div key={state} className="flex items-center gap-2">
          <StateGlyph state={state} size={8} />
          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {n} {STATE_LABEL[state].toLowerCase()}
          </span>
        </div>
      ))}

      <div
        className="ml-auto flex items-baseline gap-2 font-mono text-[12px]"
        style={{ color: 'var(--text-muted)' }}
      >
        <span style={{ color: 'var(--text-primary)' }}>{formatInr(total)}</span>
        <span>across {priced.length}</span>
        {/*
          The count of videos whose cost cannot be stated. Kept beside the total rather
          than hidden, because a total that silently excludes rows is the kind of number
          that gets quoted.
        */}
        {unpriced > 0 && (
          <Hint content="These used a model with no verified rate on the rate card, so their cost is genuinely unknown — not zero. Verify the rate in Settings.">
            <span style={{ color: 'var(--text-faint)' }}>· {unpriced} unpriced</span>
          </Hint>
        )}
      </div>
    </div>
  );
}

export default function PipelineBoard() {
  const sorted = [...VIDEOS].sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state),
  );

  const needsHuman = VIDEOS.filter(
    (v) => v.state === 'blocked' || v.state === 'needs_review',
  ).length;

  return (
    <div className="flex min-h-full flex-col">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header
        className="border-b"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div
          className={`${MAX_W} flex items-center gap-3 px-5`}
          style={{ height: 'var(--topbar-height)' }}
        >
          <h1 className="text-[14px] font-medium tracking-tight">Pipeline</h1>
          <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
            {needsHuman > 0 ? `${needsHuman} waiting on you` : 'Nothing waiting on you'}
          </span>

          <div className="ml-auto flex items-center gap-3">
            <Hint content="Every row on this screen is fixture data. No database is connected yet — that lands in phase 1c.">
              <span
                className="rounded-sm px-2 py-1 font-mono text-[10px]"
                style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
              >
                fixture data
              </span>
            </Hint>

            {/* Primary action — the accent's most visible job, and the reason a swap is
                actually testable rather than theoretical. */}
            <button
              type="button"
              className="rounded-sm px-[10px] py-[6px] text-[12px] font-medium transition-colors"
              style={{
                background: 'var(--accent)',
                color: 'var(--accent-contrast)',
                transitionDuration: 'var(--duration-fast)',
              }}
            >
              New concept
            </button>
          </div>
        </div>
      </header>

      <div className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <Summary />
      </div>

      {/* ── Column headers ───────────────────────────────────────────────── */}
      <div style={{ background: 'var(--surface-inset)' }}>
        <div
          className={`${MAX_W} grid gap-5 border-b px-5 py-2 font-mono text-[10px] uppercase tracking-[0.09em]`}
          style={{
            gridTemplateColumns: ROW_GRID,
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-faint)',
          }}
        >
          <span>Video</span>
          <span>State</span>
          <span />
          <span className="text-right">Cost</span>
        </div>
      </div>

      <div className={MAX_W}>
        {sorted.map((video) => (
          <VideoRow
            key={video.id}
            video={video}
            // One row is selected to show what the accent does. In 1c this follows the
            // keyboard cursor — the review loop is meant to be driven without a mouse.
            selected={video.id === 'v_3c71'}
          />
        ))}
      </div>

      {/*
        The single ⌘K affordance. The sidebar search field was a second one for the same
        thing, and a fake input that opens a dialog is worse than no input — the palette
        IS the search.
      */}
      <div className="flex flex-1 items-end justify-center pb-8 pt-10">
        <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          Press{' '}
          <kbd
            className="rounded-xs px-1 font-mono text-[10px]"
            style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
          >
            ⌘K
          </kbd>{' '}
          to jump anywhere
        </p>
      </div>
    </div>
  );
}

export const dynamic = 'force-static';
export type { VideoState };
