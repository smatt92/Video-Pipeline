'use client';

import { useState, useTransition } from 'react';

import { publishNowAction } from '@/lib/publish/actions';

/**
 * Send one publication to the worker.
 *
 * Disabled when the queue view reports a blocker, and the blocker is shown instead of a
 * tooltip. A button that is always enabled is a button that usually errors, and an error
 * you could have predicted from the screen's own state is worse than an absent control —
 * the same placement rule the Request-metadata button follows.
 *
 * The quota cost is stated on the control itself. 1,600 units of a 10,000 daily allowance
 * is a sixth of a day per attempt, and a person clicking a button that spends that should
 * be told before rather than after.
 */
export function PublishButton({
  publicationId,
  blocker,
  unitsRemaining,
}: {
  publicationId: string;
  blocker: string | null;
  unitsRemaining: number | null;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  if (blocker) {
    return (
      <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
        {blocker.replace(/_/g, ' ')}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const outcome = await publishNowAction(publicationId);
            setResult(
              outcome.enqueued
                ? `Uploading. Run ${outcome.runId?.slice(0, 12)}.`
                : (outcome.error ?? 'Could not enqueue.'),
            );
          })
        }
        className="rounded-xs px-3 py-1 text-xs"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
      >
        Publish
      </button>
      <span className="font-mono text-3xs" style={{ color: 'var(--text-faint)' }}>
        {/* Undefined rather than 0 when nothing is counting a quota — the two mean
            opposite things and only one of them should stop anybody clicking. */}
        1,600 units{unitsRemaining === null ? '' : ` · ${unitsRemaining.toLocaleString('en-IN')} left today`}
      </span>
      {result && (
        <span className="text-2xs" style={{ color: 'var(--text-muted)' }}>
          {result}
        </span>
      )}
    </span>
  );
}
