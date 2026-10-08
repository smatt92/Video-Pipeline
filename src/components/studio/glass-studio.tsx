'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';

import { Gauge } from '@/components/glass/gauge';
import { Icon, type IconName } from '@/components/ui/icon';
import { sendTurnAction, startSessionAction, studioIdeasAction, type IdeasState, type StudioState } from '@/lib/studio/actions';
import { FORMAT_INFO, MOTION_LEVELS, PACE_INFO, VISUAL_FORMATS, type MotionLevel, type VisualFormat, type VoicePace } from '@/lib/bureau/formats';

/**
 * The Kiln Glass Studio (canvas: GlassStudio): the floating prompt panel and the "Video
 * settings" panel, sharing one state so the choices are sent with the message.
 *
 * The prompt panel is the same two Server Actions as before — open a session and send its
 * first turn, or send a turn — so the whole turn still happens on the server. What is new is
 * that the panel's video type, motion and pace travel with the text as form fields and are
 * folded into the message server-side (lib/studio/video-settings.ts), where draft_brief reads them.
 * On a running session the composer sends them only when you changed them.
 *
 * Prices are `formatOptions` for the session's newest brief against the per-Short cap. Before
 * a brief exists there is nothing to price, and the panel says so — never a ₹0.
 */

type Prices = {
  types: Record<VisualFormat, { inr: number | null; disabled: string | null; note: string | null }>;
  motions: Record<MotionLevel, number | null> | null;
} | null;

const TYPE_ICON: Record<VisualFormat, IconName> = { illustrated: 'picture', diagram: 'chalk', cinematic: 'cinematic', characters: 'cartoon', engineered: 'cube' };
const TYPE_SHORT: Record<VisualFormat, string> = { illustrated: 'Illustrated', diagram: 'Chalk', cinematic: 'Cinematic', characters: 'Cartoon', engineered: '3D' };
const IDLE: StudioState = { status: 'idle' };

export interface StudioPanelProps {
  mode: 'start' | 'turn';
  sessionId?: string;
  disabled?: boolean;
  proposedCap?: number | null;
  channelName?: string;
  prices: Prices;
  perShortCap: number | null;
  initial: { video_type: VisualFormat; motion: MotionLevel; pace: VoicePace };
  /** The left column: the conversation on a session, recent sessions on Create. */
  left?: React.ReactNode;
}

function Send({ label, busy, disabled }: { label: string; busy: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="pbtn" disabled={pending || disabled}>
      {pending ? busy : label}
    </button>
  );
}

/** Dictation through the Web Speech API where the browser has it; nothing at all where it does not. */
function Mic({ onText }: { onText: (t: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const rec = useRef<{ start: () => void; stop: () => void } | null>(null);
  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    setSupported(!!(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);
  if (!supported) return null;
  const toggle = () => {
    if (on) {
      rec.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition)!;
    const r = new Ctor() as {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>; resultIndex: number }) => void;
      onend: () => void;
      onerror: () => void;
      start: () => void;
      stop: () => void;
    };
    r.lang = 'en-IN';
    r.interimResults = false;
    r.continuous = true;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i]!.isFinal) onText(e.results[i]![0]!.transcript.trim());
    };
    r.onend = () => setOn(false);
    r.onerror = () => setOn(false);
    rec.current = r;
    r.start();
    setOn(true);
  };
  return (
    <button type="button" className={`ibtn sm${on ? ' on' : ''}`} aria-label={on ? 'Stop dictating' : 'Dictate'} aria-pressed={on} onClick={toggle}>
      <Icon name="voices" />
    </button>
  );
}

