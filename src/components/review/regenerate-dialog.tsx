'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useEffect, useState, useTransition } from 'react';

import {
  estimateRegenerateAction,
  regenerateShotAction,
  type ReviewState,
} from '@/lib/review/actions';
import type { RegenerateEstimate } from '@/lib/generate/regenerate';

/**
 * The regenerate confirmation.
 *
 * An `AlertDialog` rather than a `Dialog`: it cannot be dismissed by clicking outside or by
 * pressing Escape onto a confirm. The distinction is the whole point of the component —
 * this spends money and cannot be undone by deleting a row, so the two ways out are both
 * deliberate.
 *
 * ── The estimate is fetched when the dialog opens, not rendered with the page ─
 *
 * A cost shown from page-render state is a cost from whenever the page was rendered. The
 * rate card can change, an integration can be disabled, another attempt can be queued. So
 * the dialog asks at open, and the server asks *again* before it writes — the number on
 * screen is display, never authorisation.
 *
 * ── It says the thing out loud ───────────────────────────────────────────────
 *
 * Rule 6 gives every generation an idempotency key so a retry cannot double-charge.
 * Regenerate is the one operation that deliberately defeats that, by bumping `attempt`. An
 * operator who has internalised "retries are safe here" will read a regenerate button as
 * safe unless told otherwise, so both keys are shown side by side. Two strings that visibly
 * differ are harder to misread than a sentence promising they will.
 */

export function RegenerateDialog({
  renderId,
  shotId,
  shotLabel,
  onDone,
}: {
  renderId: string;
  shotId: string;
  shotLabel: string;
  onDone: (state: ReviewState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState<RegenerateEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    estimateRegenerateAction(shotId)
      .then((e) => {
        if (!cancelled) setEstimate(e);
      })
      .catch((err) => {
        if (!cancelled) {
          setEstimate({
            ok: false,
            blockers: [
              {
                code: 'estimate_failed',
                detail: err instanceof Error ? err.message : String(err),
                remedy: 'Reload and try again.',
              },
            ],
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, shotId]);

  const confirm = () => {
    startTransition(async () => {
      const state = await regenerateShotAction(renderId, shotId);
      onDone(state);
      setOpen(false);
    });
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger
        data-no-drag
        className="rounded-sm border px-[6px] py-[2px] font-mono text-2xs"
        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
        title="Regenerate this shot — spends credits"
      >
        ↻
      </AlertDialog.Trigger>

      <AlertDialog.Portal>
        <AlertDialog.Backdrop
          className="fixed inset-0"
          style={{ background: 'var(--overlay-scrim)' }}
        />
        <AlertDialog.Popup
          className="fixed left-1/2 top-1/2 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-md border p-5"
          style={{
            background: 'var(--surface-2)',
            borderColor: 'var(--border-strong)',
            boxShadow: 'var(--shadow-raised)',
          }}
        >
          <AlertDialog.Title className="text-md font-medium">
            Regenerate {shotLabel}?
          </AlertDialog.Title>

          {loading && (
            <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
              Pricing this against the rate card…
            </p>
          )}

          {estimate?.ok === false && (
            <div className="mt-3">
              <AlertDialog.Description
                className="text-sm leading-relaxed"
                render={<p />}
              >
                This cannot be regenerated yet. Nothing has been charged and nothing was
                queued.
              </AlertDialog.Description>
              {estimate.blockers.map((b) => (
                <div key={b.code} className="mt-3">
                  <div className="font-mono text-3xs" style={{ color: 'var(--state-blocked)' }}>
                    {b.code}
                  </div>
                  <p className="text-xs leading-snug">{b.detail}</p>
                  <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                    {b.remedy}
                  </p>
                </div>
              ))}
            </div>
          )}

          {estimate?.ok === true && (
            <div className="mt-3">
              <AlertDialog.Description
                className="text-sm leading-relaxed"
                render={<p />}
              >
                This submits a new request to {estimate.driver}/{estimate.model} and is
                billed. It cannot be undone by deleting the row afterwards.
              </AlertDialog.Description>

              <dl className="mt-4 flex flex-col gap-2">
                <Line label="Estimated cost">
                  <span className="font-mono text-sm">₹{estimate.costInr.toFixed(2)}</span>
                  <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
                    {estimate.quantity} {estimate.unit} × ${estimate.costUsd.toFixed(4)} @ ₹
                    {estimate.usdInrRate}/$
                  </span>
                </Line>

                {estimate.rateSourceNote && (
                  <p className="text-2xs leading-snug" style={{ color: 'var(--text-faint)' }}>
                    Rate: {estimate.rateSourceNote}
                  </p>
                )}

                {/* The sentence this dialog exists for. */}
                <div
                  className="mt-1 rounded-sm border px-3 py-2"
                  style={{ background: 'var(--surface-inset)', borderColor: 'var(--border-subtle)' }}
                >
                  <p className="text-xs leading-relaxed">
                    This mints a <strong>new idempotency key</strong>, so it is a{' '}
                    <strong>new charge</strong> — not a retry of the previous attempt.
                    Retrying a failed generation reuses its key and does not bill twice;
                    regenerating deliberately does not.
                  </p>
                  <div className="mt-2 flex flex-col gap-[3px] font-mono text-3xs" style={{ color: 'var(--text-faint)' }}>
                    <span>was &nbsp;{estimate.previousKey ?? '— (never submitted)'}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>now &nbsp;{estimate.newKey}</span>
                  </div>
                </div>
              </dl>
            </div>
          )}

          <div className="mt-5 flex items-center gap-2">
            <AlertDialog.Close
              className="rounded-sm border px-3 py-[7px] text-sm"
              style={{ borderColor: 'var(--border-strong)' }}
            >
              Cancel
            </AlertDialog.Close>

            {estimate?.ok === true && (
              <button
                type="button"
                disabled={pending}
                onClick={confirm}
                className="rounded-sm px-3 py-[7px] text-sm font-medium disabled:opacity-60"
                style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
              >
                {pending ? 'Queueing…' : `Spend ₹${estimate.costInr.toFixed(2)}`}
              </button>
            )}
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[120px] shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="flex items-baseline gap-2">{children}</dd>
    </div>
  );
}
