import { VideoRow } from '@/components/pipeline/video-row';
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
 * Calm density: answer "is everything okay?" first, and let everything else wait a layer
 * down. The summary strip at the top is that answer — two videos want a human, one is
 * moving, everything else is finished. Sorted so the things needing attention are at the
 * top and the archive is at the bottom.
 *
 * Fixture data, no database. Gate 1 is judging whether this reads as templated.
 */

function Summary() {
  const counts = STATE_ORDER.map((state) => ({
    state,
    n: VIDEOS.filter((v) => v.state === state).length,
  })).filter((c) => c.n > 0);

  const priced = VIDEOS.filter((v) => v.cost.kind === 'priced');
  const total = priced.reduce((sum, v) => sum + (v.cost.kind === 'priced' ? v.cost.inr : 0), 0);
  const unpriced = VIDEOS.length - priced.length;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
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
          The count of videos whose cost we genuinely cannot state. Kept next to the
          total rather than hidden, because a total that silently excludes rows is the
          kind of number that gets quoted.
        */}
        {unpriced > 0 && (
          <span style={{ color: 'var(--text-faint)' }}>· {unpriced} unpriced</span>
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
        className="flex items-center gap-3 border-b px-5"
        style={{ height: 'var(--topbar-height)', borderColor: 'var(--border-subtle)' }}
      >
        <h1 className="text-[14px] font-medium tracking-tight">Pipeline</h1>
        <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {needsHuman > 0
            ? `${needsHuman} waiting on you`
            : 'Nothing waiting on you'}
        </span>
        <span
          className="ml-auto rounded-sm px-2 py-1 font-mono text-[10px]"
          style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
          title="This screen is rendered from fixtures. No database is connected yet."
        >
          fixture data
        </span>
      </header>

      <div className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <Summary />
      </div>

      {/* ── Column headers ───────────────────────────────────────────────── */}
      <div
        className="grid gap-4 border-b px-5 py-2 font-mono text-[10px] uppercase tracking-[0.09em]"
        style={{
          gridTemplateColumns: 'minmax(0, 1fr) 128px 96px 108px',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-faint)',
          background: 'var(--surface-inset)',
        }}
      >
        <span>Video</span>
        <span>State</span>
        <span>Shape</span>
        <span className="text-right">Cost</span>
      </div>

      <div>
        {sorted.map((video) => (
          <VideoRow key={video.id} video={video} />
        ))}
      </div>

      {/*
        Empty-state affordance, shown permanently at the foot of the board rather than
        only when the list is empty. A palette nobody discovers is a palette nobody uses,
        and this is the second place the shortcut is stated — the first is the sidebar.
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
