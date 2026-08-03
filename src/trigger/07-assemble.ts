import type { Readable } from 'node:stream';

import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { runAssemble } from '@/lib/assemble/run';
import { serverClient } from '@/lib/db/server';
import { storage } from '@/lib/storage';
import { localPathFor, writeStreamLocal } from '@/lib/storage/local';

/**
 * Stage 7 — the rough cut.
 *
 * ffmpeg, therefore not Vercel (rule 3). Replayable from a script id alone: it re-resolves
 * the current assets each time, so re-running after a shot was regenerated picks up the
 * replacement without any other state.
 */

const Payload = z.object({
  scriptId: z.uuid(),
  variantLabel: z.string().min(1).max(40).default('rough'),
});

/**
 * The assembler needs LOCAL paths — ffmpeg reads files, not URLs.
 *
 * With an object store that means downloading each asset to the container first. That
 * download is deliberately not written yet: it has never been executed against a real
 * bucket, and a plausible-looking implementation of the one step that has to work would be
 * exactly the thing this project keeps refusing to ship. The local driver path IS executed,
 * end to end, by `pnpm verify:assemble`.
 */
function resolverFor(): {
  localPath: (key: string) => string;
  putBytes: (key: string, body: Readable) => Promise<number>;
} {
  const driver = storage();

  if (driver.slug === 'local-fs') {
    return { localPath: localPathFor, putBytes: writeStreamLocal };
  }

  throw new Error(
    `Assembly against the "${driver.slug}" driver needs each asset downloaded to the ` +
      'container before ffmpeg can read it, and that download has never been run against a ' +
      'real bucket. Implement it in this function — presignGet, stream to a temp file, hand ' +
      'back the path — and delete this throw. Refusing loudly beats a half-written path that ' +
      'produces a broken cut.',
  );
}

export const assembleTask = schemaTask({
  id: '07-assemble',
  schema: Payload,

  // One at a time. Concat is a stream copy and fast, but it reads every clip off disk at
  // once and the container's disk is the ceiling, not the CPU.
  queue: { concurrencyLimit: 2 },
  machine: 'small-2x',

  run: async (payload) => {
    const db = serverClient();
    const { localPath, putBytes } = resolverFor();

    const result = await runAssemble(payload, {
      db,
      localPath,
      putBytes,
      log: {
        info: (m, d) => logger.info(m, d as Record<string, unknown>),
        error: (m, d) => logger.error(m, d as Record<string, unknown>),
      },
    });

    if (!result.ok) {
      // The renders row is already written with status='failed'. Throwing surfaces it in
      // the Trigger dashboard too — the row is the durable record, the failed run is the
      // thing somebody notices.
      logger.error('assemble failed', { ...payload, ...result });
      throw new Error(`${result.code}: ${result.detail}`);
    }

    logger.info('assembled', result);
    return result;
  },
});
