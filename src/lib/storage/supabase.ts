import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../env';
import {
  DEFAULT_EXPIRY_S,
  MAX_EXPIRY_S,
  StorageError,
  storageKeySchema,
  type PresignGetParams,
  type PresignPutParams,
  type PresignedUrl,
  type StorageDriver,
  type StorageProbeResult,
} from './types';

/**
 * Supabase Storage over its S3-compatible protocol.
 *
 * Using the S3 protocol rather than the `supabase-js` storage client is deliberate: it is
 * the only one of the two that presigns URLs the browser can PUT to directly, which is
 * the whole reason this layer exists (CLAUDE.md rule 2). It also means swapping to any
 * other S3-compatible store — R2, B2, MinIO — is a change to the client construction
 * below and nothing else.
 *
 * Two things about this endpoint that differ from AWS proper and will waste an afternoon
 * if you don't know them:
 *
 *   1. `forcePathStyle` must be true. Supabase serves buckets as a path segment, not as a
 *      subdomain, so the virtual-hosted addressing the SDK defaults to produces a URL
 *      that resolves to nothing.
 *   2. The S3 access keys are a separate credential from the service-role key. The
 *      service-role JWT authenticates the REST storage API; the S3 protocol wants its own
 *      pair. They are not interchangeable, and the failure mode is a 403 that reads like
 *      a permissions problem rather than a wrong-credential-type problem.
 */

const SLUG = 'supabase-storage';

function endpoint(): string {
  return env.SUPABASE_S3_ENDPOINT ?? `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '')}/storage/v1/s3`;
}

function assertExpiry(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_EXPIRY_S) {
    throw new StorageError({
      slug: SLUG,
      code: 'invalid_key',
      message: `presign expiry must be 1..${MAX_EXPIRY_S}s, got ${seconds}`,
    });
  }
  return seconds;
}

function parseKey(key: string): string {
  const result = storageKeySchema.safeParse(key);
  if (!result.success) {
    throw new StorageError({
      slug: SLUG,
      code: 'invalid_key',
      message: `rejected storage key: ${result.error.issues.map((i) => i.message).join('; ')}`,
      cause: result.error,
    });
  }
  return result.data;
}

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && '$metadata' in err) {
    return (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  }
  return undefined;
}

function wrap(err: unknown, what: string): StorageError {
  const status = httpStatusOf(err);
  const code =
    status === 401 || status === 403
      ? 'auth'
      : status === 404
        ? 'not_found'
        : status !== undefined
          ? 'upstream'
          : 'unknown';

  return new StorageError({
    slug: SLUG,
    code,
    message: `${what} failed${status ? ` (HTTP ${status})` : ''}: ${
      err instanceof Error ? err.message : String(err)
    }`,
    cause: err,
  });
}

/**
 * Credentials for this driver, supplied explicitly.
 *
 * The constructor takes them rather than reading the environment because migration 0003
 * moved credentials into the `integrations` table behind Vault: a driver is built per-call
 * from an integration record. It also makes onboarding step 2 possible at all — the wizard
 * has to probe a key the user just typed, which by definition is not in `process.env`.
 *
 * Omitting them falls back to the environment, which is the local-development and worker
 * bootstrap path.
 */
export interface SupabaseStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
}

export function createSupabaseStorageDriver(
  creds?: SupabaseStorageCredentials,
): StorageDriver {
  const accessKeyId = creds?.accessKeyId ?? env.SUPABASE_S3_ACCESS_KEY_ID;
  const secretAccessKey = creds?.secretAccessKey ?? env.SUPABASE_S3_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new StorageError({
      slug: SLUG,
      code: 'auth',
      message:
        'No storage credentials. They live on the storage integration record and are ' +
        'read from Vault; the environment is only a local fallback. Run onboarding step ' +
        '2, or set SUPABASE_S3_ACCESS_KEY_ID and SUPABASE_S3_SECRET_ACCESS_KEY.',
    });
  }

  const bucket = creds?.bucket ?? env.SUPABASE_STORAGE_BUCKET;

  const s3 = new S3Client({
    region: creds?.region ?? env.SUPABASE_S3_REGION,
    endpoint: creds?.endpoint ?? endpoint(),
    // Not optional — see note 1 above.
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    slug: SLUG,
    bucket,

    async presignPut(params: PresignPutParams): Promise<PresignedUrl> {
      const key = parseKey(params.key);
      const expiresIn = assertExpiry(params.expiresIn ?? DEFAULT_EXPIRY_S);

      try {
        const url = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: params.contentType,
            ContentLength: params.contentLength,
          }),
          { expiresIn },
        );
        return { url, key, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
      } catch (err) {
        throw wrap(err, 'presignPut');
      }
    },

    async presignGet(params: PresignGetParams): Promise<PresignedUrl> {
      const key = parseKey(params.key);
      const expiresIn = assertExpiry(params.expiresIn ?? DEFAULT_EXPIRY_S);

      try {
        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ResponseContentDisposition: params.downloadAs
              ? `attachment; filename="${params.downloadAs.replace(/"/g, '')}"`
              : undefined,
          }),
          { expiresIn },
        );
        return { url, key, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
      } catch (err) {
        throw wrap(err, 'presignGet');
      }
    },

    async delete(key: string): Promise<void> {
      const parsed = parseKey(key);
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: parsed }));
      } catch (err) {
        // S3 delete is idempotent; a 404 means the desired state already holds.
        if (httpStatusOf(err) === 404) return;
        throw wrap(err, 'delete');
      }
    },

    /**
     * Write → read back → delete, against the real bucket.
     *
     * Deliberately not a credential format check. A key that authenticates but cannot
     * write, or writes but cannot read back, fails in the middle of the first generation
     * — which is exactly the discovery point onboarding exists to move earlier.
     *
     * The probe object is namespaced and timestamped so a failure that skips the delete
     * step leaves something obviously disposable rather than a mystery.
     */
    async probe(): Promise<StorageProbeResult> {
      const startedAt = Date.now();
      const key = `_probe/${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
        .toString(36)
        .slice(2, 10)}.txt`;
      const body = `kiln storage probe ${new Date().toISOString()}`;
      const steps = { write: false, read: false, delete: false };

      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: 'text/plain',
          }),
        );
        steps.write = true;

        const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const roundTripped = await got.Body?.transformToString();
        steps.read = roundTripped === body;

        if (!steps.read) {
          return {
            ok: false,
            detail:
              'Wrote an object but read back different bytes. The bucket is reachable, ' +
              'so this is not a credential problem — check for a proxy or a cache in front of it.',
            latencyMs: Date.now() - startedAt,
            steps,
          };
        }

        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        steps.delete = true;

        return {
          ok: true,
          detail: `Wrote, read back and deleted a probe object in bucket "${bucket}".`,
          latencyMs: Date.now() - startedAt,
          steps,
        };
      } catch (err) {
        const wrapped = wrap(err, 'probe');
        const hint =
          wrapped.code === 'auth'
            ? ' Check that these are S3 access keys from Storage → S3 Access Keys, not the service-role key.'
            : wrapped.code === 'not_found'
              ? ` Bucket "${bucket}" was not found — it must be created before the first probe.`
              : '';

        return {
          ok: false,
          detail: `${wrapped.message}${hint}`,
          latencyMs: Date.now() - startedAt,
          steps,
        };
      }
    },
  };
}
