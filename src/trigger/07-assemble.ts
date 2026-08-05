import type { Readable } from 'node:stream';

import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { runAssemble } from '@/lib/assemble/run';
import { serverClient } from '@/lib/db/server';
import { putterFor } from '@/lib/storage/put';
import { storage } from '@/lib/storage';
import { writeStreamLocal } from '@/lib/storage/local';

/**
 * Stage 7 — the rough cut.
 *
 * ffmpeg, therefore not Vercel (rule 3). Replayable from a script id alone: it re-resolves
 * the current assets each time, so re-running after a shot was regenerated picks up the
 * replacement without any other state.
 *
 * Every clip is downloaded to the container through a presigned GET before ffmpeg sees it,
 * and the temp directory is released on success and failure alike. That path is no longer
 * driver-specific — the earlier version threw for anything but the local driver, which
 * meant the production path had never run.
 */

const Payload = z.object({
  scriptId: z.uuid(),
  variantLabel: z.string().min(1).max(40).default('rough'),
});

export const assembleTask = schemaTask({
  id: '07-assemble',
  schema: Payload,

  // One at a time. Concat is a stream copy and fast, but a run now holds every clip on
  // disk at once, so the container's disk is the ceiling rather than its CPU.
  queue: { concurrencyLimit: 2 },
  machine: 'small-2x',

  run: async (payload) => {
    const db = serverClient();

    const result = await runAssemble(payload, {
      db,
      driver: storage(),
      putBytes: putterFor().put,
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
