'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { setRateAction, type RateState } from '@/lib/cost/rate-action';
import type { RateCardRow } from '@/lib/cost/rate-card';

/**
 * One editable rate.
 *
 * ── Editing in place, appending underneath ───────────────────────────────────
 *
 * The field is pre-filled with the current cost and saving *appends* a superseding row.
 * That is a deliberate mismatch between what the control looks like and what it does, and
 * the alternative is worse: an "add a row" form makes the operator re-type the driver,
 * model, endpoint and unit to correct a decimal point, and every one of those is a chance
 * to create a rate that matches nothing and therefore silently never applies.
 *
 * The revision count is shown next to it so the append is visible rather than implied.
 *
 * ── Verified is not a checkbox ───────────────────────────────────────────────
 *
 * There is no way to mark a rate verified without also giving a figure and a provenance
 * note, because those three facts are one fact. A "verified" tick that could be set on its
 * own would be a claim that somebody checked, detached from what they checked.
 */
export function RateRow({ row }: { row: RateCardRow }) {
  const [cost, setCost] = useState(row.unitCost > 0 ? String(row.unitCost) : '');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<RateState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = () => {
    startTransition(async () => {
      const result = await setRateAction({
        driver: row.driver,
        model: row.model,
        endpoint: row.endpoint,
        unit: row.unit,
        unitCost: Number(cost),
        currency: row.currency,
        sourceNote: note,
      });
      setState(result);
      if (result.status === 'ok') {
        setNote('');
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <div
      className="border-b px-4 py-[10px] last:border-b-0"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <div
        className="grid items-center gap-3"
        style={{ gridTemplateColumns: '108px minmax(0,1fr) 92px 78px 92px' }}
      >
        <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
          {row.driver}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm">{row.model}</span>
          <span className="block truncate font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
            {row.endpoint ?? 'no endpoint'}
            {row.revisions > 0 && ` · ${row.revisions} superseded`}
          </span>
        </span>
        <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>
          {row.unit}
        </span>
        <span className="text-right font-mono text-xs" style={{ color: 'var(--text-faint)' }}>
          {/* Em dash, not 0. Zero is a claim about what something cost; this is the absence
              of a claim, and the board's `unpriced` column says the same thing the same way. */}
          {row.isVerified ? `${row.currency === 'USD' ? '$' : ''}${row.unitCost}` : '—'}
        </span>
        {/* ── Two elements, not one ────────────────────────────────────────────
            The state and the control were the same button, tinted `--state-live` when
            verified. `kiln/token-form-rule` refuses that and is right: the two colour
            systems are 40° apart in hue and not separable at a glance, so what carries the
            distinction is *form* — a pressable rectangle is never a state indicator. One
            element cannot be both.

            So the dot says what the rate is, and the button says what you can do to it. */}
        <span className="flex items-center justify-end gap-2">
          <span
            className="font-mono text-2xs"
            style={{ color: row.isVerified ? 'var(--state-live)' : 'var(--text-faint)' }}
          >
            {row.isVerified ? 'verified' : 'unverified'}
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-xs px-[6px] py-[2px] font-mono text-2xs"
            style={{
              // --accent-muted, not --accent-soft: the latter does not exist and would have
              // resolved to nothing, which is a transparent background rather than an error.
              background: open ? 'var(--accent-muted)' : 'var(--surface-2)',
              color: open ? 'var(--accent)' : 'var(--text-muted)',
              minHeight: 'var(--hit-min)',
            }}
            aria-expanded={open}
            aria-label={`Record a rate for ${row.model} per ${row.unit}`}
          >
            {open ? 'cancel' : 'record'}
          </button>
        </span>
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-2 pl-[108px]">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              placeholder="cost per unit"
              aria-label={`Cost per ${row.unit} for ${row.model}`}
              className="rounded-sm border px-3 font-mono text-xs"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-default)',
                minHeight: 'var(--hit-primary)',
                width: '14ch',
              }}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="where this figure came from"
              aria-label="Source note"
              className="min-w-0 flex-1 rounded-sm border px-3 text-xs"
              style={{
                background: 'var(--surface-2)',
                borderColor: 'var(--border-default)',
                minHeight: 'var(--hit-primary)',
              }}
            />
            <button
              type="button"
              onClick={save}
              disabled={pending || cost.trim() === '' || note.trim() === ''}
              className="rounded-sm px-4 text-sm font-medium disabled:opacity-40"
              style={{
                background: 'var(--accent)',
                color: 'var(--accent-contrast)',
                minHeight: 'var(--hit-primary)',
              }}
            >
              {pending ? 'Saving…' : 'Record'}
            </button>
          </div>

          <p className="max-w-[68ch] text-2xs leading-relaxed" style={{ color: 'var(--text-faint)' }}>
            Saving adds a row effective now and keeps the old one. No vendor publishes these
            — read the figure off your balance before and after a real call, and say which
            run in the note.
          </p>

          {state.message && (
            <p
              className="max-w-[68ch] text-xs leading-relaxed"
              style={{ color: state.status === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}
              role={state.status === 'error' ? 'alert' : 'status'}
            >
              {state.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
