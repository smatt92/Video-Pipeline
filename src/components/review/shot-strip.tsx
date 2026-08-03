'use client';

import { useRef, useState } from 'react';

import { DRIFT_TOLERANCE_S, type TimelineSpan } from '@/lib/review/timeline';
import type { ReviewState } from '@/lib/review/actions';
import { RegenerateDialog } from './regenerate-dialog';

/**
 * The shot strip: order, trims, and where each shot sits against the voice.
 *
 * ── Drag, built on pointer events rather than HTML5 drag-and-drop ────────────
 *
 * Two reasons, and the second is the real one. HTML5 DnD does not fire on touch at all, and
 * its drag image is unstyleable in a way that makes a dark UI flash white. But mainly:
 * `dragover`/`drop` gives you a drop target and not a position, so the reorder has to be
 * inferred from where the pointer happened to be — which is exactly the ambiguity that
 * produces an off-by-one drop. Pointer events give a continuous position and the insertion
 * index is arithmetic.
 *
 * Every gesture here also has a keyboard equivalent (Alt+↑/↓), and those share this
 * component's `onReorder` rather than duplicating the list arithmetic — so the two paths
 * cannot disagree about what "move up" means.
 *
 * ── The drift column is the point of this panel ──────────────────────────────
 *
 * Shot durations are derived from word timings. A trim shortens the picture and not the
 * voice, so the error accumulates down the strip and every later shot plays over the wrong
 * line. That is invisible in a player — the file plays — and obvious in a column of
 * numbers, which is why it gets a column.
 */

export interface ShotStripProps {
  spans: TimelineSpan[];
  selectedId: string | null;
  reshootMarks: Set<string>;
  currentTimeS: number;
  dirty: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onSeek: (seconds: number) => void;
  onReorder: (ids: string[]) => void;
  onSaveOrder: () => void;
  onSetTrim: (shotId: string, inS: number | null, outS: number | null) => void;
  onToggleMark: (id: string) => void;
  renderId: string;
  onRegenerated: (state: ReviewState) => void;
}

