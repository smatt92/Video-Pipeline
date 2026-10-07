'use client';

import { useActionState, useTransition } from 'react';

import { mintTokenAction, revokeTokenAction, type MintState } from '@/lib/bureau/token-actions';

export function TokenMint() {
  const [state, action, pending] = useActionState<MintState, FormData>(mintTokenAction, { status: 'idle' });
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted">Name</span>
          <input name="name" required placeholder="Sahil — claude.ai" className="input" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted">Scope</span>
          <select name="scope" defaultValue="agent" className="input">
            <option value="agent">agent — Routines and scheduled tasks</option>
            <option value="approver">approver — you, in Claude chat</option>
          </select>
        </label>
        <button disabled={pending} className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-contrast">
          {pending ? 'Minting…' : 'Mint token'}
        </button>
      </div>
      {state.status === 'ok' && (
        <div className="rounded border border-border-default p-3 text-sm">
          <p className="mb-2">
            Copy this <strong>{state.scope}</strong> token now — it is shown once and only its hash is stored.
          </p>
          <code className="block break-all font-mono text-xs">{state.plaintext}</code>
        </div>
      )}
      {state.status === 'error' && <p className="text-sm text-danger">{state.message}</p>}
    </form>
  );
}

export function RevokeButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => void (await revokeTokenAction(id)))}
      className="text-sm text-danger underline"
    >
      {pending ? 'Revoking…' : 'Revoke'}
    </button>
  );
}
