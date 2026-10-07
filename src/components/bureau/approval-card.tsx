'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';

import { PunchlinePicker } from '@/components/ui/punchline-picker';
import type { FormatOption } from '@/lib/bureau/format-estimates';
import { PACE_INFO, type VisualFormat, type VoicePace } from '@/lib/bureau/formats';
import { approveBriefAction, rejectBriefAction } from '@/lib/bureau/ui-actions';

/**
 * The approval desk (canvas: Approvals, Approvals-m). Keys, anywhere on the page outside a
 * text field: A / B / C pick, F writes your own, Enter approves the pick, X (or K) rejects.
 * Approve stays disabled until a punchline is picked — the canvas rule, and the action's own.
 *
 * Same server actions as before the redesign, so approving here and approving in Claude chat
 * call the same function and log the same way. The rejection reason is logged verbatim.
 */

export interface ApprovalBrief {
  id: string;
  slot: string | null;
  premise: string;
  punchlines: string[];
}

const REASONS = ['Punchline doesn’t land', 'Fact needs a stronger source', 'Wrong lead for this series', 'Off-tone for the slot'] as const;

export function ApprovalDesk({
  brief,
  header,
  details,
  decision,
  aside,
  position,
  formats,
  defaultFormat,
  defaultPace,
}: {
  brief: ApprovalBrief;
  /** Server-rendered brief card (slot, busts, title, cast). */
  header: ReactNode;
  /** Server-rendered beat sheet, script, shots, fact, titles. */
  details: ReactNode;
  /** Server-rendered estimate + flags, shown inside the Decision card. */
  decision: ReactNode;
  /** Server-rendered queue. */
  aside: ReactNode;
  position: string;
  /** The visual formats, each priced on this brief (formats.ts). The choice is sent with the approval. */
  formats: FormatOption[];
  defaultFormat: VisualFormat;
  /** The series' voice pace (formats.ts); the approver can change it with the format. */
  defaultPace: VoicePace;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [premise, setPremise] = useState(brief.premise);
  const [format, setFormat] = useState<VisualFormat>(defaultFormat);
  const [pace, setPace] = useState<VoicePace>(defaultPace);
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [reasonText, setReasonText] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const customRef = useRef<HTMLInputElement>(null);
  const rejectRef = useRef<HTMLSelectElement>(null);

  const picked = custom.trim() ? custom.trim() : choice ? brief.punchlines['ABC'.indexOf(choice)] ?? null : null;
  const pickedLabel = custom.trim() ? 'your line' : choice ?? '—';

  const approve = () => {
    if (!picked || pending) return;
    start(async () => {
      const r = await approveBriefAction(brief.id, picked, premise !== brief.premise ? premise : undefined, format, pace);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };
  const reject = () => {
    const why = reasonText.trim() || reason;
    if (!window.confirm(`Reject ${brief.slot ?? 'this brief'}? Reason, logged verbatim: “${why}”`)) return;
    start(async () => {
      const r = await rejectBriefAction(brief.id, why);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (['a', 'b', 'c'].includes(k) && brief.punchlines.length >= 'abc'.indexOf(k) + 1) {
        setCustom('');
        setChoice(k.toUpperCase());
      } else if (k === 'f') {
        e.preventDefault();
        customRef.current?.focus();
      } else if (k === 'enter' && (t === document.body || t.tagName === 'MAIN')) {
        approve();
      } else if (k === 'x' || k === 'k') {
        rejectRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const approveLabel = pending ? 'Working…' : picked ? `Approve with ${custom.trim() ? 'my line' : choice}` : 'Pick a punchline';

  return (
    <div className="split has-sticky">
      <article className="wide">
        {header}
        <section className="card" aria-label="Video type">
          <div className="card-h">
            <h2 className="h3">Video type</h2>
            <span className="xs t3">How every shot is made · priced on this brief</span>
          </div>
          <div className="card-b col" style={{ gap: 8 }} role="radiogroup" aria-label="Video type">
            {formats.map((f) => (
              <button
                key={f.format}
                type="button"
                role="radio"
                aria-checked={format === f.format}
                className={`radio-card${format === f.format ? ' on' : ''}`}
                disabled={pending}
                onClick={() => setFormat(f.format)}
              >
                <span className="col" style={{ gap: 2, flex: 1 }}>
                  <span style={{ fontWeight: 600 }}>
                    {f.label}
                    {f.format === defaultFormat && <span className="xs t3"> · series default</span>}
                  </span>
                  <span className="sm t2">{f.blurb}</span>
                  {f.note && <span className="xs t3">{f.note}</span>}
                </span>
                <span className="mono" style={{ fontWeight: 600 }} title={f.inr === null ? 'Not priced — see the note' : 'Estimate, before the cap fitter'}>
                  {f.inr === null ? '—' : `₹${f.inr.toFixed(0)}`}
                </span>
              </button>
            ))}
            <div className="row sb" style={{ marginTop: 6 }}>
              <span className="sm t2">Voice pace</span>
              <div className="seg" role="radiogroup" aria-label="Voice pace">
                {(Object.keys(PACE_INFO) as VoicePace[]).map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={pace === p} className={pace === p ? 'on' : ''} onClick={() => setPace(p)} disabled={pending}>
                    {PACE_INFO[p].label}
                  </button>
                ))}
              </div>
            </div>
            <span className="xs t3">{PACE_INFO[pace].blurb}{pace === defaultPace ? ' · series default' : ''}. Pace changes no price.</span>
          </div>
        </section>
        <section className="card" aria-label="Pick the punchline">
          <div className="card-h">
            <h2 className="h3">Pick the punchline</h2>
            <span className="xs t3">Approve unlocks once one is picked</span>
          </div>
          <div className="card-b col" style={{ gap: 10 }}>
            <PunchlinePicker
              lines={brief.punchlines}
              picked={custom.trim() ? null : choice}
              onPick={(k) => {
                setCustom('');
                setChoice(k);
              }}
              disabled={pending}
            />
            <div className="field">
              <label htmlFor="own-line">Or write your own</label>
              <input
                id="own-line"
                ref={customRef}
                className="input"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="F — your own punchline"
              />
            </div>
          </div>
        </section>
        {details}
      </article>

      <aside className="side">
        <section className="card" aria-label="Decision">
          <div className="card-h">
            <h2 className="h3">Decision</h2>
            <span className="mono xs t3">{position}</span>
          </div>
          <div className="card-b col" style={{ gap: 14 }}>
            <div className="row sb">
              <span className="sm t2">Video type</span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {formats.find((f) => f.format === format)?.label ?? format} · {PACE_INFO[pace].label}
              </span>
            </div>
            <div className="row sb">
              <span className="sm t2">Punchline</span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {pickedLabel}
              </span>
            </div>
            {decision}
            <div className="field">
              <label htmlFor="premise">Premise — edit before approving</label>
              <textarea id="premise" className="input" rows={3} value={premise} onChange={(e) => setPremise(e.target.value)} />
            </div>
            <button className="btn pri lg full desk-only" type="button" disabled={!picked || pending} onClick={approve}>
              {approveLabel}
            </button>
            <div className="field">
              <label htmlFor="reject-reason">Reject with reason</label>
              <select id="reject-reason" ref={rejectRef} className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <input
                className="input"
                aria-label="Or say why in your own words"
                placeholder="Or in your own words (logged verbatim)"
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
              />
            </div>
            <button className="btn dan full" type="button" disabled={pending} onClick={reject}>
              Reject brief
            </button>
            {message && (
              <p className="sm" role="status" style={{ color: message.ok ? 'var(--t2)' : 'var(--blk-text)' }}>
                {message.text}
              </p>
            )}
            <p className="xs t3 desk-only">
              <span className="kbd">A</span> <span className="kbd">B</span> <span className="kbd">C</span> pick · <span className="kbd">F</span> your own ·{' '}
              <span className="kbd">↵</span> approve · <span className="kbd">X</span> reject
            </p>
          </div>
        </section>
        {aside}
      </aside>

      <div className="sticky-bar">
        <button className="btn lg" type="button" style={{ flex: '0 0 auto' }} onClick={() => rejectRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          Reject
        </button>
        <button className="btn lg pri" type="button" style={{ flex: 1 }} disabled={!picked || pending} onClick={approve}>
          {approveLabel}
        </button>
      </div>
    </div>
  );
}
