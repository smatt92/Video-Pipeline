import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

import { env } from './env';

/**
 * Cloudflare R2.
 *
 * The rule this module exists to enforce: media bytes never pass through a Next.js
 * route. Vercel caps a function's request and response body at 4.5 MB and it is not
 * configurable (ARCHITECTURE.md §2), so a 30-second 1080p clip cannot be proxied even
 * once. Everything here hands out a *URL* and gets out of the way:
 *
 *   browser  ──presigned PUT──►  R2
 *   browser  ◄─presigned GET──   R2
 *   worker   ──direct SDK────►   R2
 *
 * If you find yourself wanting a `uploadFile(bytes)` helper in this file, the upload
 * belongs in `src/trigger/` instead.
 */

const s3 = new S3Client({
  region: 'auto',
  endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

/** Presigned URLs are short-lived by default: a leaked one should expire before it is useful. */
const DEFAULT_EXPIRY_S = 15 * 60;
const MAX_EXPIRY_S = 7 * 24 * 60 * 60; // R2/SigV4 hard ceiling.

/**
 * Object keys are built, never accepted from a client. A key that arrives over the wire
 * is a path-traversal or an overwrite of someone else's asset waiting to happen.
 */
const r2KeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    /^[a-zA-Z0-9!_.*'()\-/]+$/,
    'r2 key contains characters outside the S3 safe set',
  )
  .refine((k) => !k.includes('..'), 'r2 key must not traverse')
  .refine((k) => !k.startsWith('/'), 'r2 key must not start with /');

export type R2Key = z.infer<typeof r2KeySchema>;

function assertExpiry(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_EXPIRY_S) {
    throw new Error(`presign expiry must be 1..${MAX_EXPIRY_S}s, got ${seconds}`);
  }
  return seconds;
}

/**
 * Build the key for a generated asset. Deterministic and collision-free: the generation
 * id is unique, so a retry that reuses it overwrites its own object rather than
 * accumulating orphans.
 */
export function assetKey(params: {
  generationId: string;
  kind: 'video' | 'audio' | 'image' | 'caption' | 'music';
  extension: string;
}): R2Key {
  const ext = params.extension.replace(/^\./, '').toLowerCase();
  return r2KeySchema.parse(`generations/${params.generationId}/${params.kind}.${ext}`);
}

/**
 * A URL the browser can PUT bytes directly to. `contentType` and `contentLength` are
 * signed into the request, so a client cannot upload something other than what it
 * declared, or something larger.
 */
export async function presignPut(params: {
  key: string;
  contentType: string;
  contentLength?: number;
  expiresIn?: number;
}): Promise<{ url: string; key: R2Key; expiresAt: string }> {
  const key = r2KeySchema.parse(params.key);
  const expiresIn = assertExpiry(params.expiresIn ?? DEFAULT_EXPIRY_S);

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
    }),
    { expiresIn },
  );

  return { url, key, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

/** A URL the browser can GET bytes directly from, for private objects. */
export async function presignGet(params: {
  key: string;
  expiresIn?: number;
  /** Sets Content-Disposition: attachment, for the Phase 1 manual download path. */
  downloadAs?: string;
}): Promise<{ url: string; expiresAt: string }> {
  const key = r2KeySchema.parse(params.key);
  const expiresIn = assertExpiry(params.expiresIn ?? DEFAULT_EXPIRY_S);

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      ResponseContentDisposition: params.downloadAs
        ? `attachment; filename="${params.downloadAs.replace(/"/g, '')}"`
        : undefined,
    }),
    { expiresIn },
  );

  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

/**
 * Stable, unsigned URL for objects that must be readable by a third party — Instagram's
 * container API fetches `video_url` itself and cannot present a signature.
 *
 * Only meaningful for a bucket with public access configured; returns null otherwise,
 * so callers have to handle the case rather than emitting a URL that 403s.
 */
export function publicUrl(key: string): string | null {
  const base = env.R2_PUBLIC_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${r2KeySchema.parse(key)}`;
}

/** Existence and size, without transferring the object. */
export async function head(key: string): Promise<{ bytes: number; contentType?: string } | null> {
  try {
    const res = await s3.send(
      new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: r2KeySchema.parse(key) }),
    );
    return { bytes: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      '$metadata' in err &&
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw err;
  }
}

export { s3 as r2Client };
