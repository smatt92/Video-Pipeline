import { z } from 'zod';

/**
 * The CHECK constraints from the schema, as Zod enums.
 *
 * Why this file exists: `docs/SCHEMA.sql` deliberately models closed sets as `text` with
 * a CHECK rather than as Postgres enums — vendor-neutral, and alterable without a table
 * rewrite. The cost is that the generated types cannot see them. Every one of these
 * columns arrives in `src/lib/db/types.ts` as plain `string`, so nothing stops you
 * writing `status: 'complete'` when the constraint says `'succeeded'`. You find out at
 * runtime, from Postgres, in the middle of a fan-out.
 *
 * These enums put that back. They are the one legitimate exception to "DB types are
 * generated, never hand-written" — they are not types *of* the database, they are the
 * constraints the database enforces, restated where TypeScript can use them.
 *
 * Because they are hand-written they can drift. `pnpm check:enums` reads the live CHECK
 * constraints out of `pg_constraint` and fails if any of these disagrees. That check runs
 * in CI. Do not add a value here without adding it to a migration first.
 */

export const channelPlatform = z.enum(['youtube', 'instagram']);

export const conceptStatus = z.enum([
  'draft',
  'approved',
  'killed',
  'in_production',
  'published',
]);
export const conceptIpRisk = z.enum(['unknown', 'low', 'medium', 'high']);

export const shotStatus = z.enum(['pending', 'generating', 'ready', 'failed', 'reshoot']);

export const generationKind = z.enum(['video', 'image', 'audio', 'lipsync', 'upscale']);

/**
 * Note the spelling: the schema says `cancelled`, and at least one vendor SDK reports
 * `canceled`. Normalising that difference is the driver's job, not the caller's.
 */
export const generationStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

/** Statuses after which no further webhook or state change is expected. */
export const TERMINAL_GENERATION_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
] as const satisfies readonly z.infer<typeof generationStatus>[];

export function isTerminal(status: string): boolean {
  return (TERMINAL_GENERATION_STATUSES as readonly string[]).includes(status);
}

export const assetKind = z.enum(['video', 'audio', 'image', 'caption', 'music']);

export const renderFormat = z.enum(['shorts_9x16', 'reels_9x16', 'longform_16x9']);
export const renderStatus = z.enum(['queued', 'rendering', 'ready', 'failed']);

export const reviewDecision = z.enum(['pass', 'reshoot', 'kill']);

export const publicationStatus = z.enum([
  'draft',
  'scheduled',
  'uploading',
  'live',
  'failed',
]);

export const metricsAgeBucket = z.enum(['6h', '24h', '7d', '30d']);

export const costEntryKind = z.enum(['estimate', 'reconcile', 'refund']);

export const driverHealthState = z.enum(['closed', 'open', 'half_open']);

// ── Studio lane (migration 0003) ────────────────────────────────────────────

export const studioSessionStatus = z.enum(['active', 'archived', 'capped']);

/**
 * Where a row came from.
 *
 * `studio_unmanaged` is the honest label for work done through a vendor MCP server we do
 * not control: no idempotency key we issued, no cost we can attribute. Rows marked this
 * way must carry `cost_inr = null`, never zero — zero is a claim, null is the truth, and
 * the cost dashboard has to be able to tell the difference.
 */
export const rowOrigin = z.enum(['pipeline', 'studio', 'studio_unmanaged']);

/**
 * `rough_cut` is ffmpeg concat for review — "does this hang together?". `final` is the
 * Remotion composition with captions, hook text and safe areas. Only finals carry cost.
 */
export const renderKind = z.enum(['rough_cut', 'final']);

// ── Integrations (migration 0003) ───────────────────────────────────────────

export const integrationKind = z.enum([
  'llm',
  'video',
  'audio',
  'storage',
  'mcp',
  'channel',
]);

export const mcpAuthMode = z.enum(['none', 'bearer', 'oauth']);

// ── Audio-first timing (migration 0004) ────────────────────────────────────

/**
 * Whether a shot's duration was planned or measured.
 *
 * `derived_from_vo` means the number came from real word timings, so the clip was
 * generated to fit actual speech. When a shot looks mistimed, this tells you whether the
 * estimate was wrong or the delivery was.
 */
export const shotDurationSource = z.enum(['authored', 'derived_from_vo']);

/**
 * Phoneme rules are honoured by only some TTS models and silently ignored by the rest;
 * alias substitution works everywhere. Prefer `alias` unless the target model is known to
 * support phonemes — a silently ignored rule is worse than an ugly one that works.
 */
export const pronunciationKind = z.enum(['alias', 'phoneme']);

/** CMU is more predictable than IPA for this purpose. */
export const phoneticAlphabet = z.enum(['cmu', 'ipa']);

export const integrationEvent = z.enum([
  'created',
  'rotated',
  'verified',
  'failed',
  'disabled',
  'enabled',
]);

export type ConceptStatus = z.infer<typeof conceptStatus>;
export type ShotStatus = z.infer<typeof shotStatus>;
export type GenerationKind = z.infer<typeof generationKind>;
export type GenerationStatus = z.infer<typeof generationStatus>;
export type AssetKind = z.infer<typeof assetKind>;
export type RenderFormat = z.infer<typeof renderFormat>;
export type CostEntryKind = z.infer<typeof costEntryKind>;
export type DriverHealthState = z.infer<typeof driverHealthState>;
export type StudioSessionStatus = z.infer<typeof studioSessionStatus>;
export type RowOrigin = z.infer<typeof rowOrigin>;
export type RenderKind = z.infer<typeof renderKind>;
export type IntegrationKind = z.infer<typeof integrationKind>;
export type McpAuthMode = z.infer<typeof mcpAuthMode>;
export type ShotDurationSource = z.infer<typeof shotDurationSource>;
export type PronunciationKind = z.infer<typeof pronunciationKind>;

/**
 * Consumed by `pnpm check:enums`. Maps each enum above to the table and column whose
 * CHECK constraint it claims to mirror.
 */
/**
 * Where a parallel-request ceiling came from.
 *
 * Recorded because a limit that was read from the account and a limit that was assumed
 * deserve different confidence, and a screen that cannot tell them apart will present the
 * assumption as fact — which is how a conservative default gets quietly trusted as the real
 * number, or a guessed-high one gets blamed on the vendor.
 */
export const concurrencySource = z.enum(['default', 'tier', 'manual']);
export type ConcurrencySource = z.infer<typeof concurrencySource>;

export const ENUM_CONSTRAINT_MAP = {
  'channels.platform': channelPlatform,
  'concepts.status': conceptStatus,
  'concepts.ip_risk': conceptIpRisk,
  'shots.status': shotStatus,
  'generations.kind': generationKind,
  'generations.status': generationStatus,
  'assets.kind': assetKind,
  'renders.format': renderFormat,
  'renders.status': renderStatus,
  'reviews.decision': reviewDecision,
  'publications.status': publicationStatus,
  'metrics_snapshots.age_bucket': metricsAgeBucket,
  'cost_ledger.entry_kind': costEntryKind,
  'driver_health.state': driverHealthState,
  'studio_sessions.status': studioSessionStatus,
  'generations.origin': rowOrigin,
  'renders.origin': rowOrigin,
  'renders.kind': renderKind,
  'integrations.kind': integrationKind,
  'mcp_servers.auth_mode': mcpAuthMode,
  'integration_events.event': integrationEvent,
  'shots.duration_source': shotDurationSource,
  'pronunciations.kind': pronunciationKind,
  'pronunciations.alphabet': phoneticAlphabet,
  'integrations.concurrency_source': concurrencySource,
} as const;
