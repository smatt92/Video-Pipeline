import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';

import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { runIngest } from '@/lib/ingest/run';
import { storage } from '@/lib/storage';
import { localPathFor, writeStreamLocal } from '@/lib/storage/local';

/**
 * Stage 5b — ingest a confirmed generation.
 *
 * Runs here and could not run anywhere else. It downloads a video file and re-encodes it
 * with ffmpeg: a Vercel route has a 4.5 MB body cap it cannot raise (rule 2) and no ffmpeg
 * binary at all (rule 3). The webhook receiver's entire job is to confirm the outcome and
 * enqueue this.
 *
 * Replayable from stage 5's output on its own — the payload is a generation id and a URL,
 * both of which survive on the `generations` row, so re-running after a fixed bug needs no
 * regeneration and costs nothing.
 */

const Payload = z.object({
  generationId: z.uuid(),
  assetUrl: z.url(),
  kind: z.enum(['video', 'image', 'audio']).default('video'),
});

/**
 * Byte writing is driver-specific and deliberately not on `StorageDriver`.
 *
 * The interface hands out URLs so that no Vercel route can be tempted to proxy media
 * (rule 2). This worker has no such limit, so the write is resolved here per driver
 * rather than by widening an interface every call site can see.
 */
function putterFor(): {
  put: (key: string, body: Readable) => Promise<number>;
  localPath?: (key: string) => string;
} {
  const driver = storage();

  if (driver.slug === 'local-fs') {
    return { put: writeStreamLocal, localPath: localPathFor };
  }

  // The object-store path. Presign a PUT and stream to it — the same URL shape a browser
  // would use, so this exercises the mechanism the browser upload depends on rather than a
  // privileged side channel that could work while that one is broken.
  return {
    put: async (key, body) => {
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
        throw new Error(`Presigned PUT returned ${response.status} for ${key}`);
      }
      return bytes.length;
    },
  };
}

export const ingestTask = schemaTask({
  id: '05b-ingest',
  schema: Payload,

  /**
   * Bounded low. Each run holds a whole clip in a temp file and runs an ffmpeg encode, so
   * the ceiling here is the container's CPU and disk rather than any vendor's rate limit.
   * Four concurrent encodes on a shared worker is already more than the machine wants.
   */
  queue: { concurrencyLimit: 4 },

  machine: 'small-2x',

  run: async (payload) => {
    const db = serverClient();
    const { put, localPath } = putterFor();

    const result = await runIngest(payload, {
      db,
      putBytes: put,
      localPath,
      log: {
        info: (m, d) => logger.info(m, d as Record<string, unknown>),
        error: (m, d) => logger.error(m, d as Record<string, unknown>),
      },
    });

    if (!result.ok) {
      // Thrown so Trigger records a failed run, *after* the row was written. Both matter:
      // the row is the durable record, the failed run is what surfaces in the dashboard.
      logger.error('ingest failed', { ...payload, ...result });
      throw new Error(`${result.code}: ${result.detail}`);
    }

    logger.info('ingested', result);
    return result;
  },
});

// Re-exported so a harness can drive the same file read the task uses.
export { createReadStream };
