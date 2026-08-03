'use client';

import { useActionState } from 'react';

import { deferStep, undeferStep, type StepState } from '@/lib/onboarding/actions';

/**
 * Defer this step.
 *
 * Placed below the verification control and styled quieter than it, deliberately: this is
 * the escape hatch, not the path. Someone who has the credentials should never reach for
 * it, and someone who does not should not have to guess whether the product has one.
 *
 * The reason field is required and the copy says what it is for. It is not bureaucracy —
 * it is the text the banner shows on every screen afterwards, and "no reason recorded" is
 * a worse thing to read in a fortnight than anything you would have typed.
 */

const idle: StepState = { status: 'idle' };

export function DeferForm({
  stepNumber,
  deferred,
}: {
  stepNumber: number;
  deferred: { reason: string; at: string } | null;
}) {
  const [state, action, pending] = useActionState(
    deferStep.bind(null, stepNumber),
    idle,
  );
  const [undoState, undo, undoing] = useActionState(
    async () => undeferStep(stepNumber),
    idle,
  );

  if (deferred) {
    return (
      <div
        className="mt-5 rounded-sm border px-3 py-2.5 text-xs leading-relaxed"
        style={{
          borderColor: 'var(--border-strong)',
          background: 'var(--surface-inset)',
          color: 'var(--text-muted)',
        }}
      >
        <div className="font-medium" style={{ color: 'var(--state-review)' }}>
          Deferred{deferred.at ? ` on ${deferred.at.slice(0, 10)}` : ''}
        </div>
        <p className="mt-1">“{deferred.reason}”</p>
        <p className="mt-2">
          This step is <strong>not complete</strong>. The app is reachable, and everything
          that needs this integration still refuses with the reason above. Running the check
          successfully clears this automatically.
        </p>
        <form action={undo} className="mt-2">
          <button
            type="submit"
            disabled={undoing}
            className="text-xs underline underline-offset-2"
            style={{ color: 'var(--text-secondary)' }}
          >
            {undoing ? 'Clearing…' : 'Clear the deferral'}
          </button>
        </form>
        {undoState.status === 'error' && (
          <p className="mt-1" style={{ color: 'var(--state-review)' }}>
            {undoState.message}
          </p>
        )}
      </div>
    );
  }

  return (
    <details className="mt-5">
      <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-faint)' }}>
        I do not have these credentials yet
      </summary>

      <div className="mt-3 max-w-[62ch]">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Deferring opens the app without this step. It is recorded, shown in a banner on
          every screen, and named by every task that refuses because of it. It is not a pass
          and does not make this integration usable — that needs a real check.
        </p>

        <form action={action} className="mt-3 flex flex-col gap-2">
          <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Why — this is what the banner shows you later
            <input
              name="reason"
              required
              minLength={3}
              placeholder="API access is gated to a paid tier; applied for it"
              className="mt-1 w-full rounded-sm border px-2 py-1.5 text-xs"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-2)',
                color: 'var(--text-primary)',
              }}
            />
          </label>

          <button
            type="submit"
            disabled={pending}
            className="self-start rounded-sm border px-3 py-1.5 text-xs"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
          >
            {pending ? 'Deferring…' : 'Defer this step'}
          </button>
        </form>

        {state.status !== 'idle' && state.message && (
          <p
            className="mt-2 text-xs leading-relaxed"
            style={{
              color: state.status === 'ok' ? 'var(--text-muted)' : 'var(--state-review)',
            }}
          >
            {state.message}
          </p>
        )}
      </div>
    </details>
  );
}
