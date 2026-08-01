import { env } from '../env';
import { createSupabaseStorageDriver } from './supabase';
import type { StorageDriver } from './types';

export {
  assetKey,
  storageKeySchema,
  StorageError,
  DEFAULT_EXPIRY_S,
  MAX_EXPIRY_S,
} from './types';
export type {
  PresignedUrl,
  PresignGetParams,
  PresignPutParams,
  StorageDriver,
  StorageKey,
  StorageProbeResult,
} from './types';

/**
 * Storage driver registry.
 *
 * This module is the seam. Everything above it imports `storage()` and the
 * `StorageDriver` interface; nothing above it knows which object store is behind them,
 * which is why moving from Cloudflare R2 to Supabase Storage touched this directory and
 * the env list, and no call site at all.
 *
 * Registering a second implementation is adding one entry below.
 */
const REGISTRY: Record<string, () => StorageDriver> = {
  'supabase-storage': createSupabaseStorageDriver,
};

let cached: StorageDriver | null = null;

/**
 * The configured storage driver.
 *
 * Fails loudly on an unknown slug rather than falling back to a default. A silent
 * fallback here would mean uploads succeeding against the wrong bucket, which is
 * discovered days later when something tries to read them back.
 */
export function storage(): StorageDriver {
  if (cached) return cached;

  const slug = env.STORAGE_DRIVER;
  const factory = REGISTRY[slug];

  if (!factory) {
    throw new Error(
      `STORAGE_DRIVER is "${slug}", which is not a registered storage driver. ` +
        `Known drivers: ${Object.keys(REGISTRY).join(', ')}. ` +
        'Register it in src/lib/storage/index.ts or correct the environment.',
    );
  }

  cached = factory();
  return cached;
}

/** Reset the memoised driver. Tests only. */
export function resetStorageCache(): void {
  cached = null;
}
