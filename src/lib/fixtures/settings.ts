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
