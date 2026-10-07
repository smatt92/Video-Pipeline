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
        className="rounded-sm border px-3 py-1 text-xs"
        style={{ borderColor: 'var(--border-default)', color: 'var(--accent)' }}
      >
        {pending ? 'Starting…' : 'Run now'}
      </button>
      {state.status !== 'idle' && state.message && (
        <p className="mt-1 text-2xs" style={{ color: state.status === 'ok' ? 'var(--text-muted)' : 'var(--state-blocked)' }}>
          {state.message}
          {state.runId ? ` Run ${state.runId}.` : ''}
        </p>
      )}
    </div>
  );
}
