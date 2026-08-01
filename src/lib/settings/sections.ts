/**
 * Settings sections — Addendum 02 §4, plus Supabase from Addendum 03 §1.
 *
 * The organising principle from the addendum: anything that would otherwise become a
 * magic number in code lives here. A concurrency limit, a spend cap, a shot-duration
 * ceiling, an FX rate — every one of those is a value someone will need to change without
 * a deploy, and every one of them is a bug waiting to happen if it is a constant.
 */

export type SectionStatus =
  | { readonly kind: 'live' }
  | { readonly kind: 'scaffolded'; readonly reason: string; readonly phase: string };

export interface SettingsSection {
  readonly slug: string;
  readonly label: string;
  readonly hint: string;
  readonly status: SectionStatus;
}

const live = (): SectionStatus => ({ kind: 'live' });
const scaffolded = (phase: string, reason: string): SectionStatus => ({
  kind: 'scaffolded',
  reason,
  phase,
});

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    slug: 'integrations',
    label: 'Integrations',
    hint: 'Credentials, connection tests, credit balance',
    status: live(),
  },
  {
    slug: 'rate-card',
    label: 'Rate card',
    hint: 'Per driver, per endpoint, per unit — and whether it is verified',
    status: live(),
  },
  {
    slug: 'guardrails',
    label: 'Guardrails',
    hint: 'Spend caps, concurrency, circuit breakers',
    status: live(),
  },
  {
    slug: 'voice',
    label: 'Voice',
    hint: 'Host voice, model per format, pronunciation dictionary',
    status: live(),
  },
  {
    slug: 'supabase',
    label: 'Supabase',
    hint: 'Diagnostic only — connection, migrations, Vault, RLS',
    status: live(),
  },
  {
    slug: 'workspace',
    label: 'Workspace',
    hint: 'Name, timezone, default channel, FX rate',
    status: scaffolded('1a', 'Needs the profiles row that onboarding step 1 creates'),
  },
  {
    slug: 'generation',
    label: 'Generation',
    hint: 'Model per shot type, aspect and duration defaults, seed policy',
    status: scaffolded('1b', 'Needs the driver implementations to enumerate models'),
  },
  {
    slug: 'assembly',
    label: 'Assembly',
    hint: 'Caption styles, safe areas, canonical codec, loudness',
    status: scaffolded('2', 'Assembly phase — nothing renders yet'),
  },
  {
    slug: 'publishing',
    label: 'Publishing',
    hint: 'Schedule windows, rate limits, disclosure defaults',
    status: scaffolded('3', 'Blocked on Meta app review — 2–4 weeks, started week 1'),
  },
  {
    slug: 'danger',
    label: 'Danger zone',
    hint: 'Rotate all keys, purge orphans, reset rate card',
    status: scaffolded('1a', 'Deliberately last — needs the rest to exist before it can destroy it'),
  },
];

export function findSection(slug: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.slug === slug);
}
