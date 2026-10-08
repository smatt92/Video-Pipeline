'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';

import { sendTurnAction, startSessionAction, studioIdeasAction, type IdeasState, type StudioState } from '@/lib/studio/actions';

/**
 * The two write surfaces of the Studio lane.
 *
 * Both are `useActionState` over a Server Action, so the whole turn — model call, tool
 * calls, ledger row, cap check — happens on the server and the browser only ever sees the
 * outcome. No API key, no session token and no tool payload passes through the client.
 */

const IDLE: StudioState = { status: 'idle' };

function tone(status: StudioState['status']) {
  if (status === 'ok') return 'var(--live)';
  if (status === 'capped') return 'var(--blk)';
  return 'var(--blk)';
}

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn pri"
    >
      {pending ? busy : label}
    </button>
  );
}

const inputStyle = {
  background: 'var(--in)',
  borderColor: 'var(--b1)',
  color: 'var(--t1)',
};

export function StartSessionForm({ proposedCap, channelName }: { proposedCap: number | null; channelName?: string }) {
  const [state, action] = useActionState(startSessionAction, IDLE);
  const router = useRouter();
  const [brief, setBrief] = useState('');
  const [ideas, setIdeas] = useState<IdeasState>({ status: 'idle' });
  const [thinking, startIdeas] = useTransition();
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // A session that opened goes to its own screen, even when its first turn failed — that
  // screen shows the transcript and the reason.
  useEffect(() => {
    if (state.sessionId) router.push(`/studio/${state.sessionId}`);
  }, [state, router]);

  const lines = brief.split('\n').length;

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="row sb" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="font-mono text-3xs uppercase tracking-[0.09em]" style={{ color: 'var(--t3)' }}>
            What do you want to make?
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={thinking}
            title={`Five ideas for ${channelName ?? 'this channel'} from its most relevant trends — one cheap call, nothing drafted`}
            onClick={() =>
              startIdeas(async () => {
                setIdeas({ status: 'idle' });
                setIdeas(await studioIdeasAction());
              })
            }
          >
            {thinking ? 'Finding ideas…' : 'Ideas from trends'}
          </button>
        </div>
        <textarea
          ref={boxRef}
          name="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={Math.min(18, Math.max(6, lines + 1))}
          placeholder={'Describe the video, or paste a full brief. It is sent as the session’s first message.\n\ne.g. 3D explainer, Full motion: what is packed inside the arm of camera smart glasses.'}
          className="input"
          style={{ ...inputStyle, resize: 'vertical', minHeight: 140, lineHeight: 1.5, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}
        />
        <span className="text-xs" style={{ color: 'var(--t3)' }}>
          {brief.trim() ? `${brief.trim().length} characters · opening the session sends this to Opus straight away` : 'Leave empty to open the session and type there instead.'}
        </span>
      </div>

      {ideas.status === 'error' && ideas.message && (
        <p className="text-xs leading-relaxed" style={{ color: 'var(--blk)' }}>
          {ideas.message}
        </p>
      )}
      {ideas.status === 'ok' && ideas.ideas && (
        <div className="flex flex-col gap-2" aria-label="Ideas from trends">
          <span className="font-mono text-2xs" style={{ color: 'var(--t3)' }}>
            {ideas.message}
          </span>
          {ideas.ideas.map((i, n) => (
            <div key={n} className="inset col" style={{ gap: 6, padding: '10px 12px' }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className="pill s-ac nodot">{i.seriesName}</span>
                <span className="mono xs t3">
                  trend: {i.trend}
                  {i.relevance === null ? '' : ` · ${i.relevance.toFixed(2)}`}
                </span>
              </div>
              <span className="sm" style={{ fontWeight: 500 }}>
                {i.topic}
              </span>
              <span className="xs t2">“{i.hook}”</span>
              <span className="xs t3">{i.why}</span>
              <div>
                <button
                  type="button"
                  className="btn sm pri"
                  onClick={() => {
                    setBrief(i.prompt);
                    boxRef.current?.focus();
                    boxRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }}
                >
                  Use this idea
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="font-mono text-3xs uppercase tracking-[0.09em]" style={{ color: 'var(--t3)' }}>
          Spend cap for this session (₹)
        </span>
        <input
          name="spend_cap_inr"
          type="number"
          min={1}
          step={1}
          defaultValue={proposedCap ?? undefined}
          required
          className="input mono"
          style={{ ...inputStyle, maxWidth: 160 }}
        />
        {/* Shown, not hidden behind a default. The cap stops the session dead when it is
            reached — it does not warn — so the number is worth a person's attention once. */}
        <span className="text-xs leading-snug" style={{ color: 'var(--t3)' }}>
          When this is reached the session stops accepting turns. Nothing is rolled back:
          the transcript, any script, and every cost row stay exactly as they were.
        </span>
      </div>

      {state.status !== 'idle' && state.message && (
        <p className="text-xs leading-relaxed" style={{ color: tone(state.status) }}>
          {state.message}
        </p>
      )}

      <div>
        <Submit label={brief.trim() ? 'Open session and send' : 'Open session'} busy={brief.trim() ? 'Opening and drafting… (up to a minute)' : 'Opening…'} />
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
      <p className="text-sm" style={{ color: 'var(--t3)' }}>
        This session has stopped. Open a new one to keep working — the transcript above is
        kept as it stands.
      </p>
    );
  }

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-2">
      <textarea
        name="text"
        rows={5}
        required
        placeholder="Describe what you want to make, or ask what is possible."
        className="input"
        style={{ ...inputStyle, resize: 'vertical', minHeight: 110, lineHeight: 1.5, fontFamily: 'inherit' }}
      />
      <div className="flex items-center gap-3">
        <Submit label="Send" busy="Thinking…" />
        {state.status !== 'idle' && state.message && (
          <span className="font-mono text-2xs" style={{ color: tone(state.status) }}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
