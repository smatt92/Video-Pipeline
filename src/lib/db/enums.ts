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

export type ConceptStatus = z.infer<typeof conceptStatus>;
export type ShotStatus = z.infer<typeof shotStatus>;
export type GenerationKind = z.infer<typeof generationKind>;
export type GenerationStatus = z.infer<typeof generationStatus>;
export type AssetKind = z.infer<typeof assetKind>;
export type RenderFormat = z.infer<typeof renderFormat>;
export type CostEntryKind = z.infer<typeof costEntryKind>;
export type DriverHealthState = z.infer<typeof driverHealthState>;

/**
 * Consumed by `pnpm check:enums`. Maps each enum above to the table and column whose
 * CHECK constraint it claims to mirror.
 */
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
} as const;
