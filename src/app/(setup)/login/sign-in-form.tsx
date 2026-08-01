'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { requestSignInLink, type SignInState } from './actions';

const initial: SignInState = { status: 'idle' };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-sm px-3 py-[7px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: 'var(--accent)',
        color: 'var(--accent-contrast)',
        transitionDuration: 'var(--duration-fast)',
      }}
    >
      {pending ? 'Sending…' : 'Send sign-in link'}
    </button>
  );
}

export function SignInForm({ next }: { next: string }) {
  const [state, action] = useActionState(requestSignInLink, initial);

  if (state.status === 'sent') {
    return (
      <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Link sent. It signs you in on this device and expires shortly — request another if
        it lapses.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-[6px]">
        <span className="font-mono text-[10px] uppercase tracking-[0.09em]" style={{ color: 'var(--text-faint)' }}>
          Email
        </span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          className="w-full rounded-sm border px-[10px] py-[7px] text-[13px] outline-none"
          style={{
            background: 'var(--surface-inset)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-primary)',
          }}
        />
      </label>

      {state.message && (
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--state-blocked)' }}>
          {state.message}
        </p>
      )}

      <div>
        <Submit />
      </div>
    </form>
  );
}
