/**
 * The integration catalogue.
 *
 * Which vendors exist, what their credential fields are called, which checks are
 * meaningful for each, and which vendor-specific panels a settings screen should offer.
 * All of that is *driver knowledge*, so it lives here — inside the one directory allowed
 * to name a vendor.
 *
 * This file exists because the vendor-isolation check caught the settings page doing
 * `integration.slug === 'higgsfield'` to decide whether to render a credit-balance panel.
 * That is exactly the failure CLAUDE.md rule 1 describes: the fix is not to move the
 * string somewhere quieter, it is that the caller needed something the driver layer was
 * not offering. It needed to ask "does this vendor have a credit balance?" and had no way
 * to, so it asked "is this vendor Higgsfield?" instead.
 *
 * Everything above this layer now branches on capability flags. Swapping the video driver
 * changes a row here and nothing in `src/app/`.
 *
 * In production these descriptors are joined against the `integrations` table, which
 * holds the state (configured, verified, last_4) while this holds the shape.
 */

export type IntegrationKindSlug = 'llm' | 'video' | 'audio' | 'storage';

export interface SecretFieldDescriptor {
  readonly key: string;
  readonly label: string;
  /** Shown under the field. Use it for the mistake people actually make. */
  readonly help?: string;
  readonly minLength?: number;
}

export interface CheckDescriptor {
  readonly name: 'credentials' | 'round_trip' | 'balance' | 'voices' | 'models';
  readonly label: string;
  /** What the check actually does. Never "validates the format". */
  readonly detail: string;
}

export interface IntegrationDescriptor {
  readonly slug: string;
  readonly label: string;
  readonly kind: IntegrationKindSlug;
  readonly secretFields: readonly SecretFieldDescriptor[];
  readonly checks: readonly CheckDescriptor[];
  /** Must verify before this one is offered. Storage before anything that writes. */
  readonly dependsOn?: string;
  /** Capability flags. The settings UI branches on these, never on the slug. */
  readonly capabilities: {
    /** Vendor exposes a spendable balance, and it expires. */
    readonly creditBalance: boolean;
    /** Throttle ceiling comes from a plan tier that must be read and stored. */
    readonly planTierConcurrency: boolean;
  };
  readonly notes?: readonly string[];
  /** Seed rate-card rows. Unit costs are deliberately absent — see the note below. */
  readonly rates: readonly {
    readonly model: string;
    readonly endpoint: string | null;
    readonly unit: string;
  }[];
}

const CREDENTIALS: CheckDescriptor = {
  name: 'credentials',
  label: 'Credentials accepted',
  detail: 'The cheapest authenticated call the vendor offers. Proves the key works, and nothing else.',
};

