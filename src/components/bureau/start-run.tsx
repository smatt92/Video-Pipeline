'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { restartRunAction, startRunAction } from '@/lib/bureau/ui-actions';

/**
 * Start / Restart run — the one action on a blocker for a stopped or never-started episode.
 * Same server actions as before the redesign; the message the action returns is shown verbatim.
 */
export function StartRun({ episodeId, restart = false, primary = false, full = false, label }: { episodeId: string; restart?: boolean; primary?: boolean; full?: boolean; label?: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="col" style={{ gap: 4, alignItems: full ? 'stretch' : 'flex-start', flex: full ? '1 1 auto' : 'none' }}>
      <button
        type="button"
        disabled={pending}
        className={`btn sm${primary ? ' pri' : ''}${full ? ' full' : ''}`}
        onClick={() =>
          start(async () => {
            const r = await (restart ? restartRunAction : startRunAction)(episodeId);
            setMsg(r.message);
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? 'Starting…' : label ?? (restart ? 'Restart run' : 'Start run')}
      </button>
      {msg && (
        <span className="xs t2" role="status">
          {msg}
        </span>
      )}
    </span>
  );
}
