'use client';

import { Hint } from '@/components/shell/hint';
import { StateGlyph, stateColorToken } from '@/components/shell/state-glyph';
import { STATE_LABEL, formatInr, type PipelineVideo } from '@/lib/fixtures/pipeline';

/**
 * One video on the board.
 *
 * Column widths are fixed and the whole grid is capped, so the right-hand cluster sits
 * just past the title rather than being flung to the far edge. At 1440px the previous
 * layout left a dead zone of several hundred pixels between a mostly-empty title column
 * and three crushed ones — the title had room it did not use and the numbers had none.
 */

function CostCell({ video }: { video: PipelineVideo }) {
  if (video.cost.kind === 'priced') {
    return (
      <div className="text-right">
        <div className="font-mono text-[13px]" style={{ color: 'var(--text-primary)' }}>
          {formatInr(video.cost.inr)}
        </div>
        {video.shots > 0 && (
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
            {formatInr(Math.round(video.cost.inr / video.shots))}/shot
          </div>
        )}
      </div>
    );
  }

  /*
   * Unpriced.
   *
   * Not ₹0, and not a dash. The rate card has no verified entry for what this video used,
   * so the honest answer is that the cost is unknown — and it names the missing rate,
   * because that is the thing someone has to go and fix. A zero would be believed,
   * summed, and put in a business case.
   */
  return (
    <div className="text-right">
      <Hint content={`Unpriced — ${video.cost.reason}. Verify the rate in Settings → Rate card.`}>
        <span className="font-mono text-[13px]" style={{ color: 'var(--text-faint)' }}>
          unpriced
        </span>
      </Hint>
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
        {video.cost.generations > 0
          ? `${video.cost.generations} gen${video.cost.generations === 1 ? '' : 's'}, no rate`
          : 'nothing spent'}
      </div>
    </div>
  );
}

export const ROW_GRID = 'minmax(0, 1fr) 132px 92px 112px';

export function VideoRow({ video, selected }: { video: PipelineVideo; selected?: boolean }) {
  const tint = stateColorToken(video.state);

  return (
    <div
      className="group grid items-center gap-5 border-b px-5 py-3 transition-colors"
      style={{
        gridTemplateColumns: ROW_GRID,
        borderColor: 'var(--border-subtle)',
        transitionDuration: 'var(--duration-fast)',
        // The accent's job on this screen: it marks where you are. Status hues say what
        // a row *is*; the accent says which one you are acting on. Keeping those two
        // meanings separate is what stops the palette becoming decoration.
        background: selected ? 'var(--surface-1)' : undefined,
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined,
      }}
    >
      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 items-start gap-3">
        {/* Fixed-width gutter: the glyphs differ in intrinsic width (an 11px svg vs a
            9px span), and without this the titles fail to line up by a couple of pixels
            — the kind of thing that reads as sloppy without being consciously noticed. */}
        <span className="mt-[6px] flex w-3 shrink-0 justify-center">
          <StateGlyph state={video.state} />
        </span>

        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px]" style={{ color: 'var(--text-primary)' }}>
              {video.title}
            </span>

            {video.origin === 'studio' && (
              <Hint content="Made in the Studio lane — the turn-by-turn transcript is the editorial record for an appeal.">
                <span
                  className="shrink-0 rounded-xs px-1 font-mono text-[9.5px] uppercase tracking-wide"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
                >
                  studio
                </span>
              </Hint>
            )}

            {/* Length folded under the title rather than given its own column. It is
                shape-of-the-thing, not a number anyone sorts by. */}
            {video.shots > 0 && (
              <span
                className="shrink-0 font-mono text-[10.5px]"
                style={{ color: 'var(--text-faint)' }}
              >
                {video.shots} shots · {video.durationS}s
              </span>
            )}
          </div>

          {/* Second line changes by state: the angle normally, the real step while
              generating, the reason when something is wrong. */}
          {video.state === 'generating' && video.progress ? (
            <div className="mt-[3px] flex items-center gap-2">
              <span className="font-mono text-[11.5px]" style={{ color: tint }}>
                {video.progress.step} {video.progress.current} of {video.progress.total}
              </span>
              <span className="flex gap-[3px]" aria-hidden>
                {Array.from({ length: video.progress.total }).map((_, i) => (
                  <span
                    key={i}
                    className="h-[3px] w-3 rounded-full"
                    style={{
                      background: i < video.progress!.current ? tint : 'var(--surface-3)',
                    }}
                  />
                ))}
              </span>
            </div>
          ) : video.detail ? (
            <div
              className="mt-[3px] truncate text-[11.5px]"
              style={{ color: video.state === 'blocked' ? tint : 'var(--text-faint)' }}
            >
              {video.detail}
            </div>
          ) : (
            <div className="mt-[3px] truncate text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              {video.angle || 'No angle yet'}
            </div>
          )}
        </div>
      </div>

      {/* ── State ────────────────────────────────────────────────────────── */}
      <div className="text-[12px]" style={{ color: tint }}>
        {STATE_LABEL[video.state]}
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
          {video.updatedAgo}
        </div>
      </div>

      {/* ── Action ───────────────────────────────────────────────────────── */}
      {/* The accent's second job. Exactly one row on the board carries a primary action
          at a time — the one that most wants a human. Everything else stays chrome. */}
      <div>
        {video.state === 'needs_review' ? (
          <button
            type="button"
            className="rounded-sm px-2 py-[5px] text-[11.5px] font-medium transition-colors"
            style={{
              background: 'var(--accent)',
              color: 'var(--accent-contrast)',
              transitionDuration: 'var(--duration-fast)',
            }}
          >
            Review
          </button>
        ) : video.state === 'blocked' ? (
          <button
            type="button"
            className="rounded-sm border px-2 py-[5px] text-[11.5px] transition-colors"
            style={{
              borderColor: 'var(--border-strong)',
              color: 'var(--text-secondary)',
              transitionDuration: 'var(--duration-fast)',
            }}
          >
            Resolve
          </button>
        ) : null}
      </div>

      {/* ── Cost ─────────────────────────────────────────────────────────── */}
      <CostCell video={video} />
    </div>
  );
}
