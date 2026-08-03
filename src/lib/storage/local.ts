import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import {
  DEFAULT_EXPIRY_S,
  StorageError,
  storageKeySchema,
  type PresignGetParams,
  type PresignPutParams,
  type PresignedUrl,
  type StorageDriver,
  type StorageProbeResult,
} from './types';

/**
 * A storage driver backed by the local filesystem.
 *
 * ── What this is for, and what it is not ─────────────────────────────────────
 *
 * It exists because the ingest and assembly paths could otherwise never be executed here:
 * the object store is unreachable from this environment, and "the code is written" is
 * exactly the claim this project refuses to accept. With this registered, the ingest task
 * runs end to end for real — fetch, normalise, write, read back, `assets` row — and only
 * the vendor's own fetch is simulated.
 *
 * It is also the second implementation of `StorageDriver`, which is the same argument the
 * fal driver makes for the video interface: an interface with one implementation is a
 * shape nobody has tested. Writing this found nothing wrong, which is itself information.
 *
 * **Not for production, and it refuses to be.** `KILN_LOCAL_STORAGE_ROOT` must be set
 * explicitly — there is no default — so it cannot be selected by accident, and a
 * deployment that somehow reached it fails at construction rather than silently writing
 * media into an ephemeral container filesystem that vanishes on the next deploy.
 *
 * The presigned URLs are `file://`. They are not signed, they do not expire, and nothing
 * about them is safe to hand to a browser. That is stated here rather than papered over:
 * the harness uses them as paths, and no browser code path resolves them.
 */

const SLUG = 'local-fs';

function root(): string {
  const configured = process.env.KILN_LOCAL_STORAGE_ROOT;
  if (!configured) {
    throw new StorageError({
      slug: SLUG,
      code: 'auth',
      message:
        'KILN_LOCAL_STORAGE_ROOT is not set. The local driver has no default on purpose — ' +
        'it is a test seam, and a default would let a real deployment select it silently.',
    });
  }
  return resolve(configured);
}

function pathFor(key: string): string {
  const safe = storageKeySchema.parse(key);
  const full = join(root(), safe);
  // Belt and braces. `storageKeySchema` already refuses `..`, but this driver turns keys
  // into filesystem paths, and the cost of being wrong is writing outside the root.
  if (!full.startsWith(root())) {
    throw new StorageError({ slug: SLUG, code: 'invalid_key', message: 'key escapes the root' });
  }
  return full;
}

export function createLocalStorageDriver(): StorageDriver {
  return {
    slug: SLUG,
    get bucket() {
      return root();
    },

    async presignPut(params: PresignPutParams): Promise<PresignedUrl> {
      const key = storageKeySchema.parse(params.key);
      await mkdir(dirname(pathFor(key)), { recursive: true });
      return {
        url: `file://${pathFor(key)}`,
        key,
        expiresAt: new Date(Date.now() + (params.expiresIn ?? DEFAULT_EXPIRY_S) * 1000).toISOString(),
      };
    },

    async presignGet(params: PresignGetParams): Promise<PresignedUrl> {
      const key = storageKeySchema.parse(params.key);
      return {
        url: `file://${pathFor(key)}`,
        key,
        expiresAt: new Date(Date.now() + (params.expiresIn ?? DEFAULT_EXPIRY_S) * 1000).toISOString(),
      };
    },

    async delete(key: string): Promise<void> {
      // Idempotent, as the interface requires: deleting an absent key succeeds.
      await rm(pathFor(key), { force: true });
    },

    async probe(): Promise<StorageProbeResult> {
      const started = Date.now();
      const key = `probe/${process.pid}-${Date.now()}.txt`;
      const payload = `kiln probe ${Date.now()}`;
      const steps = { write: false, read: false, delete: false };

      try {
        const path = pathFor(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, payload);
        steps.write = true;

        const read = await readFile(path, 'utf8');
        steps.read = read === payload;

        await rm(path, { force: true });
        steps.delete = !(await stat(path).then(
          () => true,
          () => false,
        ));

        const ok = steps.write && steps.read && steps.delete;
        return {
          ok,
          latencyMs: Date.now() - started,
          steps,
          detail: ok
            ? `Local filesystem round trip under ${root()}. Bytes matched.`
            : 'Local round trip failed part-way.',
        };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          steps,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/**
 * Write a stream to a key. Not on the interface, and deliberately.
 *
 * `StorageDriver` hands out URLs precisely so that no route can be tempted to move bytes
 * through Vercel (rule 2). The ingest worker needs to write bytes it just downloaded, and
 * it runs in a Trigger container where that limit does not apply — so this is exported
 * from the driver module rather than added to the interface every caller can see.
 */
export async function writeStreamLocal(key: string, stream: Readable): Promise<number> {
  const path = pathFor(key);
  await mkdir(dirname(path), { recursive: true });
  await pipeline(stream, createWriteStream(path));
  const { size } = await stat(path);
  return size;
}

export function readStreamLocal(key: string): Readable {
  return createReadStream(pathFor(key));
}

export function localPathFor(key: string): string {
  return pathFor(key);
}
