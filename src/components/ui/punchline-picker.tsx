'use client';

/**
 * Punchline picker (canvas: Components → Punchline picker, Approvals). Three tap targets keyed
 * A / B / C. Controlled — the parent owns the pick, because Approve stays disabled until there
 * is one and the parent renders Approve. Keys are handled by the parent card too (it has focus),
 * so this component only renders and reports clicks.
 */
export function PunchlinePicker({
  lines,
  picked,
  onPick,
  disabled,
}: {
  lines: readonly string[];
  picked: string | null;
  onPick: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="col" style={{ gap: 8 }} role="radiogroup" aria-label="Punchline">
      {lines.map((t, i) => {
        const k = 'ABCDEFG'[i]!;
        const on = picked === k;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            className={`pick${on ? ' on' : ''}`}
            onClick={() => onPick(k)}
          >
            <span className="key" aria-hidden="true">
              {k}
            </span>
            <span className="txt">{t}</span>
          </button>
        );
      })}
    </div>
  );
}
