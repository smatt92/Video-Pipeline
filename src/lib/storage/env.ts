import { z } from 'zod';

/**
 * Storage vendor configuration.
 *
 * Lives inside `src/lib/storage/` for the same reason vendor credentials live inside
 * `src/lib/drivers/`: the core of the application should not know which object store it
 * is talking to. `src/lib/env.ts` composes this schema without naming anything in it.
 *
 * Note this module is *excluded* from the vendor-isolation CI check alongside `drivers/`
 * and `publish/`, which is what makes naming a vendor here legitimate.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is set but empty`);

export const storageEnvSchema = z.object({
  /**
   * Which storage implementation to construct. No default: the point of the interface is
   * that the vendor is a config value, and a default quietly reinstates a hardcoded one.
   */
  STORAGE_DRIVER: nonEmpty('STORAGE_DRIVER'),

  /** Bucket holding all generated media. Must exist before the first probe. */
  SUPABASE_STORAGE_BUCKET: nonEmpty('SUPABASE_STORAGE_BUCKET'),

  /**
   * S3-compatible endpoint. Defaults to `<SUPABASE_URL>/storage/v1/s3`, which is correct
   * for a normal project; override only when fronting storage with a custom domain.
   */
  SUPABASE_S3_ENDPOINT: z.url().optional(),

  /**
   * S3 access keys, generated in the Supabase dashboard under Storage → S3 Access Keys.
   *
   * These are *not* the service-role key and are not interchangeable with it. The
   * service-role JWT authenticates the REST storage API; the S3 protocol wants its own
   * credential pair, which is what lets the presigned-URL flow work without ever handing
   * a database-privileged token to a browser.
   */
  SUPABASE_S3_ACCESS_KEY_ID: nonEmpty('SUPABASE_S3_ACCESS_KEY_ID'),
  SUPABASE_S3_SECRET_ACCESS_KEY: nonEmpty('SUPABASE_S3_SECRET_ACCESS_KEY'),

  /** Project region. Required by SigV4 signing even though the endpoint is fixed. */
  SUPABASE_S3_REGION: nonEmpty('SUPABASE_S3_REGION').default('us-east-1'),
});

export type StorageEnv = z.infer<typeof storageEnvSchema>;
