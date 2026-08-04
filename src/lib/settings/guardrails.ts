import { MAX_SHOTS_PER_SHOTLIST } from '../shots/schema';

/**
 * The guardrail register.
 *
 * This replaces `GUARDRAILS` in `src/lib/fixtures/settings.ts`, which was the last screen
 * reading a fixture — and it was not merely unwired, it was *wrong*. It displayed 12 as the
 * maximum shots per video while `ShotlistSchema` rejected anything over 8, and it displayed
 * a ₹2,000 daily cap and a ₹25,000 monthly cap that nothing anywhere sums, reads, or
 * enforces. Eight rows rendered identically and exactly one of them — the per-session Studio
 * cap — was real.
 *
 * That is the failure mode this screen is *supposed to prevent*, occurring on the screen
 * itself: a display that is wrong is worse than a control that is absent, because an absent
 * control is visibly absent and a wrong number is believed. So the register is built so the
 * two classes of lie are both structurally impossible:
 *
 *  - **A number that disagrees with the enforcer.** Every `kind: 'code'` row takes its value
 *    from the enforcing module's own exported constant. Not a copy kept in step by
 *    discipline — the same binding. `check:guardrails` rejects a numeric literal on a
 *    `code` row, so the next person cannot quietly reintroduce the copy.
 *
 *  - **A number for something nothing enforces.** `kind: 'none'` has no value field at all;
 *    the type will not carry one. It renders as "not enforced", never as a figure, and
 *    never as 0 — this is the absent-versus-zero rule on a screen whose whole job is to say
 *    which controls are live.
 *
 * `kind: 'runtime'` is the third state and the reason two states were not enough: the audio
 * driver's concurrency ceiling *is* enforced, by `06-voice.ts` reading
 * `integrations.concurrency_limit` on every run, but its value is not knowable at build
 * time and must not be guessed. Enforced-but-unknown and not-enforced are different facts.
 */

export type Guardrail = {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
} & (
  | {
      /** Enforced by a constant in application code. `value` IS that constant. */
      readonly kind: 'code';
      readonly value: number;
      readonly site: string;
      readonly help: string;
    }
  | {
      /** Enforced by a column, constraint or trigger. `value` is the default we propose. */
      readonly kind: 'db';
      readonly value: number;
      readonly site: string;
      readonly help: string;
    }
  | {
      /** Enforced, but the ceiling is read from a row at run time. Never a number here. */
      readonly kind: 'runtime';
      readonly site: string;
      readonly help: string;
    }
  | {
      /**
       * Nothing enforces this. No `value` field exists on this branch, by design.
       *
       * `probe` is a regular expression that must find nothing under `src/`. When somebody
       * wires the guardrail, the probe starts matching and `check:guardrails` fails —
       * which is the only way this row ever stops being true, and the point at which the
       * screen would otherwise start under-reporting its own coverage.
       */
      readonly kind: 'none';
      readonly why: string;
      readonly probe: string | null;
    }
);

export const GUARDRAILS: readonly Guardrail[] = [
  {
    key: 'spend_cap_session_inr',
    kind: 'db',
    label: 'Spend cap — per Studio session',
    value: 500,
    unit: '₹',
    site: 'studio_sessions.spend_cap_inr',
    help:
      'The one live row on this screen. `startSessionAction` reads this very entry as the ' +
      'proposed cap, the operator confirms or changes it before the session opens, and the ' +
      'session flips to capped rather than continuing.',
  },
  {
    key: 'spend_cap_day_inr',
    kind: 'none',
    label: 'Spend cap — per day',
    unit: '₹',
    why:
      'No code sums cost_ledger over a window. This row previously showed ₹2,000 and named ' +
      '"the submit path" as its enforcement site; the submit path does not read it. Wiring ' +
      'it means a pre-submit check against a windowed sum, which is a control to build, not ' +
      'a number to display.',
    probe: null,
  },
  {
    key: 'spend_cap_month_inr',
    kind: 'none',
    label: 'Spend cap — per month',
    unit: '₹',
    why: 'Same as the daily cap: no windowed sum exists to check against.',
    probe: null,
  },
  {
    key: 'concurrency_video',
    kind: 'runtime',
    label: 'Concurrency — video driver',
    unit: 'jobs',
    site: 'integrations.concurrency_limit, read by 05-generate',
    help:
      'Comes from the plan tier and is read per run, alongside concurrency_source so the ' +
      'task can log whether the number was a reading or a fallback. An unknown ceiling must ' +
      'not be guessed: a guess above the real one produces a permanent failure rate that ' +
      'reads as vendor flakiness rather than as our own misconfiguration.',
  },
  {
    key: 'concurrency_audio',
    kind: 'runtime',
    label: 'Concurrency — audio driver',
    unit: 'requests',
    site: 'integrations.concurrency_limit, read by 06-voice',
    help: 'Same mechanism as the video driver. Never hardcoded.',
  },
  {
    key: 'circuit_breaker',
    kind: 'none',
    label: 'Circuit breaker — consecutive failures',
    unit: 'failures',
    why:
      'driver_health exists, is seeded with a row per video driver, and has no reader and no ' +
      'writer anywhere in src/ — 0013\'s own comment says so. The threshold and cooldown ' +
      'shown here were 5 and 60000ms against a table nothing consults.',
    probe: 'driver_health',
  },
  {
    key: 'max_shots_per_video',
    kind: 'code',
    label: 'Max shots per video',
    value: MAX_SHOTS_PER_SHOTLIST,
    unit: 'shots',
    site: 'ShotlistSchema — src/lib/shots/schema.ts',
    help:
      'The decode constraint, so an over-long shotlist is rejected before it can cost ' +
      'anything. This screen said 12 while the constraint said 8; it now shows the constraint.',
  },
  {
    key: 'max_shot_duration_s',
    kind: 'none',
    label: 'Max shot duration',
    unit: 's',
    why:
      'Deliberately absent, not merely unbuilt. Durations are derived from real word ' +
      'timings in stage 6, and a hard ceiling applied after that would truncate video ' +
      'against audio that still runs — a desync of exactly the kind that has already ' +
      'shipped three times here. A long beat has to be split at the shotlist, before any ' +
      'timing exists, which is a shotlist-authoring rule and not a numeric cap.',
    probe: null,
  },
];

/** The Studio's proposed per-session cap. The only guardrail with a non-display reader. */
export function sessionSpendCap(): number | null {
  const g = GUARDRAILS.find((x) => x.key === 'spend_cap_session_inr');
  if (!g || (g.kind !== 'db' && g.kind !== 'code')) return null;
  return Number.isFinite(g.value) && g.value > 0 ? g.value : null;
}