export const INTEGRATION_CATALOG: readonly IntegrationDescriptor[] = [
  {
    slug: 'supabase-storage',
    label: 'Storage',
    kind: 'storage',
    secretFields: [
      { key: 'SUPABASE_S3_ACCESS_KEY_ID', label: 'S3 access key ID' },
      {
        key: 'SUPABASE_S3_SECRET_ACCESS_KEY',
        label: 'S3 secret access key',
        help: 'From Storage → S3 Access Keys. NOT the service-role key — using that returns a 403 that reads like a permissions problem rather than a wrong-credential-type problem.',
      },
    ],
    checks: [
      CREDENTIALS,
      {
        name: 'round_trip',
        label: 'Write → read back → delete',
        detail:
          'Uploads a probe object through a presigned URL, reads it back and compares bytes, deletes it, then confirms a subsequent read no longer finds it. A key that authenticates but cannot write fails mid-generation, which is the discovery this moves earlier.',
      },
    ],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    rates: [],
  },
  {
    slug: 'anthropic',
    label: 'Anthropic',
    kind: 'llm',
    secretFields: [{ key: 'ANTHROPIC_API_KEY', label: 'API key' }],
    checks: [
      CREDENTIALS,
      {
        name: 'models',
        label: 'Model list retrieved',
        detail: 'Stores the available models so the generation settings can offer real choices rather than a hardcoded list that drifts.',
      },
    ],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    rates: [],
  },
  {
    slug: 'higgsfield',
    label: 'Higgsfield',
    kind: 'video',
    dependsOn: 'supabase-storage',
    secretFields: [
      { key: 'HIGGSFIELD_API_KEY', label: 'API key' },
      { key: 'HIGGSFIELD_API_SECRET', label: 'API secret' },
      {
        key: 'HIGGSFIELD_WEBHOOK_SECRET',
        label: 'Webhook secret',
        minLength: 32,
        help: 'Minimum 32 characters. Not a signature — the vendor echoes this back in a header, so it is a password rather than a proof, and anyone who obtains it can forge a completion.',
      },
    ],
    checks: [
      CREDENTIALS,
      {
        name: 'balance',
        label: 'Credit balance + expiry',
        detail:
          'Credits expire roughly 90 days from purchase. That is a cost the ledger cannot see, because nothing is billed at the moment they evaporate — so the clock belongs on screen.',
      },
    ],
    capabilities: { creditBalance: true, planTierConcurrency: false },
    notes: [
      'API access is gated to higher-tier plans.',
      'Character references can be consumed but not created on the v2 surface — mint the identity in the vendor dashboard.',
      'Undocumented rate limits that fail silently. Every call is treated as unreliable.',
    ],
    rates: [
      { model: 'dop-lite', endpoint: '/v1/image2video/dop', unit: 'credit' },
      { model: 'dop-turbo', endpoint: '/v1/image2video/dop', unit: 'credit' },
      { model: 'dop-standard', endpoint: '/v1/image2video/dop', unit: 'credit' },
      { model: 'soul', endpoint: '/v1/text2image/soul', unit: 'credit' },
    ],
  },
  {
    slug: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'audio',
    dependsOn: 'supabase-storage',
    secretFields: [{ key: 'ELEVENLABS_API_KEY', label: 'API key' }],
    checks: [
      CREDENTIALS,
      {
        name: 'voices',
        label: 'Voice list + plan tier',
        detail:
          'The tier decides the parallel-request ceiling the queue reads at run time. A hardcoded number above the real limit produces a constant failure rate that reads as vendor flakiness.',
      },
    ],
    capabilities: { creditBalance: false, planTierConcurrency: true },
    notes: [
      'Throttle unit is parallel requests, not requests per minute.',
      'Word-level timings come only from this vendor, which is why the audio-first ordering depends on it.',
    ],
    rates: [
      { model: 'eleven_multilingual_v2', endpoint: '/v1/text-to-speech/with-timestamps', unit: 'character' },
      { model: 'eleven_v3', endpoint: '/v1/text-to-speech/with-timestamps', unit: 'character' },
      { model: 'eleven_flash_v2_5', endpoint: '/v1/text-to-speech/with-timestamps', unit: 'character' },
    ],
  },
  {
    slug: 'fal',
    label: 'fal.ai',
    kind: 'video',
    dependsOn: 'supabase-storage',
    secretFields: [{ key: 'FAL_KEY', label: 'API key' }],
    checks: [CREDENTIALS],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    notes: ['The second driver. Its job is to keep the interface honest; it is not on the critical path.'],
    rates: [{ model: 'placeholder', endpoint: null, unit: 'second' }],
  },
];

/**
 * Plan tiers and their hard parallel-request ceilings, for vendors that throttle on
 * concurrency. Read from the account during verification and stored on the integration.
 */
export const PLAN_TIERS: Record<string, readonly { tier: string; concurrency: number; note: string }[]> = {
  elevenlabs: [
    { tier: 'free', concurrency: 2, note: 'Attribution required; commercial use not permitted' },
    { tier: 'starter', concurrency: 3, note: '' },
    { tier: 'creator', concurrency: 5, note: 'Professional Voice Cloning unlocks here' },
    { tier: 'pro', concurrency: 10, note: '' },
    { tier: 'scale', concurrency: 15, note: '' },
    { tier: 'business', concurrency: 15, note: '' },
  ],
};

/**
 * Model policy per output format, for vendors where the choice is not obvious.
 * Belongs here rather than in settings because the trade-offs are vendor facts.
 */
export const AUDIO_MODEL_POLICY = [
  { format: 'Shorts / Reels hook', model: 'eleven_v3', why: 'Expressive, supports audio tags; 5k character cap' },
  { format: 'Long-form narration', model: 'eleven_multilingual_v2', why: 'Most consistent across chunks; 10k character limit' },
  {
    format: 'Bulk / cost-sensitive',
    model: 'eleven_flash_v2_5',
    why: 'Half price — but text normalization defaults off, which reads currency and dates as digits',
  },
  { format: 'Telugu', model: 'eleven_v3', why: 'The only model listing it. Hindi is on all three.' },
] as const;

/** Flattened seed rows for the rate card. Unit cost is absent on purpose. */
export const SEED_RATES = INTEGRATION_CATALOG.flatMap((i) =>
  i.rates.map((r) => ({ driver: i.slug, driverLabel: i.label, ...r })),
);
