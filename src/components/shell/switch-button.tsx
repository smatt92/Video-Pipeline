'use client';

import { useSwitchChannel } from './nav-parts';

/** "Open Bureau of Reality" on an All channels card: sets the active channel, goes to its Home. */
export function SwitchButton({ id, name }: { id: string; name: string }) {
  const { go, pending, error } = useSwitchChannel();
  return (
    <span className="col" style={{ gap: 4 }}>
      <button type="button" className="btn sm full" disabled={pending} onClick={() => go(id)}>
        {pending ? 'Switching…' : `Open ${name}`}
      </button>
      {error && (
        <span className="xs" role="alert" style={{ color: 'var(--blk-text)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
