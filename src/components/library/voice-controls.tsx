'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { clearVoiceOverrideAction, setVoiceOverrideAction, type LibraryWriteState } from '@/lib/library/actions';

const IDLE: LibraryWriteState = { status: 'idle' };

const inputStyle = {
  background: 'var(--surface-inset)',
  borderColor: 'var(--border-subtle)',
  color: 'var(--text-primary)',
};

export function WriteResult({ state }: { state: LibraryWriteState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className="text-xs leading-relaxed" style={{ color: state.status === 'ok' ? 'var(--state-live)' : 'var(--state-blocked)' }}>
      {state.message}
    </p>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-sm border px-[8px] py-[4px] text-xs disabled:opacity-60"
      style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
    >
      {pending ? '…' : label}
    </button>
  );
}

/**
 * "Change voice" for one character. Two ways to name a voice: a preset from the default
 * provider's list, or a provider plus a free-text id. The server validates with the same
 * predicate the voice stage routes with, and refuses by name.
 */
export function VoiceOverrideForm({
  slug,
  providers,
  presets,
  hasOverride,
  current,
}: {
  slug: string;
  providers: readonly string[];
  presets: readonly string[];
  hasOverride: boolean;
  current: { provider: string; voiceId: string } | null;
}) {
  const [state, action] = useActionState(setVoiceOverrideAction, IDLE);
  const [clearState, clear] = useActionState(clearVoiceOverrideAction.bind(null, slug), IDLE);

  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="slug" value={slug} />
        <label className="flex flex-col gap-[3px] text-2xs" style={{ color: 'var(--text-faint)' }}>
          provider
          <select name="provider" defaultValue={current?.provider ?? providers[0]} className="rounded-sm border px-2 py-[4px] text-xs" style={inputStyle}>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-[3px] text-2xs" style={{ color: 'var(--text-faint)' }}>
          preset ({providers[0]} only)
          <select
            name="preset_id"
            defaultValue={current && presets.includes(current.voiceId) ? current.voiceId : ''}
            className="rounded-sm border px-2 py-[4px] text-xs"
            style={inputStyle}
          >
            <option value="">—</option>
            {presets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-[3px] text-2xs" style={{ color: 'var(--text-faint)' }}>
          or voice id
          <input name="voice_id" placeholder="overrides the preset" className="w-[180px] rounded-sm border px-2 py-[4px] font-mono text-xs" style={inputStyle} />
        </label>
        <label className="flex flex-col gap-[3px] text-2xs" style={{ color: 'var(--text-faint)' }}>
          note
          <input name="note" placeholder="why" className="w-[160px] rounded-sm border px-2 py-[4px] text-xs" style={inputStyle} />
        </label>
        <Submit label="Change voice" />
      </form>
      {hasOverride && (
        <form action={clear}>
          <Submit label="Clear override" />
        </form>
      )}
      <WriteResult state={state.status !== 'idle' ? state : clearState} />
    </div>
  );
}
