'use client';

import { useState, useTransition } from 'react';

import { runTrendsNowAction } from '@/lib/trends/action';
import type { TrendsState } from '@/lib/trends/run-now';

/**
 * Run now — collect trends for one channel (the page passes the active one) from its
 * trends.json. The action refuses anyone but the approver, so the button does not need to
 * know who is looking.
 */
export function RunNow({ channelId }: { channelId: string }) {
  const [state, setState] = useState<TrendsState>({ status: 'idle' });
  const [pending, start] = useTransition();
  return (
    <div className="col" style={{ gap: 6, alignItems: 'flex-end', maxWidth: 420 }}>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setState(await runTrendsNowAction(channelId)))}
        className="btn pri"
      >
        {pending ? 'Starting…' : 'Run now'}
      </button>
      {state.status !== 'idle' && state.message && (
        <p className="xs" role="status" style={{ color: state.status === 'ok' ? 'var(--t3)' : 'var(--blk-text)', textAlign: 'right' }}>
          {state.message}
          {state.runId ? ` Run ${state.runId}.` : ''}
        </p>
      )}
    </div>
  );
}
