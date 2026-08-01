import { StateGlyph, stateColorToken } from '@/components/shell/state-glyph';
import { STATE_LABEL, formatInr, type PipelineVideo } from '@/lib/fixtures/pipeline';

/**
 * One video on the board.
 *
 * The row answers "is this okay?" in the first 200px and "what exactly?" in the rest.
 * Everything secondary is muted hard, so a scan down the left edge reads as a column of
 * glyphs rather than a wall of text.
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
   * so the honest answer is that the cost is unknown — and it says which rate is missing,
   * because that is the thing someone has to go and fix. A zero here would be believed,
   * summed, and put in a business case.
   */
  return (
    <div className="text-right">
      <div
        className="font-mono text-[13px]"
        style={{ color: 'var(--text-faint)' }}
        title={`Unpriced — ${video.cost.reason}`}
      >
        unpriced
      </div>
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
        {video.cost.generations > 0
          ? `${video.cost.generations} gen${video.cost.generations === 1 ? '' : 's'}, no rate`
          : 'nothing spent'}
      </div>
    </div>
  );
}

export function VideoRow({ video }: { video: PipelineVideo }) {
  const tint = stateColorToken(video.state);

  return (
    <div
      className="group grid items-center gap-4 border-b px-5 py-3 transition-colors"
      style={{
        gridTemplateColumns: 'minmax(0, 1fr) 128px 96px 108px',
        borderColor: 'var(--border-subtle)',
        transitionDuration: 'var(--duration-fast)',
      }}
    >
      {/* ── Identity ─────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 items-start gap-3">
        {/* Fixed-width gutter: the glyphs differ in intrinsic width (an 11px svg vs a
            9px span), and without this the titles fail to line up by a couple of pixels
            — which is exactly the kind of thing that reads as sloppy without being
            consciously noticed. */}
        <span className="mt-[6px] flex w-3 shrink-0 justify-center">
          <StateGlyph state={video.state} />
        </span>

        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px]" style={{ color: 'var(--text-primary)' }}>
              {video.title}
            </span>
            {video.origin === 'studio' && (
              <span
                className="shrink-0 rounded-xs px-1 font-mono text-[9.5px] uppercase tracking-wide"
                style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
                title="Made in the Studio lane — the transcript is the editorial record"
              >
                studio
              </span>
            )}
          </div>

          {/* Second line is the one that changes by state: the angle normally, the real
              step while generating, the reason when something is wrong. */}
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
                      background:
                        i < video.progress!.current ? tint : 'var(--surface-3)',
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

      {/* ── Shape ────────────────────────────────────────────────────────── */}
      <div className="font-mono text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        {video.shots > 0 ? (
          <>
            {video.shots} shots
            <div className="text-[10px]" style={{ color: 'var(--text-faint)' }}>
              {video.durationS}s
            </div>
          </>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>—</span>
        )}
      </div>

      {/* ── Cost ─────────────────────────────────────────────────────────── */}
      <CostCell video={video} />
    </div>
  );
}
