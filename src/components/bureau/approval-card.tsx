'use client';

import { useRef, useState, useTransition } from 'react';

import { approveBriefAction, rejectBriefAction } from '@/lib/bureau/ui-actions';

export interface ApprovalBrief {
  id: string;
  n: number;
  slotId: string | null;
  slotDate: string | null;
  series: string;
  lead: string;
  leadName: string;
  leadAccent: string;
  premise: string;
  punchlines: string[];
  fact: { claim: string; source_url: string };
  estimateInr: number | null;
  flagged: boolean;
  flagReasons: string[];
  variation: string;
  policy: string;
}

/**
 * One brief, phone-first. Keys when the card has focus: A / B / C pick a punchline, F jumps
 * to "write my own", Enter approves the pick, K or R rejects (asks for a reason).
 */
export function ApprovalCard({ brief, autoFocus }: { brief: ApprovalBrief; autoFocus?: boolean }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [premise, setPremise] = useState(brief.premise);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const customRef = useRef<HTMLInputElement>(null);

  const picked = custom.trim() ? custom.trim() : choice;
  const approve = () =>
    picked &&
    start(async () => {
      const r = await approveBriefAction(brief.id, picked, premise !== brief.premise ? premise : undefined);
      setMessage({ ok: r.ok, text: r.message });
    });
  const reject = () => {
    const reason = window.prompt('Why reject this brief? (logged verbatim)');
    if (!reason) return;
    start(async () => {
      const r = await rejectBriefAction(brief.id, reason);
      setMessage({ ok: r.ok, text: r.message });
    });
  };

  return (
    <article
      tabIndex={0}
      autoFocus={autoFocus}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        const k = e.key.toLowerCase();
        if (['a', 'b', 'c'].includes(k)) setChoice(k.toUpperCase());
        else if (k === 'f') {
          e.preventDefault();
          customRef.current?.focus();
        } else if (k === 'enter') approve();
        else if (k === 'k' || k === 'r') reject();
      }}
      className="rounded-md border p-4 outline-none focus-visible:ring-2"
      style={{ borderColor: 'var(--border-default)', background: 'var(--surface-1)' }}
    >
      <header className="flex flex-wrap items-center gap-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
        <span className="font-mono">#{brief.n}</span>
        <span className="font-mono">{brief.slotDate ?? 'bank'}</span>
        <span className="rounded px-1.5 py-0.5" style={{ background: 'var(--surface-2)' }}>{brief.series}</span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: brief.leadAccent }} />
          {brief.leadName}
        </span>
        <span className="ml-auto font-mono tabular-nums">{brief.estimateInr === null ? 'unpriced' : `₹${brief.estimateInr.toFixed(0)}`}</span>
      </header>

      <textarea
        value={premise}
        onChange={(e) => setPremise(e.target.value)}
        rows={2}
        className="mt-2 w-full resize-none bg-transparent text-md font-medium leading-snug"
        aria-label="Premise (edit before approving)"
      />

      <div className="mt-3 grid gap-2">
        {brief.punchlines.map((p, i) => {
          const letter = 'ABC'[i];
          const on = choice === letter && !custom.trim();
          return (
            <button
              key={letter}
              type="button"
              onClick={() => setChoice(letter)}
              className="min-h-11 rounded-md border px-3 py-2 text-left text-sm"
              style={{ borderColor: on ? 'var(--accent)' : 'var(--border-default)', background: on ? 'var(--accent-muted)' : 'transparent' }}
            >
              <span className="mr-2 font-mono">{letter}</span>
              {p}
            </button>
          );
        })}
        <input
          ref={customRef}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="F — write my own punchline"
          className="min-h-11 rounded-md border bg-transparent px-3 text-sm"
          style={{ borderColor: 'var(--border-default)' }}
        />
      </div>

      <p className="mt-3 text-2xs" style={{ color: 'var(--text-muted)' }}>
        {brief.fact.claim}{' '}
        <a href={brief.fact.source_url} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>
          source
        </a>
      </p>
      <p className="mt-1 text-2xs" style={{ color: brief.flagged ? 'var(--state-blocked)' : 'var(--text-faint)' }}>
        variation {brief.variation} · policy {brief.policy}
        {brief.flagged ? ` · flagged: ${brief.flagReasons.join(', ')}` : ''}
      </p>

      <div className="mt-3 flex gap-2">
        <button type="button" disabled={!picked || pending} onClick={approve} className="min-h-11 flex-1 rounded-md px-3 text-sm font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)', opacity: !picked || pending ? 0.5 : 1 }}>
          {pending ? 'Working…' : picked ? `Approve with ${custom.trim() ? 'my line' : picked}` : 'Pick a punchline'}
        </button>
        <button type="button" disabled={pending} onClick={reject} className="min-h-11 rounded-md border px-3 text-sm" style={{ borderColor: 'var(--border-default)' }}>
          Reject
        </button>
      </div>
      {message && <p className="mt-2 text-sm" style={{ color: message.ok ? 'var(--text-secondary)' : 'var(--danger)' }}>{message.text}</p>}
    </article>
  );
}
