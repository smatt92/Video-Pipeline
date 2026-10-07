'use client';

import { useState, useTransition } from 'react';

import { restartRunAction, startRunAction } from '@/lib/bureau/ui-actions';

/**
 * Shown on the board for an approved episode whose run never started (queued, no run id),
 * and — as "Restart run" — for one that halted on a refusal whose cause has been fixed.
 */
export function StartRun({ episodeId, restart = false }: { episodeId: string; restart?: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={pending}
        className="min-h-11 rounded-md border px-2 text-2xs font-medium"
        style={{ borderColor: 'var(--border-default)' }}
        onClick={() => start(async () => setMsg((await (restart ? restartRunAction : startRunAction)(episodeId)).message))}
      >
        {pending ? 'Starting…' : restart ? 'Restart run' : 'Start run'}
      </button>
      {msg && <p className="mt-1 text-2xs" style={{ color: 'var(--text-secondary)' }}>{msg}</p>}
    </div>
  );
}
