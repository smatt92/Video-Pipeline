'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { clearVoiceOverrideAction, setVoiceOverrideAction, type LibraryWriteState } from '@/lib/library/actions';

const IDLE: LibraryWriteState = { status: 'idle' };

export function WriteResult({ state }: { state: LibraryWriteState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className="xs" role="status" style={{ color: state.status === 'ok' ? 'var(--live)' : 'var(--blk-text)' }}>
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
      className="btn sm"
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
    <div className="col" style={{ gap: 8 }}>
      <form action={action} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <input type="hidden" name="slug" value={slug} />
        <label className="field xs t3">
          provider
          <select name="provider" defaultValue={current?.provider ?? providers[0]} className="input">
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="field xs t3">
          preset ({providers[0]} only)
          <select
            name="preset_id"
            defaultValue={current && presets.includes(current.voiceId) ? current.voiceId : ''}
            className="input"
          >
            <option value="">—</option>
            {presets.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="field xs t3">
          or voice id
          <input name="voice_id" placeholder="overrides the preset" className="input mono" />
        </label>
        <label className="field xs t3">
          note
          <input name="note" placeholder="why" className="input" />
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
