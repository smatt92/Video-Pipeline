'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { setHostVoiceAction, type VoiceState } from '@/lib/settings/voice-action';

/**
 * The host voice field.
 *
 * ── It says what saving unblocks ─────────────────────────────────────────────
 *
 * Deliberately, and this is the one design decision in an otherwise ordinary text input.
 * The value's consequence is four stages away: with it null, stage 4 stops, stage 6 never
 * runs, durations stay estimates and stage 5 refuses every shot — the chain that made
 * STATE.md §8. Nobody looking at a settings screen would guess that, and a field whose
 * absence silently stops a pipeline has to say so where it is set rather than in a doc.
 *
 * No optimistic apply, unlike the scale stepper next door. This is not a visual preference
 * you judge by looking; it is a value the next pipeline run reads, and showing it as saved
 * before it is would be a lie about something that costs money later.
 */
export function HostVoiceControl({
  channelId,
  current,
  language,
}: {
  channelId: string;
  current: string | null;
  language: string;
}) {
  const [value, setValue] = useState(current ?? '');
  const [state, setState] = useState<VoiceState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = () => {
    startTransition(async () => {
      const result = await setHostVoiceAction(channelId, value, language);
      setState(result);
      if (result.status === 'ok') router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          placeholder="voice id, not a display name"
          aria-label="Host voice id"
          spellCheck={false}
          className="rounded-sm border px-3 font-mono text-xs"
          style={{
            background: 'var(--surface-2)',
            borderColor: 'var(--border-default)',
            minHeight: 'var(--hit-primary)',
            minWidth: '22ch',
          }}
        />
        <button
          type="button"
          onClick={save}
          disabled={pending || value === (current ?? '')}
          className="rounded-sm px-4 text-sm font-medium disabled:opacity-40"
          style={{
            background: 'var(--accent)',
            color: 'var(--accent-contrast)',
            minHeight: 'var(--hit-primary)',
          }}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>

      {state.message && (
        <p
          className="max-w-[62ch] text-xs leading-relaxed"
          style={{
            color: state.status === 'error' ? 'var(--danger)' : 'var(--text-muted)',
          }}
          role={state.status === 'error' ? 'alert' : 'status'}
        >
          {state.message}
        </p>
      )}

      {/* Shown when unset, which is the state that matters. A field that is empty for a
          reason nobody can see is how the chain stayed inert. */}
      {!current && state.status !== 'ok' && (
        <p className="max-w-[62ch] text-xs leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          Until this is set, an approved concept produces a script and a shotlist and then
          stops — stage 6 needs a voice, and stage 5 will not generate video against a
          duration that was estimated rather than measured. The board shows it as blocked
          rather than failed.
        </p>
      )}
    </div>
  );
}
