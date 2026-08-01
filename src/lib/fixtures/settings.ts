import {
  INTEGRATION_CATALOG,
  SEED_RATES,
  type IntegrationDescriptor,
} from '@/lib/drivers/catalog';

/**
 * Fixture *state* for settings and onboarding.
 *
 * Note what is no longer here: vendor names. Which vendors exist and what their fields
 * are called comes from `src/lib/drivers/catalog.ts`, the one directory permitted to know
 * that. This module holds only the mutable half — configured, verified, last four — which
 * in production is the `integrations` table.
 *
 * ⚠️  None of it has been verified. The build environment has no network route to any
 * vendor; every host is refused at the egress policy. Every timestamp below is null
 * because nothing has run, and that is the honest state rather than a placeholder.
 */

export interface IntegrationState {
  readonly last4: Readonly<Record<string, string | null>>;
  readonly configuredAt: string | null;
  readonly isEnabled: boolean;
  readonly lastVerifiedAt: string | null;
  readonly lastError: string | null;
  /** Per check name. null = never run, which is a third state and not a failure. */
  readonly checkResults: Readonly<Record<string, boolean | null>>;
  /** Read from the account during verification. */
  readonly planTier: string | null;
  readonly creditBalance: number | null;
  readonly creditsExpireAt: string | null;
}

const UNCONFIGURED: IntegrationState = {
  last4: {},
  configuredAt: null,
  isEnabled: false,
  lastVerifiedAt: null,
  lastError: null,
  checkResults: {},
  planTier: null,
  creditBalance: null,
  creditsExpireAt: null,
};

export const INTEGRATION_STATE: Readonly<Record<string, IntegrationState>> =
  Object.fromEntries(INTEGRATION_CATALOG.map((i) => [i.slug, UNCONFIGURED]));

export interface IntegrationView {
  readonly descriptor: IntegrationDescriptor;
  readonly state: IntegrationState;
}

export const INTEGRATIONS: readonly IntegrationView[] = INTEGRATION_CATALOG.map((d) => ({
  descriptor: d,
  state: INTEGRATION_STATE[d.slug] ?? UNCONFIGURED,
}));

/** Has the integration this one depends on actually verified? */
export function blockingDependency(view: IntegrationView): string | null {
  const dep = view.descriptor.dependsOn;
  if (!dep) return null;
  const target = INTEGRATIONS.find((i) => i.descriptor.slug === dep);
  if (!target) return null;
  return target.state.lastVerifiedAt ? null : target.descriptor.label;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate card
// ─────────────────────────────────────────────────────────────────────────────

export interface RateRow {
  readonly driver: string;
  readonly driverLabel: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly unit: string;
  /** null, not zero. No vendor publishes these; they are read off an invoice. */
  readonly unitCost: number | null;
  readonly isVerified: boolean;
  readonly sourceNote: string;
}

export const RATE_CARD: readonly RateRow[] = SEED_RATES.map((r) => ({
  ...r,
  unitCost: null,
  isVerified: false,
  sourceNote: 'placeholder seeded during scaffold — replace with an observed cost',
}));

// ─────────────────────────────────────────────────────────────────────────────
// Guardrails
// ─────────────────────────────────────────────────────────────────────────────

export interface Guardrail {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly enforcedAt: string;
  readonly help: string;
}

export const GUARDRAILS: readonly Guardrail[] = [
  {
    key: 'spend_cap_session_inr',
    label: 'Spend cap — per Studio session',
    value: 500,
    unit: '₹',
    enforcedAt: 'studio_sessions.spend_cap_inr',
    help: 'An agent loop with tool access can burn a lot on one bad turn. Status flips to capped rather than continuing.',
  },
  {
    key: 'spend_cap_day_inr',
    label: 'Spend cap — per day',
    value: 2000,
    unit: '₹',
    enforcedAt: 'submit path, summed from cost_ledger',
    help: 'Counted from the estimate rows written at submit, so it holds even while results are still outstanding.',
  },
  {
    key: 'spend_cap_month_inr',
    label: 'Spend cap — per month',
    value: 25000,
    unit: '₹',
    enforcedAt: 'submit path, summed from cost_ledger',
    help: '',
  },
  {
    key: 'concurrency_video',
    label: 'Concurrency — video driver',
    value: null,
    unit: 'jobs',
    enforcedAt: 'Trigger task concurrency limit',
    help: 'Unknown until that integration verifies. An unknown ceiling must not be guessed — a guess above the real one produces a permanent failure rate that reads as vendor flakiness.',
  },
  {
    key: 'concurrency_audio',
    label: 'Concurrency — audio driver',
    value: null,
    unit: 'requests',
    enforcedAt: 'read from the integration record at run time',
    help: 'Comes from the plan tier. Never hardcoded.',
  },
  {
    key: 'circuit_breaker_threshold',
    label: 'Circuit breaker — consecutive failures',
    value: 5,
    unit: 'failures',
    enforcedAt: 'driver_health.consecutive_failures',
    help: 'A row, not an in-process counter — fan-out spans containers, and an in-memory count breaks per worker and resets on deploy.',
  },
  {
    key: 'circuit_breaker_cooldown_ms',
    label: 'Circuit breaker — cooldown',
    value: 60000,
    unit: 'ms',
    enforcedAt: 'driver_health.reopen_after',
    help: 'How long the breaker stays open before one probe is allowed through.',
  },
  {
    key: 'max_shots_per_video',
    label: 'Max shots per video',
    value: 12,
    unit: 'shots',
    enforcedAt: 'shotlist compile',
    help: 'A runaway shotlist is the most expensive bug this pipeline can have.',
  },
  {
    key: 'max_shot_duration_s',
    label: 'Max shot duration',
    value: 5,
    unit: 's',
    enforcedAt: 'shot split, after durations are derived from the voiceover',
    help: 'A ceiling, not a target. Durations come from real speech; a beat that runs long is split across shots rather than held on one clip.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Voice
// ─────────────────────────────────────────────────────────────────────────────

export interface Pronunciation {
  readonly grapheme: string;
  readonly kind: 'alias' | 'phoneme';
  readonly replacement: string;
  readonly alphabet: 'cmu' | 'ipa' | null;
  readonly note: string;
}

export const PRONUNCIATIONS: readonly Pronunciation[] = [
  { grapheme: 'GTA', kind: 'alias', replacement: 'G T A', alphabet: null, note: 'Read as letters' },
  { grapheme: 'Rockstar', kind: 'alias', replacement: 'Rock Star', alphabet: null, note: '' },
  { grapheme: 'Bengaluru', kind: 'phoneme', replacement: 'B EH1 NG AH0 L UH1 R UH0', alphabet: 'cmu', note: 'CMU is more predictable than IPA' },
  { grapheme: 'Kochi', kind: 'phoneme', replacement: 'K OW1 CH IY0', alphabet: 'cmu', note: '' },
];

export const VOICE_SETTINGS = {
  hostVoice: null as string | null,
  normalization: 'auto' as 'auto' | 'on' | 'off',
  chunkWords: 350,
  maxDictionaryLocators: 3,
};
