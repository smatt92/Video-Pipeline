import Link from 'next/link';
import type { ReactNode } from 'react';

import { episodeState, Pill } from './tags';

/**
 * Run progress and the episode card (canvas: BrandApplied "Stat tile · firing", Components →
 * Episode card, BrandMotion).
 *
 * Witness cones replace the 4-segment bar on cards: a kiln shows heat work with cones that
 * stand, glow while firing, bend when the temperature is reached — and slump when the firing
 * went wrong. Stand → glow → bend; slump when blocked. The flat bar stays for tables and tight
 * rows, where four cones would not fit.
 */

export type ConeState = 'idle' | 'act' | 'done' | 'blk';
export const RUN_STAGES = ['script', 'voice', 'shots', 'cut'] as const;
export type RunStage = (typeof RUN_STAGES)[number];

const STAND = 'M6 26L10 4l4 22z';
const BENT = 'M6 26C7 18 8 12 11 9c2-2 5-2 6 0-2 1-4 3-3 17z';
const SLUMP = 'M5 26c1-4 5-6 11-5 2 .5 2 2 0 2l-2 3z';

/** Which stage an episode status sits in. Stage 6 (voice) runs before 5 (video) — see CLAUDE.md. */
const STATUS_STAGE: Record<string, number> = {
  queued: -1,
  scripting: 0,
  shotlisting: 0,
  estimating: 0,
  voicing: 1,
  generating: 2,
  qc: 2,
  assembling: 3,
};
const DONE_STATUSES = new Set(['awaiting_cut', 'cut_approved', 'cut_rejected', 'bundled', 'scheduled', 'live']);

/**
 * Cone states for an episode. A failed or halted run slumps at `stoppedAt` when the caller
 * knows where it stopped (the last stage it was seen in), and at the first unfinished stage
 * otherwise. `running` false on an in-flight status means nothing is moving it: that cone is
 * drawn standing, not glowing — glow is reserved for heat actually being applied.
 */
export function runCones(status: string, opts: { stoppedAt?: string | null; running?: boolean } = {}): ConeState[] {
  if (DONE_STATUSES.has(status)) return ['done', 'done', 'done', 'done'];
  if (status === 'failed' || status === 'halted') {
    const at = opts.stoppedAt && opts.stoppedAt in STATUS_STAGE ? Math.max(0, STATUS_STAGE[opts.stoppedAt]!) : 0;
    return RUN_STAGES.map((_, i) => (i < at ? 'done' : i === at ? 'blk' : 'idle'));
  }
  const at = STATUS_STAGE[status] ?? -1;
  return RUN_STAGES.map((_, i) => (i < at ? 'done' : i === at ? (opts.running === false ? 'idle' : 'act') : 'idle'));
}

export function Cone({ state, label }: { state: ConeState; label?: string }) {
  const d = state === 'done' ? BENT : state === 'blk' ? SLUMP : STAND;
  return (
    <div className={`cone${state === 'idle' ? '' : ` ${state}`}`}>
      <svg viewBox="0 0 20 28" aria-hidden="true">
        <path className="c" d={d} />
        <rect className="base" x="2" y="26" width="16" height="2" rx="1" />
      </svg>
      {label && <span>{label}</span>}
    </div>
  );
}

const CONE_WORD: Record<ConeState, string> = { idle: 'not started', act: 'firing', done: 'done', blk: 'blocked' };

export function Cones({ states, right }: { states: readonly ConeState[]; right?: ReactNode }) {
  const summary = RUN_STAGES.map((s, i) => `${s} ${CONE_WORD[states[i] ?? 'idle']}`).join(', ');
  return (
    <div className="cones" role="img" aria-label={`Run progress: ${summary}`}>
      {RUN_STAGES.map((s, i) => (
        <Cone key={s} state={states[i] ?? 'idle'} label={s} />
      ))}
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  );
}

/** The flat 4-segment bar, for tables and tight rows. */
export function FlatStages({ states }: { states: readonly ConeState[] }) {
  const summary = RUN_STAGES.map((s, i) => `${s} ${CONE_WORD[states[i] ?? 'idle']}`).join(', ');
  return (
    <div className="stages" role="img" aria-label={`Run progress: ${summary}`} style={{ minWidth: 72 }}>
      {RUN_STAGES.map((s, i) => {
        const st = states[i] ?? 'idle';
        return <span key={s} className={st === 'done' ? 'd' : st === 'act' ? 'a' : st === 'blk' ? 'x' : undefined} />;
      })}
    </div>
  );
}

/**
 * Shared SVG gradients for `.can` and the 3D objects. kiln.css fills `.can .body` with
 * `url(#kC)`, so these ids must exist once per document; the app shell renders this.
 */
export function SceneDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="kC" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" className="c1" />
          <stop offset=".35" className="c2" />
          <stop offset=".7" className="c3" />
          <stop offset="1" className="c4" />
        </linearGradient>
        <radialGradient id="kCt" cx=".4" cy=".35" r=".8">
          <stop offset="0" className="c5" />
          <stop offset="1" className="c6" />
        </radialGradient>
      </defs>
    </svg>
  );
}

/** The film canister — one per episode; the band is the episode's state colour. */
export function Canister({ tone, size = 60 }: { tone: string; size?: number }) {
  return (
    <svg className={`can s-${tone}`} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <ellipse cx="32" cy="55" rx="22" ry="5" className="can-shadow" />
      <path className="body e" d="M12 20V47A20 7 0 0 0 52 47V20" />
      <path className="band" d="M12 30V37A20 7 0 0 0 52 37V30A20 7 0 0 1 12 30Z" />
      <ellipse className="top e" cx="32" cy="20" rx="20" ry="7" />
      <circle className="hole" cx="23" cy="19.5" r="2" />
      <circle className="hole" cx="41" cy="19.5" r="2" />
      <circle className="hole" cx="32" cy="16" r="1.6" />
      <circle className="hole" cx="32" cy="23.5" r="1.6" />
      <circle className="hub" cx="32" cy="20" r="2.4" />
    </svg>
  );
}

/**
 * Episode card (Home, Board). Everything here is passed in from rows; the card decides nothing
 * except how it looks. `blocker` is one sentence and one action, already built by the caller.
 */
export function EpisodeCard({
  slot,
  title,
  status,
  statusDetail,
  cones,
  cast,
  href,
  blocker,
  footer,
}: {
  slot: string;
  title: string;
  status: string;
  statusDetail?: string | null;
  cones: readonly ConeState[];
  cast?: ReactNode;
  href?: string | null;
  blocker?: ReactNode;
  footer?: ReactNode;
}) {
  const st = episodeState(status);
  const tone = cones.includes('blk') ? 'blk' : st.tone;
  return (
    <article className="card card-b col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 14, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <Canister tone={tone} />
        <div className="col grow" style={{ gap: 6 }}>
          <div className="row sb">
            {href ? (
              <Link href={href} className="mono" style={{ fontWeight: 600, color: 'var(--t1)', textDecoration: 'none' }}>
                {slot}
              </Link>
            ) : (
              <span className="mono" style={{ fontWeight: 600 }}>
                {slot}
              </span>
            )}
            <Pill tone={tone}>{statusDetail ? `${st.label} · ${statusDetail}` : st.label}</Pill>
          </div>
          <span className="sm">{title}</span>
          {cast && <div className="row" style={{ gap: 6 }}>{cast}</div>}
        </div>
      </div>
      <Cones states={cones} />
      {blocker}
      {footer}
    </article>
  );
}