export function StudioPanel(props: StudioPanelProps) {
  const { mode, prices, perShortCap } = props;
  const router = useRouter();
  const action = mode === 'start' ? startSessionAction : sendTurnAction.bind(null, props.sessionId ?? '');
  const [state, formAction] = useActionState(action, IDLE);
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [type, setType] = useState<VisualFormat>(props.initial.video_type);
  const [motion, setMotion] = useState<MotionLevel>(props.initial.motion);
  const [pace, setPace] = useState<VoicePace>(props.initial.pace);
  const [dirty, setDirty] = useState(mode === 'start');
  const [open, setOpen] = useState({ type: true, motion: true, voice: false });
  const [ideas, setIdeas] = useState<IdeasState>({ status: 'idle' });
  const [thinking, startIdeas] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (mode === 'start' && state.sessionId) router.push(`/studio/${state.sessionId}`);
    if (mode === 'turn' && state.status === 'ok') {
      setText('');
      setDirty(false);
    }
  }, [state, mode, router]);

  const pick = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };
  const price = prices ? (type === 'engineered' && prices.motions ? prices.motions[motion] : prices.types[type].inr) : null;
  const share = price !== null && perShortCap ? price / perShortCap : null;
  const over = price !== null && perShortCap !== null && price > perShortCap;
  const capNote = !prices
    ? 'Priced once a brief is drafted — every type, against this channel’s per-Short cap.'
    : price === null
      ? (prices.types[type].note ?? 'This type could not be priced for this brief.')
      : perShortCap === null
        ? 'No per-Short cap is set for this channel.'
        : over
          ? 'Over this video’s cap — switch to Key motion or another type.'
          : `₹${Math.round(perShortCap - price)} left under this video’s cap`;

  const settings = (
    <aside className="gp studio-set" aria-label="Video settings">
      <div className="row sb" style={{ marginBottom: 4 }}>
        <h2 className="h3">Video settings</h2>
        <span className="mono xs t3">{mode === 'start' ? 'sent with the brief' : dirty ? 'sent with your next message' : 'this session'}</span>
      </div>
      <div className="gsec">
        <button type="button" className="gsech" aria-expanded={open.type} onClick={() => setOpen((o) => ({ ...o, type: !o.type }))}>
          <span>Video type</span>
          <Icon name="down" />
        </button>
        {open.type && (
          <div className="vtiles" role="radiogroup" aria-label="Video type">
            {VISUAL_FORMATS.map((f) => {
              const p = prices?.types[f];
              return (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={type === f}
                  className={`vtile${type === f ? ' on' : ''}`}
                  disabled={!!p?.disabled}
                  title={p?.disabled ?? `${FORMAT_INFO[f].label} — ${FORMAT_INFO[f].blurb}`}
                  onClick={() => pick(setType)(f)}
                >
                  <Icon name={TYPE_ICON[f]} />
                  {TYPE_SHORT[f]}
                  <span className="mono vp">{p ? (p.inr === null ? '—' : `₹${Math.round(p.inr)}`) : ''}</span>
                </button>
              );
            })}
          </div>
        )}
        <p className="xs t3" style={{ marginTop: 8 }}>
          {FORMAT_INFO[type].label} — {FORMAT_INFO[type].blurb}.
        </p>
      </div>
      <div className="gsec">
        <button type="button" className="gsech" aria-expanded={open.motion} onClick={() => setOpen((o) => ({ ...o, motion: !o.motion }))}>
          <span>Motion</span>
          <Icon name="down" />
        </button>
        {open.motion && (
          <div className="row sb" style={{ marginTop: 10 }}>
            <div className="seg" role="group" aria-label="Motion">
              {MOTION_LEVELS.map((m) => (
                <button key={m} type="button" className={motion === m ? 'on' : undefined} aria-pressed={motion === m} onClick={() => pick(setMotion)(m)}>
                  {m === 'key' ? 'Key' : 'Full'}
                </button>
              ))}
            </div>
            <span className="xs t3">{type !== 'engineered' ? 'applies to the 3D explainer' : motion === 'full' ? 'clips on most beats' : 'clips on the action beats'}</span>
          </div>
        )}
      </div>
      <div className="gsec">
        <button type="button" className="gsech" aria-expanded={open.voice} onClick={() => setOpen((o) => ({ ...o, voice: !o.voice }))}>
          <span>Voice pace</span>
          <Icon name="down" />
        </button>
        {open.voice && (
          <div className="col" style={{ gap: 8, marginTop: 10 }}>
            <div className="seg" role="group" aria-label="Voice pace" style={{ alignSelf: 'flex-start' }}>
              {(['normal', 'brisk', 'fast'] as const).map((p) => (
                <button key={p} type="button" className={pace === p ? 'on' : undefined} aria-pressed={pace === p} onClick={() => pick(setPace)(p)}>
                  {PACE_INFO[p].label}
                </button>
              ))}
            </div>
            <span className="xs t3">{PACE_INFO[pace].blurb}. The channel’s narrator stays locked.</span>
          </div>
        )}
      </div>
      <div className="gsec" style={{ paddingBottom: 0 }}>
        <div className="row sb">
          <span className="h3">Cap</span>
          <span className="mono sm">
            {price === null ? '—' : `₹${Math.round(price)}`} <span className="t3">{perShortCap === null ? 'no cap' : `of ₹${Math.round(perShortCap)}`}</span>
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <Gauge share={share} label={price === null ? 'Not priced yet' : `₹${Math.round(price)} of the per-Short cap`} />
        </div>
        <span className="xs" style={{ display: 'block', marginTop: 8, color: over ? 'var(--s-rev-text)' : 'var(--t3)' }}>
          {capNote}
        </span>
      </div>
    </aside>
  );

  return (
    <div className="studio">
      {props.left && <div className="studio-left">{props.left}</div>}
      <div className="studio-mid">
        {ideas.status === 'error' && ideas.message && (
          <p className="xs" role="alert" style={{ color: 'var(--blk-text)' }}>
            {ideas.message}
          </p>
        )}
        {ideas.status === 'ok' && ideas.ideas && (
          <section className="studio-ideas" aria-label="Ideas from trends">
            {ideas.ideas.map((i, n) => (
              <article key={n} className="gp idea">
                <div className="row sb" style={{ flexWrap: 'nowrap' }}>
                  <span className="lb" style={{ color: 'var(--t2)' }}>
                    {i.seriesName}
                  </span>
                  {i.relevance !== null && <span className="rel">{i.relevance.toFixed(2)}</span>}
                </div>
                <span className="sm" style={{ fontWeight: 500 }}>
                  {i.topic}
                </span>
                <span className="xs t3" style={{ lineHeight: 1.35 }}>
                  “{i.hook}”
                </span>
                <button
                  type="button"
                  className="gbtn sm"
                  style={{ alignSelf: 'flex-start', marginTop: 2 }}
                  onClick={() => {
                    setText(i.prompt);
                    setType(i.videoType);
                    if (i.motion) setMotion(i.motion);
                    setDirty(true);
                    box.current?.focus();
                  }}
                >
                  Use this idea
                </button>
              </article>
            ))}
          </section>
        )}

        <form ref={formRef} action={formAction} className="gp studio-prompt">
          <label htmlFor="studio-box" className="lb" style={{ color: 'var(--t2)' }}>
            {mode === 'start' ? 'What do you want to make?' : 'Say what to change, or ask what is possible'}
          </label>
          <textarea
            id="studio-box"
            ref={box}
            name={mode === 'start' ? 'brief' : 'text'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            rows={focus || text.split('\n').length > 3 ? Math.min(12, Math.max(5, text.split('\n').length + 1)) : 3}
            required={mode === 'turn'}
            disabled={props.disabled}
            placeholder={mode === 'start' ? 'e.g. Show what’s packed inside the arm of camera smart glasses — part by part, ending on why they get warm.' : 'e.g. Draft it as a 3D explainer, full motion.'}
          />
          {dirty && (
            <>
              <input type="hidden" name="video_type" value={type} />
              <input type="hidden" name="motion" value={motion} />
              <input type="hidden" name="pace" value={pace} />
            </>
          )}
          <div className="row sb" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 6 }}>
              <Mic onText={(t) => setText((v) => (v ? `${v} ${t}` : t))} />
              <button
                type="button"
                className="gbtn sm"
                disabled={thinking || props.disabled}
                title={`Five ideas for ${props.channelName ?? 'this channel'} from its most relevant trends — one cheap call, nothing drafted`}
                onClick={() =>
                  startIdeas(async () => {
                    setIdeas({ status: 'idle' });
                    setIdeas(await studioIdeasAction());
                  })
                }
              >
                <Icon name="trend" size={14} />
                {thinking ? 'Finding ideas…' : 'Ideas from trends'}
              </button>
              {mode === 'start' && (
                <label className="row studio-cap" style={{ gap: 6 }} title="The session stops accepting turns at this spend. Nothing is rolled back.">
                  <span className="xs t3">Session cap ₹</span>
                  <input name="spend_cap_inr" type="number" min={1} step={1} defaultValue={props.proposedCap ?? undefined} required className="input mono" />
                </label>
              )}
            </div>
            {mode === 'start' ? (
              <Send label={text.trim() ? 'Draft brief · ₹4–8' : 'Open session'} busy={text.trim() ? 'Opening and drafting…' : 'Opening…'} />
            ) : (
              <Send label="Send" busy="Thinking…" disabled={props.disabled} />
            )}
          </div>
          {state.status !== 'idle' && state.message && (
            <p className="xs" role="status" style={{ color: state.status === 'ok' ? 'var(--t2)' : 'var(--blk-text)' }}>
              {state.message}
            </p>
          )}
          {props.disabled && <p className="xs t3">This session has stopped. Open a new one to keep working — the conversation stays as it is.</p>}
        </form>
      </div>
      {settings}
    </div>
  );
}
