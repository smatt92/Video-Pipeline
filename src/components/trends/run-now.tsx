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
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => start(async () => setState(await runTrendsNowAction(channelId)))}
        className="btn sm"
      >
        {pending ? 'Starting…' : 'Run now'}
      </button>
      {state.status !== 'idle' && state.message && (
        <p className="mt-1 text-2xs" style={{ color: state.status === 'ok' ? 'var(--t3)' : 'var(--blk)' }}>
          {state.message}
          {state.runId ? ` Run ${state.runId}.` : ''}
        </p>
      )}
    </div>
  );
}
