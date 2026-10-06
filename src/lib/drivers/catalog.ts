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

export type IntegrationKindSlug = 'llm' | 'video' | 'audio' | 'storage' | 'channel' | 'notify';

/**
 * `channel` is the publishing destination, and it differs from the other four in a way
 * worth naming: it is not swappable. Which video generator fills the `video` role is a
 * config value, and rule 1 exists so that swapping it is one edit here. Which *platform* a
 * video is published to is an editorial decision with its own aspect ratio, its own
 * disclosure obligations and its own audience — `channels.platform` is a domain enum for
 * that reason, not a driver slug. What the driver layer owns is the API surface, and that
 * is what stays behind this boundary.
 */

export interface SecretFieldDescriptor {
  readonly key: string;
  readonly label: string;
  /** Shown under the field. Use it for the mistake people actually make. */
  readonly help?: string;
  readonly minLength?: number;
  /**
   * Older environment names still accepted as a fallback, newest first. The catalogue key
   * is the canonical name and the one the settings screen writes to Vault; an alias exists
   * so a deployment configured under a previous name keeps working without a silent gap.
   */
  readonly envAliases?: readonly string[];
}

export interface CheckDescriptor {
  readonly name: 'credentials' | 'round_trip' | 'voices' | 'models' | 'channel';
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
  /**
   * The vendor currently filling this kind's role. Exactly one per kind.
   *
   * This is what makes "the generator is a config value" true in code rather than in
   * comments: the wizard asks for the *video* integration and this row answers which one,
   * so swapping the driver is an edit here and nothing above it changes.
   */
  readonly primary?: boolean;
  /** Capability flags. The settings UI branches on these, never on the slug. */
  readonly capabilities: {
    /** Vendor exposes a spendable balance the API can read. */
    readonly creditBalance: boolean;
    /**
     * Credits are prepaid and expire, and the vendor gives us no way to read either. The
     * settings screen offers manual purchase entry and shows the resulting countdown.
     *
     * A separate flag from `creditBalance` because they are different facts: one says the
     * number is fetchable, the other says the number matters and is not. Collapsing them
     * would make "we can read it" and "you must type it" the same case.
     */
    readonly creditExpiryTracking?: boolean;
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
    primary: true,
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
    primary: true,
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
    // Primary for the *legacy* concept → script lane only (05-generate, webhook-only, its
    // harnesses are verify:submit / verify:webhook). The Bureau episode run routes through
    // ROUTE_PROVIDERS in jobs.ts, where this vendor is dormant failover behind
    // GENERATION_FAILOVER=off — decision 0015. Optional: a missing key blocks nothing.
    slug: 'higgsfield',
    label: 'Higgsfield (dormant failover)',
    kind: 'video',
    primary: true,
    dependsOn: 'supabase-storage',
    secretFields: [
      { key: 'HIGGSFIELD_API_KEY_ID', label: 'API key ID', envAliases: ['HIGGSFIELD_API_KEY'] },
      {
        key: 'HIGGSFIELD_API_KEY_SECRET',
        label: 'API key secret',
        envAliases: ['HIGGSFIELD_API_SECRET'],
      },
      {
        key: 'HIGGSFIELD_WEBHOOK_SECRET',
        label: 'Webhook secret',
        minLength: 32,
        help: 'Minimum 32 characters. Not a signature — the vendor echoes this back in a header, so it is a password rather than a proof, and anyone who obtains it can forge a completion.',
      },
    ],
    // Credentials only. There was a `balance` check here and it could never pass: the SDK
    // exposes no account surface, so it reported failure forever. Removed rather than left
    // as a permanent red X — see `creditExpiryTracking` below for what replaced it.
    checks: [CREDENTIALS],
    capabilities: { creditBalance: false, creditExpiryTracking: true, planTierConcurrency: false },
    notes: [
      'Optional since 0015: dormant failover for character beats, routed only with GENERATION_FAILOVER=on.',
      'API access is gated to higher-tier plans.',
      'Character references can be consumed but not created on the v2 surface — mint the identity in the vendor dashboard.',
      'Undocumented rate limits that fail silently. Every call is treated as unreliable.',
    ],
    rates: [
      { model: 'dop-lite', endpoint: '/v1/image2video/dop', unit: 'credit' },
      { model: 'dop-turbo', endpoint: '/v1/image2video/dop', unit: 'credit' },
      { model: 'dop-standard', endpoint: '/v1/image2video/dop', unit: 'credit' },
      { model: 'soul', endpoint: '/v1/text2image/soul', unit: 'credit' },
      { model: 'kling-3.0-std', endpoint: '/v1/image2video/kling', unit: 'second' },
    ],
  },
  {
    slug: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'audio',
    primary: true,
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
    // The publishing destination. Disabled and unverified until the wizard fills it in,
    // like every other catalogue row.
    //
    // Three secret fields rather than one, and the third is not a secret anybody types
    // twice: `YOUTUBE_REFRESH_TOKEN` is obtained once through an OAuth consent flow and is
    // then the credential. There is deliberately no field for an access token — it is
    // derived per call and never stored, because a stored copy would be a second home for
    // a thing that changes hourly.
    slug: 'youtube',
    label: 'YouTube',
    kind: 'channel',
    // Publishing needs the render, and the render lives in the bucket.
    dependsOn: 'supabase-storage',
    primary: true,
    secretFields: [
      { key: 'YOUTUBE_CLIENT_ID', label: 'OAuth client ID' },
      { key: 'YOUTUBE_CLIENT_SECRET', label: 'OAuth client secret' },
      {
        key: 'YOUTUBE_REFRESH_TOKEN',
        label: 'Refresh token',
        help:
          'From a one-time consent flow with the youtube.upload scope. While the consent '
          + 'screen is in Testing this expires after seven days and Google does not say so '
          + 'anywhere — publish the app to stop that. 10b-token-health finds out by trying.',
      },
    ],
    checks: [
      {
        name: 'credentials',
        label: 'Refresh token exchanges',
        detail: 'Exchanges the refresh token for an access token. invalid_grant is named: revoked, or the seven-day Testing expiry.',
      },
      {
        name: 'channel',
        label: 'Token is for this channel',
        detail: "Reads the Bureau channel's own Analytics for the last seven days (its own quota; no Data API units). A 403 means the token belongs to a different channel. Never uploads.",
      },
    ],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    notes: [
      'Quota is counted rather than guessed: every call this code makes writes an '
        + 'api_quota_usage row, so the daily countdown has a real numerator. The 10,000-unit '
        + 'ceiling is Google\'s documented figure and is labelled as such until a refusal '
        + 'makes it observable.',
      'An upload costs 1,600 units, so six failed attempts is a day.',
    ],
    rates: [],
  },
  {
    slug: 'fal',
    label: 'fal.ai',
    kind: 'video',
    dependsOn: 'supabase-storage',
    secretFields: [{ key: 'FAL_KEY', label: 'API key' }],
    checks: [CREDENTIALS],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    notes: [
      'Optional since 0015: dormant failover for character beats, routed only with GENERATION_FAILOVER=on.',
      'Queue API: submit, then poll the status URL. Webhooks exist but are not used — one polling path for every non-primary vendor.',
    ],
    rates: [
      { model: 'fal-ai/kling-video/v3/standard/image-to-video', endpoint: 'queue.fal.run', unit: 'second' },
    ],
  },
  {
    // Embeddings for the variation check — the only job left for this vendor (0015). Free
    // tier. Veo money shots moved to the Runway API; the Veo path stays as dormant failover
    // for money shots behind GENERATION_FAILOVER=on, so it keeps its driver code but no rate.
    slug: 'gemini',
    label: 'Gemini (embeddings)',
    kind: 'video',
    dependsOn: 'supabase-storage',
    secretFields: [
      {
        key: 'GEMINI_API_KEY',
        label: 'API key',
        help: 'A free-tier key from Google AI Studio is enough: it is used for script and title embeddings only.',
      },
    ],
    checks: [CREDENTIALS],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    notes: [
      'Required: variation_check refuses, by name, while embeddings are unavailable — it never passes and never scores 0.',
      'Free tier rate-limits with 429; the driver backs off and retries before reporting the vendor unavailable.',
    ],
    // Exactly the row 0040 seeds — confirmRateCard matches (driver, model, endpoint, unit).
    rates: [{ model: 'gemini-embedding-001', endpoint: '/v1beta/models:batchEmbedContents', unit: 'input_token' }],
  },
  {
    // All generation since 0015: character beats (gen4_turbo), money shots (veo3.1_fast),
    // reference frames (gen4_image), voice, dubs, sound effects and Act-Two. One API key, one
    // credit pool — the Runway API's, which is separate from Runway app credits.
    slug: 'runway',
    label: 'Runway',
    kind: 'video',
    dependsOn: 'supabase-storage',
    secretFields: [
      {
        key: 'RUNWAY_API_KEY',
        label: 'API key',
        help: 'From dev.runwayml.com → API Keys. API credits are a separate pool from Runway app credits: buying app credits does not fund this key.',
      },
    ],
    checks: [CREDENTIALS],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    notes: [
      'No task webhooks: every task is polled with backoff (0013).',
      'A terminal task reports its final cost in credits; that lands as a measured reconcile row.',
      'Durations differ per model: gen4_turbo 2–10 s, veo3.1_fast 4/6/8 s. 9:16 is 720:1280.',
    ],
    // Exactly the rows 0040 and 0044 seed. Act-Two is absent on purpose: it has no published
    // per-second figure, and listing it would hold the rate-card step closed for a route
    // nothing plans until a recipe proves its credits per second.
    rates: [
      { model: 'gen4_turbo', endpoint: null, unit: 'second' },
      { model: 'veo3.1_fast', endpoint: null, unit: 'second' },
      { model: 'gen4_image', endpoint: '/v1/text_to_image', unit: 'image_720p' },
      { model: 'gen4_image', endpoint: '/v1/text_to_image', unit: 'image_1080p' },
      { model: 'gen4_image_turbo', endpoint: '/v1/text_to_image', unit: 'image' },
      { model: 'eleven_v3', endpoint: '/v1/text_to_speech', unit: 'character' },
    ],
  },
  {
    // Reels mirror. Publishing stays behind channel_policy.instagram_publish_enabled = false
    // until Meta app review clears (CLAUDE.md, current phase) — decision 0012.
    slug: 'instagram',
    label: 'Instagram (Reels)',
    kind: 'channel',
    dependsOn: 'supabase-storage',
    secretFields: [
      { key: 'META_IG_USER_ID', label: 'Instagram professional account ID' },
      {
        key: 'META_ACCESS_TOKEN',
        label: 'Long-lived access token',
        help: 'Needs instagram_business_basic and instagram_business_content_publish, which need Meta app review.',
      },
    ],
    checks: [CREDENTIALS],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    notes: ['Container → poll FINISHED → media_publish. Disabled until app review clears.'],
    rates: [],
  },
  {
    slug: 'slack',
    label: 'Slack (notifications)',
    kind: 'notify',
    secretFields: [
      {
        key: 'SLACK_WEBHOOK_URL',
        label: 'Incoming webhook URL',
        help: 'Briefs pending, cuts ready, cap at 80%, policy flags, QC failures after rerolls.',
      },
    ],
    checks: [CREDENTIALS],
    capabilities: { creditBalance: false, planTierConcurrency: false },
    rates: [],
  },
];

