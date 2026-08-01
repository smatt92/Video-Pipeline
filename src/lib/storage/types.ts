import { z } from 'zod';

/**
 * The storage layer.
 *
 * Same reasoning as `src/lib/drivers/` (ARCHITECTURE.md §0.1): the object store is a
 * config value, not an architectural commitment. Phase 1 originally specified Cloudflare
 * R2 and now uses Supabase Storage over its S3-compatible protocol — a swap that costs
 * one module because the rest of the app only ever sees this interface. See
 * `docs/decisions/0007-supabase-storage-over-r2.md`.
 *
 * The constraint this layer exists to enforce has not changed with the vendor: **media
 * bytes never pass through a Next.js route.** Vercel caps a function's request and
 * response body at 4.5 MB and it is not configurable (CLAUDE.md rule 2, ARCHITECTURE.md
 * §2), so a 30-second 1080p clip cannot be proxied even once.
 *
 *   browser  ──presigned PUT──►  bucket
 *   browser  ◄─presigned GET──   bucket
 *   worker   ──direct SDK────►   bucket
 *
 * Every method here hands out a *URL* or moves a small amount of metadata. If you find
 * yourself wanting `upload(bytes)` on this interface, the upload belongs in
 * `src/trigger/` where there is no body limit.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Keys
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Object keys are built, never accepted from a client. A key that arrives over the wire
 * is a path traversal, or an overwrite of someone else's asset, waiting to happen.
 */
export const storageKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[a-zA-Z0-9!_.*'()\-/]+$/, 'storage key contains characters outside the S3 safe set')
  .refine((k) => !k.includes('..'), 'storage key must not traverse')
  .refine((k) => !k.startsWith('/'), 'storage key must not start with /');

export type StorageKey = z.infer<typeof storageKeySchema>;

/**
 * Key for a generated asset. Deterministic and collision-free: the generation id is
 * unique, so a retry that reuses it overwrites its own object rather than accumulating
 * orphans that nothing will ever reference or clean up.
 */
export function assetKey(params: {
  generationId: string;
  kind: 'video' | 'audio' | 'image' | 'caption' | 'music';
  extension: string;
}): StorageKey {
  const ext = params.extension.replace(/^\./, '').toLowerCase();
  return storageKeySchema.parse(`generations/${params.generationId}/${params.kind}.${ext}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// Presigning
// ═════════════════════════════════════════════════════════════════════════════

/** Presigned URLs are short-lived: a leaked one should expire before it is useful. */
export const DEFAULT_EXPIRY_S = 15 * 60;
/** SigV4 ceiling. Anything longer is rejected by the signer, not by policy. */
export const MAX_EXPIRY_S = 7 * 24 * 60 * 60;

export interface PresignPutParams {
  key: string;
  /** Signed into the request, so a client cannot upload a different type than declared. */
  contentType: string;
  /** Signed too, where supported — an unbounded PUT is an unbounded bill. */
  contentLength?: number;
  expiresIn?: number;
}

export interface PresignGetParams {
  key: string;
  expiresIn?: number;
  /** Sets Content-Disposition: attachment, for the Phase 1 manual download path. */
  downloadAs?: string;
}

export interface PresignedUrl {
  readonly url: string;
  readonly key: StorageKey;
  readonly expiresAt: string;
}

/**
 * Result of a full round trip: write an object, read it back, delete it.
 *
 * This is onboarding step 2 and it is deliberately not "are the credentials
 * well-formed?". A key that authenticates but cannot write, or can write but not read
 * back, fails in the middle of the first generation — which is exactly the discovery
 * point the onboarding gate exists to move earlier. Written to `integration_checks` as
 * `round_trip`.
 */
export interface StorageProbeResult {
  readonly ok: boolean;
  /** Safe for the UI. Must never contain credential material. */
  readonly detail: string;
  readonly latencyMs: number;
  readonly steps: {
    readonly write: boolean;
    readonly read: boolean;
    readonly delete: boolean;
  };
}

export class StorageError extends Error {
  readonly slug: string;
  readonly code: 'auth' | 'not_found' | 'upstream' | 'invalid_key' | 'unknown';

  constructor(params: {
    slug: string;
    code: StorageError['code'];
    message: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'StorageError';
    this.slug = params.slug;
    this.code = params.code;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// The interface
// ═════════════════════════════════════════════════════════════════════════════

export interface StorageDriver {
  /** Registry key. Also what gets written wherever a storage vendor is recorded. */
  readonly slug: string;
  readonly bucket: string;

  /** A URL the browser can PUT bytes directly to. */
  presignPut(params: PresignPutParams): Promise<PresignedUrl>;

  /** A URL the browser can GET bytes directly from, for private objects. */
  presignGet(params: PresignGetParams): Promise<PresignedUrl>;

  /** Idempotent: deleting an absent key succeeds. */
  delete(key: string): Promise<void>;

  /** Write → read back → delete. Powers onboarding step 2 and Test-connection. */
  probe(): Promise<StorageProbeResult>;

  /**
   * Stable unsigned URL, for the one case a signature cannot be presented: Instagram's
   * container API fetches `video_url` itself.
   *
   * Optional, and deliberately unresolved in Phase 1 — publishing is Phase 3, and the
   * exact public URL shape for this vendor needs confirming against a real bucket rather
   * than guessing now. Returns null when the bucket is not configured for public reads,
   * so callers must handle the absence instead of emitting a URL that 403s.
   */
  publicUrl?(key: string): string | null;
}
