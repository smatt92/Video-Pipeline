'use client';

/**
 * The keyboard map, in one place, rendered rather than documented.
 *
 * A shortcut nobody can discover is a shortcut nobody uses, and the usual fix — a page in a
 * wiki — is read once. This list is the same data the screen binds, shown on `?`.
 *
 * The bindings are deliberately the ones editors already have: J/K/L for shuttle, `[` and
 * `]` for in and out. Inventing a scheme would make the reviewer learn something in order
 * to do a job they already know how to do, and the cost of that shows up as scrubbing done
 * badly rather than as a complaint.
 */

export interface Shortcut {
  keys: string;
  does: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Space', does: 'Play / pause' },
  { keys: 'J / K / L', does: 'Back a second · pause · forward a second' },
  { keys: '← / →', does: 'Step one frame' },
  { keys: 'Shift + ← / →', does: 'Step one second' },
  { keys: 'Home / End', does: 'Jump to the start or the end of the cut' },
  { keys: '↑ / ↓', does: 'Select the previous or next shot' },
  { keys: 'Enter', does: 'Move the playhead to the selected shot' },
  { keys: 'Alt + ↑ / ↓', does: 'Move the selected shot in the order (not saved until you save it)' },
  { keys: '[', does: 'Set the in point of the selected shot at the playhead' },
  { keys: ']', does: 'Set the out point of the selected shot at the playhead' },
  { keys: '\\', does: 'Clear the trim on the selected shot' },
  { keys: 'M', does: 'Mark or unmark the selected shot for reshoot' },
  { keys: 'C', does: 'Toggle captions on the canvas' },
  { keys: '?', does: 'Show or hide this list' },
];

export function KeyboardMap({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  return (
    <div
      className="rounded-md border"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
    >
      {shortcuts.map((s) => (
        <div
          key={s.keys}
          className="flex items-baseline gap-3 border-b px-3 py-[6px] last:border-b-0"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="w-[110px] shrink-0 font-mono text-[10.5px]">{s.keys}</span>
          <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            {s.does}
          </span>
        </div>
      ))}
      <p className="px-3 py-2 text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
        Nothing here writes a review decision. Pass, reshoot and kill are buttons on purpose —
        a keystroke that writes the row the publish gate reads is one fat finger from a
        published video nobody approved.
      </p>
    </div>
  );
}
