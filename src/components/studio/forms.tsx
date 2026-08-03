'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';

import { sendTurnAction, startSessionAction, type StudioState } from '@/lib/studio/actions';

/**
 * The two write surfaces of the Studio lane.
 *
 * Both are `useActionState` over a Server Action, so the whole turn — model call, tool
 * calls, ledger row, cap check — happens on the server and the browser only ever sees the
 * outcome. No API key, no session token and no tool payload passes through the client.
 */

const IDLE: StudioState = { status: 'idle' };

function tone(status: StudioState['status']) {
  if (status === 'ok') return 'var(--state-live)';
  if (status === 'capped') return 'var(--state-blocked)';
  return 'var(--state-blocked)';
}

function Submit({ label, busy }: { label: string; busy: string }) {
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
      {pending ? busy : label}
    </button>
  );
}

const inputStyle = {
  background: 'var(--surface-inset)',
  borderColor: 'var(--border-subtle)',
  color: 'var(--text-primary)',
};

export function StartSessionForm({ proposedCap }: { proposedCap: number | null }) {
  const [state, action] = useActionState(startSessionAction, IDLE);
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'ok' && state.sessionId) router.push(`/studio/${state.sessionId}`);
  }, [state, router]);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span
          className="font-mono text-[10px] uppercase tracking-[0.09em]"
          style={{ color: 'var(--text-faint)' }}
        >
          Working title
        </span>
        <input
          name="title"
          placeholder="What are you trying to make?"
          className="rounded-sm border px-2 py-[7px] text-[12.5px] outline-none"
          style={inputStyle}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span
          className="font-mono text-[10px] uppercase tracking-[0.09em]"
          style={{ color: 'var(--text-faint)' }}
        >
          Spend cap for this session (₹)
        </span>
        <input
          name="spend_cap_inr"
          type="number"
          min={1}
          step={1}
          defaultValue={proposedCap ?? undefined}
          required
          className="w-[160px] rounded-sm border px-2 py-[7px] font-mono text-[12.5px] outline-none"
          style={inputStyle}
        />
        {/* Shown, not hidden behind a default. The cap stops the session dead when it is
            reached — it does not warn — so the number is worth a person's attention once. */}
        <span className="text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>
          When this is reached the session stops accepting turns. Nothing is rolled back:
          the transcript, any script, and every cost row stay exactly as they were.
        </span>
      </div>

      {state.status !== 'idle' && state.message && (
        <p className="text-[12px] leading-relaxed" style={{ color: tone(state.status) }}>
          {state.message}
        </p>
      )}

      <div>
        <Submit label="Open session" busy="Opening…" />
      </div>
    </form>
  );
}

export function Composer({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const send = sendTurnAction.bind(null, sessionId);
  const [state, action] = useActionState(send, IDLE);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'ok') formRef.current?.reset();
  }, [state]);

  if (disabled) {
    return (
      <p className="text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
        This session has stopped. Open a new one to keep working — the transcript above is
        kept as it stands.
      </p>
    );
  }

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-2">
      <textarea
        name="text"
        rows={3}
        required
        placeholder="Describe what you want to make, or ask what is possible."
        className="resize-y rounded-sm border px-2 py-[7px] text-[12.5px] leading-relaxed outline-none"
        style={inputStyle}
      />
      <div className="flex items-center gap-3">
        <Submit label="Send" busy="Thinking…" />
        {state.status !== 'idle' && state.message && (
          <span className="font-mono text-[11px]" style={{ color: tone(state.status) }}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
