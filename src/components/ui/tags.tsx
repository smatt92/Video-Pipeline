import type { CSSProperties, ReactNode } from 'react';

import { Icon } from './icon';

/**
 * The small marks (canvas: Components → Chips, pills, tags). Three shapes, three meanings,
 * never mixed: a ROUND dot is a pipeline state, a SQUARE is a channel, a SPHERE is a cast
 * member.
 */

export type StateTone = 'draft' | 'gen' | 'rev' | 'blk' | 'rdy' | 'live' | 'ac';

export function Pill({ tone, children, dot = true, className = '' }: { tone: StateTone; children: ReactNode; dot?: boolean; className?: string }) {
  return <span className={`pill s-${tone}${dot ? '' : ' nodot'} ${className}`.trim()}>{children}</span>;
}

/**
 * Episode status → the state it shows. The words are the operator's, not the enum's: a row
 * in `awaiting_cut` "needs cut review", and `halted` is blocked, because both need a person.
 */
const EPISODE_STATE: Record<string, { tone: StateTone; label: string }> = {
  queued: { tone: 'draft', label: 'Queued' },
  scripting: { tone: 'gen', label: 'Scripting' },
  shotlisting: { tone: 'gen', label: 'Shot-listing' },
  estimating: { tone: 'gen', label: 'Estimating' },
  voicing: { tone: 'gen', label: 'Voicing' },
  generating: { tone: 'gen', label: 'Generating' },
  qc: { tone: 'gen', label: 'Checking' },
  assembling: { tone: 'gen', label: 'Assembling' },
  awaiting_cut: { tone: 'rev', label: 'Needs cut review' },
  cut_approved: { tone: 'rdy', label: 'Cut approved' },
  cut_rejected: { tone: 'blk', label: 'Sent back' },
  bundled: { tone: 'rdy', label: 'Ready' },
  scheduled: { tone: 'rdy', label: 'Scheduled' },
  live: { tone: 'live', label: 'Live' },
  failed: { tone: 'blk', label: 'Failed' },
  halted: { tone: 'blk', label: 'Halted' },
};

export function episodeState(status: string): { tone: StateTone; label: string } {
  return EPISODE_STATE[status] ?? { tone: 'draft', label: status.replace(/_/g, ' ') };
}

export function EpisodeStatePill({ status, detail }: { status: string; detail?: string | null }) {
  const s = episodeState(status);
  return <Pill tone={s.tone}>{detail ? `${s.label} · ${detail}` : s.label}</Pill>;
}

/** Every ₹ figure carries one: was it measured (a balance moved), or is it ours? */
export function Basis({ kind, short }: { kind: 'est' | 'meas'; short?: boolean }) {
  return <span className={`basis ${kind}`}>{kind === 'est' ? (short ? 'est' : 'estimate') : short ? 'meas' : 'measured'}</span>;
}

/** A gate result — pass, fail, or not yet measurable (—). */
export function Gate({ state, children }: { state: 'pass' | 'fail' | 'unknown'; children: ReactNode }) {
  return <span className={`gate${state === 'unknown' ? '' : ` ${state}`}`}>{children}</span>;
}

/** Channel square. `color` is the channel's accent, passed as a token or a bible value. */
export function ChannelMark({ color }: { color?: string }) {
  return <span className="chm" aria-hidden="true" style={color ? ({ '--ch': color } as CSSProperties) : undefined} />;
}

const CAST_CLASS: Record<string, string> = {
  pip: 'c-pip',
  marlo: 'c-marlo',
  iyer: 'c-iyer',
  nib: 'c-nib',
  kaz: 'c-kaz',
  ohm: 'c-ohm',
  box: 'c-box',
  auditor: 'c-aud',
  aud: 'c-aud',
};

/**
 * Cast chip — the sphere is the cast member. A Bureau slug gets its canvas class; another
 * channel's cast passes `accent` from its bible, which is data rather than a design literal.
 */
export function CastChip({ slug, name, accent, lead }: { slug: string; name: string; accent?: string; lead?: boolean }) {
  const key = slug.toLowerCase().replace(/^the-/, '');
  const cls = CAST_CLASS[key];
  return (
    <span className={`cast ${cls ?? ''}`.trim()} style={!cls && accent ? ({ '--c': accent } as CSSProperties) : undefined}>
      <i aria-hidden="true" />
      {name}
      {lead && <em>LEAD</em>}
    </span>
  );
}

export function Chip({ on, children }: { on?: boolean; children: ReactNode }) {
  return <span className={`chip${on ? ' on' : ''}`}>{children}</span>;
}

/** Seasonal tag (Diwali, Dussehra…). */
export function Stag({ children }: { children: ReactNode }) {
  return <span className="stag">{children}</span>;
}

export function LockTag({ children }: { children: ReactNode }) {
  return (
    <span className="lock">
      <Icon name="lock" size={12} />
      {children}
    </span>
  );
}

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`lbl ${className}`.trim()}>{children}</span>;
}
