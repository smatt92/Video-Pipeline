#!/usr/bin/env node
/**
 * Prove the storage layer works against the real bucket — four real operations.
 *
 * ⚠️  UNVERIFIED. Never executed: the environment it was written in has no network route
 * to any Supabase host. Two vendor-specific details below are reasoned from the S3
 * protocol rather than observed, and are the most likely cause of a first-run failure:
 *
 *   - `forcePathStyle: true` is required. Supabase serves buckets as a path segment, not
 *     as a subdomain, so the SDK's default virtual-hosted addressing resolves to nothing.
 *   - The S3 access keys are a *separate credential* from the service-role key. A 403
 *     here usually means the service-role key was pasted into SUPABASE_S3_ACCESS_KEY_ID.
 *
 * Unlike a credentials check, this exercises the exact path the pipeline uses:
 *
 *   1. presign a PUT          — the browser upload path (never proxied through Vercel)
 *   2. upload through it      — a real HTTP PUT to the presigned URL, no SDK
 *   3. read it back           — presigned GET, and the bytes must match
 *   4. delete, confirm gone   — a subsequent GET must 404
 *
 * Step 2 uses plain fetch deliberately. Uploading with the SDK would prove the SDK works;
 * the thing that must work is a URL a browser can use with no credentials at all.
 *
 * Usage: node scripts/verify-storage.mjs
 *        Reads the same env the app does. Run with .env.local loaded.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const required = [
  'SUPABASE_STORAGE_BUCKET',
  'SUPABASE_S3_ACCESS_KEY_ID',
  'SUPABASE_S3_SECRET_ACCESS_KEY',
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`missing environment: ${missing.join(', ')}`);
  console.error('Run with .env.local loaded, e.g. `node --env-file=.env.local scripts/verify-storage.mjs`');
  process.exit(2);
}

const bucket = process.env.SUPABASE_STORAGE_BUCKET;
const endpoint =
  process.env.SUPABASE_S3_ENDPOINT ??
  `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')}/storage/v1/s3`;

if (!endpoint || endpoint === '/storage/v1/s3') {
  console.error('set SUPABASE_S3_ENDPOINT, or NEXT_PUBLIC_SUPABASE_URL so it can be derived');
  process.exit(2);
}

const s3 = new S3Client({
  region: process.env.SUPABASE_S3_REGION ?? 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.SUPABASE_S3_SECRET_ACCESS_KEY,
  },
});

const key = `_verify/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
const body = `kiln storage verification ${new Date().toISOString()}`;
let failed = 0;
let uploaded = false;

const pass = (l, d) => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const fail = (l, d) => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failed++;
};

console.log(`Storage verification\n  bucket:   ${bucket}\n  endpoint: ${endpoint}\n`);

// ── 1. Presign a PUT ─────────────────────────────────────────────────────────
let putUrl;
try {
  putUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: 'text/plain' }),
    { expiresIn: 300 },
  );
  pass('presign PUT', `${putUrl.slice(0, 60)}…`);
} catch (err) {
  fail('presign PUT', err.message);
  process.exit(1);
}

// ── 2. Upload through it, as a browser would ─────────────────────────────────
try {
  const res = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body,
  });
  if (res.ok) {
    uploaded = true;
    pass('upload via presigned URL', `HTTP ${res.status}, ${body.length} bytes`);
  } else {
    const detail = await res.text().catch(() => '');
    fail(
      'upload via presigned URL',
      `HTTP ${res.status}. ${
        res.status === 403
          ? 'Check these are S3 access keys from Settings → Storage, not the service-role key.'
          : res.status === 404
            ? `Bucket "${bucket}" may not exist.`
            : detail.slice(0, 200)
      }`,
    );
  }
} catch (err) {
  fail('upload via presigned URL', err.message);
}

// ── 3. Read it back, and compare bytes ───────────────────────────────────────
if (uploaded) {
  try {
    const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: 300,
    });
    const res = await fetch(getUrl);
    const text = await res.text();
    if (res.ok && text === body) {
      pass('read back via presigned GET', 'bytes match exactly');
    } else if (res.ok) {
      fail('read back via presigned GET', `content differs (got ${text.length} bytes)`);
    } else {
      fail('read back via presigned GET', `HTTP ${res.status}`);
    }
  } catch (err) {
    fail('read back via presigned GET', err.message);
  }
}

// ── 4. Delete, then prove it is gone ─────────────────────────────────────────
if (uploaded) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

    let stillThere = false;
    try {
      await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      stillThere = true;
    } catch (err) {
      const status = err?.$metadata?.httpStatusCode;
      if (status !== 404 && status !== 403) throw err;
    }

    if (stillThere) {
      fail('delete removes the object', 'a GET after delete still returned the object');
    } else {
      pass('delete removes the object', 'a subsequent GET no longer finds it');
      uploaded = false;
    }
  } catch (err) {
    fail('delete removes the object', err.message);
  }
}

if (uploaded) {
  console.error(`\nLEFTOVER: ${key} was uploaded but not deleted. Remove it manually.`);
}

console.log(
  failed === 0
    ? '\nStorage works: presigned PUT, upload, read back identical bytes, delete confirmed.'
    : `\n${failed} check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