/**
 * The parallel-request ceiling used when nothing has established a real one.
 *
 * Two is the lowest limit any plan has, so it is safe against all of them. Lives here
 * rather than beside the probe that falls back to it, and that placement is load-bearing:
 * the settings screen renders this number, `probes.ts` imports a vendor SDK, and importing
 * one constant from there pulled the entire SDK into the browser bundle. The build caught
 * it — `node:fs` is not resolvable in a client bundle — which is a better outcome than a
 * 400 kB bundle nobody looks at.
 *
 * Deliberately conservative. Guessing high produces a steady failure rate that reads as an
 * unreliable vendor and sends someone debugging the wrong system; guessing low is slow.
 */
export const DEFAULT_CONCURRENCY = 2;

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

/**
 * The vendor filling a role.
 *
 * Callers above the driver layer ask for a *kind* — "the video generator", "the voice" —
 * and get a descriptor. Nothing outside this directory has to know, or be able to say,
 * which vendor that is.
 */
export function primaryForKind(kind: IntegrationKindSlug): IntegrationDescriptor | null {
  return INTEGRATION_CATALOG.find((i) => i.kind === kind && i.primary) ?? null;
}

/**
 * What each onboarding role is filled by, for the wizard (decision 0015).
 *
 * Separate from `primary` because the two lanes now disagree and both are true: the legacy
 * concept → script lane still asks `primaryForKind('video')` for its webhook-only vendor,
 * while the Bureau run — the thing the wizard is setting up — generates, speaks and dubs on
 * one Runway key and embeds on a free Gemini key. A wizard that asked for the legacy lane's
 * vendor would make a dormant failover a precondition for using the app.
 */