export function ShotStrip(props: ShotStripProps) {
  const { spans, selectedId, reshootMarks, currentTimeS, dirty, pending } = props;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rowHeight = 62;

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    // Left button only, and not from a handle input — dragging the row while adjusting a
    // trim would reorder the cut when the reviewer meant to nudge a boundary.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragId(id);
    props.onSelect(id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragId || !listRef.current) return;
    const rect = listRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top;
    setDropAt(Math.max(0, Math.min(spans.length - 1, Math.floor(y / rowHeight))));
  };

  const onPointerUp = () => {
    if (dragId && dropAt !== null) {
      const ids = spans.map((s) => s.shot.id);
      const from = ids.indexOf(dragId);
      if (from !== -1 && from !== dropAt) {
        const next = [...ids];
        const [moved] = next.splice(from, 1);
        next.splice(dropAt, 0, moved);
        props.onReorder(next);
      }
    }
    setDragId(null);
    setDropAt(null);
  };

  return (
    <div
      className="rounded-md border"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
    >
      <div
        className="flex items-baseline gap-2 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <span className="text-[13px] font-medium">Shots</span>
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {spans.length}
        </span>
        {dirty && (
          <button
            type="button"
            disabled={pending}
            onClick={props.onSaveOrder}
            className="ml-auto rounded-sm px-2 py-[4px] text-[11.5px] font-medium disabled:opacity-60"
            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            Save order
          </button>
        )}
      </div>

      <div
        ref={listRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="listbox"
        aria-label="Shots in the cut"
        aria-orientation="vertical"
        className="relative"
      >
        {spans.map((span, i) => {
          const selected = span.shot.id === selectedId;
          const playing =
            currentTimeS >= span.startS && currentTimeS < span.endS;
          const drifted = span.driftS !== null && Math.abs(span.driftS) > DRIFT_TOLERANCE_S;
          const marked = reshootMarks.has(span.shot.id);

          return (
            <div
              key={span.shot.id}
              onPointerDown={(e) => onPointerDown(e, span.shot.id)}
              onDoubleClick={() => props.onSeek(span.startS)}
              role="option"
              tabIndex={0}
              aria-selected={selected}
              aria-label={`Shot ${span.shot.idx}, ${span.shot.description}`}
              className="relative grid cursor-grab items-center gap-2 border-b px-4 last:border-b-0"
              style={{
                height: rowHeight,
                gridTemplateColumns: '26px minmax(0,1fr) 74px 58px',
                borderColor: 'var(--border-subtle)',
                background: selected
                  ? 'var(--surface-2)'
                  : dropAt === i && dragId
                    ? 'var(--surface-inset)'
                    : 'transparent',
                opacity: dragId === span.shot.id ? 0.5 : 1,
              }}
            >
              {/* The playhead marker is its own non-interactive element rather than a
                  border on the row. A state colour painted onto something clickable reads
                  as "this control is in that state" — the rule that says so is right, and
                  the fix is to separate the report from the target, not to recolour it. */}
              {playing && (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-[2px]"
                  style={{ background: 'var(--state-ready)' }}
                />
              )}
              <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {String(span.shot.idx).padStart(2, '0')}
              </span>

              <div className="min-w-0">
                <div className="truncate text-[12px]">
                  {marked && (
                    <span className="mr-1 font-mono text-[10px]" style={{ color: 'var(--state-review)' }}>
                      ↻
                    </span>
                  )}
                  {span.shot.description}
                </div>
                <div className="flex items-baseline gap-2 font-mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
                  <span>{span.startS.toFixed(2)}s</span>
                  {span.shot.trimInS !== null && (
                    <span style={{ color: 'var(--state-review)' }}>
                      trim {span.shot.trimInS}–{span.shot.trimOutS}
                    </span>
                  )}
                  {span.shot.durationSource !== 'derived_from_vo' && (
                    <span title="Still the shotlist estimate — this shot was not timed against speech.">
                      estimated
                    </span>
                  )}
                  {!span.shot.assetKey && (
                    <span style={{ color: 'var(--state-blocked)' }}>no clip</span>
                  )}
                  {span.shot.assetKey && !span.shot.normalised && (
                    <span style={{ color: 'var(--state-blocked)' }}>unnormalised</span>
                  )}
                </div>
              </div>

              <div data-no-drag className="flex items-center gap-1">
                <HandleButton
                  label="["
                  title="Set the in point here"
                  onClick={() =>
                    props.onSetTrim(
                      span.shot.id,
                      round(currentTimeS - span.startS + (span.shot.trimInS ?? 0)),
                      span.shot.trimOutS ?? span.shot.durationS,
                    )
                  }
                />
                <HandleButton
                  label="]"
                  title="Set the out point here"
                  onClick={() =>
                    props.onSetTrim(
                      span.shot.id,
                      span.shot.trimInS ?? 0,
                      round(currentTimeS - span.startS + (span.shot.trimInS ?? 0)),
                    )
                  }
                />
                <HandleButton
                  label="✕"
                  title="Clear the trim"
                  onClick={() => props.onSetTrim(span.shot.id, null, null)}
                />
                {/* Regenerate lives beside the trim handles because it is the other thing
                    you do to a shot you do not like — and unlike a trim, it spends money and
                    cannot be undone. It is the only control here behind a confirmation. */}
                <RegenerateDialog
                  renderId={props.renderId}
                  shotId={span.shot.id}
                  shotLabel={`shot ${String(span.shot.idx).padStart(2, '0')}`}
                  onDone={props.onRegenerated}
                />
              </div>

              <span
                className="text-right font-mono text-[10.5px]"
                style={{ color: drifted ? 'var(--state-blocked)' : 'var(--text-faint)' }}
                title={
                  span.driftS === null
                    ? 'This shot covers no speech, so there is nothing to be out of sync with.'
                    : `Picture starts ${span.driftS}s from where this shot's line starts.`
                }
              >
                {span.driftS === null ? '—' : `${span.driftS > 0 ? '+' : ''}${span.driftS.toFixed(2)}`}
              </span>
            </div>
          );
        })}
      </div>

      <p className="px-4 py-2 text-[10.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>
        Drag to reorder, or Alt+↑/↓. The right column is how far the picture has drifted from
        the voice by the time each shot starts — anything over {DRIFT_TOLERANCE_S}s is words
        landing on the wrong images, in a file that plays perfectly.
      </p>
    </div>
  );
}

function HandleButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="rounded-sm border px-[6px] py-[2px] font-mono text-[10.5px]"
      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
    >
      {label}
    </button>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
