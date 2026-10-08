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
// `scaffolded` is kept in the type (SettingsTabs renders it as a disabled tab with its
// reason) for the next section that exists before it works; none does today.

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
    slug: 'mcp',
    label: 'MCP tokens',
    hint: 'Approver and agent tokens for the Kiln connector',
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
    // Live because display scale is real and persisted. The rest of what this section will
    // hold — name, default channel, FX rate — is not built, and the page says so rather
    // than the nav implying it by listing them here.
    hint: 'Display scale, and how Kiln looks on this account',
    status: live(),
  },
  {
    slug: 'appearance',
    label: 'Appearance',
    // Kiln Glass (08-Oct): six gradient colour themes and glass or solid panels, per browser.
    hint: 'Colour theme — Mint, Ember, Ocean, Aurora, Rose, Graphite — and glass or solid',
    status: live(),
  },
  {
    slug: 'generation',
    label: 'Generation',
    hint: 'Pictures per shot, series video type and pace, picture style, what generates',
    status: live(),
  },
  {
    slug: 'assembly',
    label: 'Assembly',
    hint: 'Line gap, tail, loudness, caption and hook sizes, safe area',
    status: live(),
  },
  {
    slug: 'publishing',
    label: 'Publishing',
    hint: 'Slot time, disclosure defaults, publish targets, upload status',
    status: live(),
  },
  {
    slug: 'danger',
    label: 'Danger zone',
    hint: 'Orphaned files, unstick an episode, rotate keys',
    status: live(),
  },
];

export function findSection(slug: string): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((s) => s.slug === slug);
}
