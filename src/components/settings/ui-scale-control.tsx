'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { setUiScaleAction, type ScaleState } from '@/lib/settings/ui-scale-action';
import { labelFor, UI_SCALES, UI_SCALE_STORAGE_KEY, type UiScale } from '@/lib/settings/ui-scale';

/**
 * The display scale stepper.
 *
 * ── It applies before the round trip ─────────────────────────────────────────
 *
 * Clicking a step writes `--ui-scale` on the document immediately, then persists. That
 * ordering is the whole usability of the control: this is a *visual* preference, and one
 * you judge by looking at the result. Waiting for a server round trip and a revalidate to
 * see 110% makes the person click, wait, evaluate, click — four steps to answer a question
 * they could have answered by hovering.
 *
 * If the write fails the optimistic value is rolled back and the error is shown, because a
 * preference that looks applied and is not survives until the next reload and then
 * mysteriously reverts.
 */
export function UiScaleControl({ current }: { current: UiScale }) {
  const [value, setValue] = useState<UiScale>(current);
  const [state, setState] = useState<ScaleState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const apply = (scale: UiScale) => {
    const previous = value;
    setValue(scale);
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    // Mirrored for the pre-auth splash, which has no profile to read from.
    try {
      localStorage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
    } catch {
      /* private mode; the server value is authoritative anyway */
    }

    startTransition(async () => {
      const result = await setUiScaleAction(scale);
      setState(result);
      if (result.status === 'error') {
        setValue(previous);
        document.documentElement.style.setProperty('--ui-scale', String(previous));
      } else {
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Display scale" className="flex flex-wrap gap-1">
        {UI_SCALES.map((scale) => {
          const active = scale === value;
          return (
            <button
              key={scale}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={pending}
              onClick={() => apply(scale)}
              className="rounded-sm border px-3 font-mono text-xs transition-colors disabled:opacity-60"
              style={{
                // The floor is not scaled, so the control stays a legal target at 90%.
                minHeight: 'var(--hit-min)',
                background: active ? 'var(--accent)' : 'var(--surface-inset)',
                color: active ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
                transitionDuration: 'var(--duration-fast)',
              }}
            >
              {labelFor(scale)}
            </button>
          );
        })}
      </div>

      {state.status !== 'idle' && state.message && (
        <p
          className="text-xs leading-snug"
          style={{ color: state.status === 'ok' ? 'var(--state-live)' : 'var(--state-blocked)' }}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
