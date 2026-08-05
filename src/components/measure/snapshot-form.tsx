'use client';

import { useState, useTransition } from 'react';

import { recordSnapshotAction } from '@/lib/measure/actions';
import type { DueRow } from '@/lib/measure/read';

/**
 * Type in what the platform showed for one (video, age bucket).
 *
 * ── Why a form and not a fetch ───────────────────────────────────────────────
 *
 * Phase 1 publishes by hand, so it measures by hand. There is no analytics credential —
 * stage 10 has not landed one — and this is the honest interface until there is: a person
 * reads YouTube Studio and types the figures, and every row it writes is stamped
 * `metric_source = 'manual_entry'` so nothing downstream can present a typed number as a
 * fetched one.
 *
 * ── The two controls that matter are the two that look least important ───────
 *
 * **"Not available" is a submit button, not a way out of the form.** It writes a row
 * saying the read was attempted and produced nothing, with a reason. Without it, an
 * unmeasurable video is indistinguishable from one nobody has got to — and those need
 * opposite responses: one is work outstanding, the other is work finished.
 *
 * **Every metric field may be left blank, and blank stays blank.** An HTML number input
 * yields `''`, `Number('')` is `0`, and a `0` in the retention field is the strongest claim
 * this system can make about a hook — nobody made it past three seconds — permanently
 * indistinguishable from a real measurement of a genuinely terrible one. The empty string
 * is mapped to null in `SnapshotInputSchema`, once, at the boundary; nothing on this side
 * coerces. The placeholder says "blank if withheld" rather than showing 0, for the same
 * reason.
 *
 * Views is the exception and the form says so: it is the denominator of every number
 * derived from the row, so a measured snapshot without it is refused rather than stored.
 */

const FIELDS = [
  { name: 'views', label: 'Views', required: true, hint: 'the denominator of everything below' },
  { name: 'likes', label: 'Likes' },
  { name: 'comments', label: 'Comments' },
  { name: 'shares', label: 'Shares' },
  { name: 'saves', label: 'Saves' },
  { name: 'avgViewPct', label: 'Avg view %', hint: '0–100' },
  {
    name: 'retention3sPct',
    label: '3s retention %',
    hint: '0–100 · the hook metric · blank if withheld',
  },
] as const;

export function SnapshotForm({ row, onDone }: { row: DueRow; onDone?: () => void }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = (formData: FormData, status: 'measured' | 'unavailable') => {
    formData.set('publicationId', row.publicationId);
    formData.set('ageBucket', row.ageBucket);
    formData.set('status', status);
    start(async () => {
      const result = await recordSnapshotAction(formData);
      setMessage(
        result.ok
          ? { ok: true, text: result.replaced ? 'Replaced the earlier reading.' : 'Recorded.' }
          : { ok: false, text: result.detail },
      );
      if (result.ok) onDone?.();
    });
  };

  return (
    <form
      className="rounded-md border p-3"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      action={(fd) => submit(fd, 'measured')}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium text-sm">{row.title}</span>
        <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
          {row.ageBucket} · due {new Date(row.dueAt).toLocaleDateString()}
        </span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        {FIELDS.map((f) => (
          <label key={f.name} className="flex flex-col gap-1">
            <span className="text-2xs" style={{ color: 'var(--text-muted)' }}>
              {f.label}
              {'required' in f && f.required ? ' *' : ''}
            </span>
            <input
              name={f.name}
              type="number"
              step="any"
              min="0"
              // No `defaultValue`, and no `0`. An empty field must arrive empty — see the
              // note above on why a zero here is unrecoverable.
              placeholder={'hint' in f && f.hint ? f.hint : ''}
              className="rounded-xs border px-2 py-1 font-mono text-xs"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
            />
          </label>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xs px-3 py-1 text-xs"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          Record
        </button>

        <input
          name="unavailableReason"
          placeholder="…or say why it could not be read"
          className="min-w-[220px] flex-1 rounded-xs border px-2 py-1 text-xs"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
        />
        <button
          type="submit"
          disabled={pending}
          formNoValidate
          // A submit, not a dismissal. It writes a row: "looked, got nothing, here is why."
          onClick={(e) => {
            e.preventDefault();
            const form = e.currentTarget.form;
            if (form) submit(new FormData(form), 'unavailable');
          }}
          className="rounded-xs border px-3 py-1 text-xs"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
        >
          Not available
        </button>
      </div>

      {message && (
        <p
          className="mt-2 text-2xs"
          style={{ color: message.ok ? 'var(--state-live)' : 'var(--state-blocked)' }}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