export type OnboardingRole = 'storage' | 'llm' | 'generation' | 'voice' | 'embeddings';
export const ROLE_INTEGRATION: Readonly<Record<OnboardingRole, string>> = {
  storage: 'supabase-storage',
  llm: 'anthropic',
  generation: 'runway',
  voice: 'runway',
  embeddings: 'gemini',
};

export function descriptorFor(slug: string): IntegrationDescriptor | null {
  return INTEGRATION_CATALOG.find((i) => i.slug === slug) ?? null;
}

/**
 * The credentials a deployed worker resolves from its environment when Vault does not hold
 * them: every field of every integration that fills a Bureau role.
 *
 * `resolveCredentials` reads `process.env[field.key]` by a name it computes, so the worker
 * manifest's import-graph walk (`check:trigger-env`) cannot see these reads at all — which
 * is how a worker whose secrets live only in Vercel would deploy without any of them and
 * fail on its first run. Decision 0017: for personal use Vercel is the single source, so
 * these are what the deploy-time sync must carry. Callers: `vercelEnv()` in
 * `src/lib/trigger/vercel-env.ts` (the deploy) and `scripts/check-trigger-env.mjs`.
 */
export function workerCredentialFields(): { slug: string; key: string; aliases: readonly string[] }[] {
  const slugs = [...new Set(Object.values(ROLE_INTEGRATION))];
  return slugs.flatMap((slug) => {
    const d = descriptorFor(slug);
    if (!d) throw new Error(`ROLE_INTEGRATION names "${slug}", which is not in the catalogue.`);
    return d.secretFields.map((f) => ({ slug, key: f.key, aliases: f.envAliases ?? [] }));
  });
}
