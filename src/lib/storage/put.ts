import type { Readable } from 'node:stream';

import { localPathFor, writeStreamLocal } from './local';
import { storage } from './index';
import type { StorageDriver } from './types';

/**
 * Writing bytes, resolved per driver — one implementation, not two.
 *
 * ── Why this is not on `StorageDriver` ───────────────────────────────────────
 *
 * The interface hands out URLs and never bytes, so that no Vercel route can be tempted to
 * proxy media (rule 2). A worker has no such limit, so the write is resolved here rather
 * than by widening an interface every call site can see.
 *
 * ── Why it moved out of the tasks ────────────────────────────────────────────
 *
 * `05b-ingest.ts` and `07-assemble.ts` each carried a `putterFor()` doing this, with the
 * same presign, the same buffering, and the same `throw new Error('Presigned PUT returned
 * …')`. Two things were wrong with that at once:
 *
 *   · **Two modules for one concept.** They had already drifted in shape — one returned an
 *     object with an optional `localPath`, the other a bare function — and the next person
 *     to tune the upload had a coin-flip's chance of editing the copy their stage did not
 *     use. Deleted rather than documented: git is the history.
 *
 *   · **The refusal was unreachable.** No harness imports a Trigger task, so a `throw`
 *     written in one is a guard no test can drive. Here it is an ordinary library function
 *     and `verify:ingest` reaches it by handing over a driver whose presigned URL rejects.
 *
 * Reading is deliberately not resolved here. That goes through `presignGet`, which is the
 * same door the browser uses — a privileged read path could work while the one the product
 * depends on is broken.
 */

export interface Putter {
  put: (key: string, body: Readable) => Promise<number>;
  /** Only the local driver can name a filesystem path; absent for object stores. */
  localPath?: (key: string) => string;
}

/**
 * `driver` is injectable so a harness can drive the failure branch below without standing
 * up an object store that rejects on purpose. Defaults to the configured one, which is what
 * every production caller wants and none of them should have to say.
 */
export function putterFor(driver: StorageDriver = storage()): Putter {
  if (driver.slug === 'local-fs') {
    return { put: writeStreamLocal, localPath: localPathFor };
  }

  return {
    put: async (key, body) => {
      // Presign and stream to it — the same URL shape a browser would use, so this
      // exercises the mechanism the browser upload depends on rather than a privileged
      // side channel that could work while that one is broken.
      const signed = await driver.presignPut({ key, contentType: 'video/mp4' });
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);

      const response = await fetch(signed.url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
        headers: { 'content-type': 'video/mp4' },
      });

      if (!response.ok) {
        // Names the key and the status. A generic upload failure sends somebody to the
        // bucket configuration when the answer is often an expired signature on one object.
        throw new Error(
          `Presigned PUT returned ${response.status} for ${key}. The bytes were produced and `
            + 'not stored, so whatever generated them has been paid for and has nowhere to live.',
        );
      }

      return bytes.length;
    },
  };
}
