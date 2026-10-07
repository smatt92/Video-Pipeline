'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * Interactive controls — the only ones in src/components/ui that need the client.
 */

/** Segmented control. A radiogroup: arrow keys move the selection, as the pattern expects. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? 'on' : undefined}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]!;
              onChange(next.value);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Switch. `on` is red on purpose — the canvas uses it for the kill switch, which is a stop. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`sw${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

/**
 * Raised menu anchored under its trigger. Closes on Escape, outside click and selection;
 * focus returns to the trigger. Items are links or buttons the caller renders with `.ni`.
 */
export function Menu({
  trigger,
  children,
  label,
  align = 'stretch',
}: {
  trigger: (props: { open: boolean; toggle: () => void; id: string; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode;
  children: ReactNode;
  label: string;
  align?: 'stretch' | 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        ref.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pos =
    align === 'stretch' ? { left: 0, right: 0 } : align === 'left' ? { left: 0 } : { right: 0 };

  return (
    <div ref={box} style={{ position: 'relative' }}>
      {trigger({ open, toggle: () => setOpen((o) => !o), id, ref })}
      {open && (
        <div
          id={id}
          className="raised menu"
          role="menu"
          aria-label={label}
          style={{ ...pos, top: 'calc(100% + 6px)' }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a,button')) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
