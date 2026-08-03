import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { env } from '@/lib/env';
import { requireCredential } from '@/lib/integrations/credentials';
import { runMetadata, type MetadataRunResult } from '@/lib/metadata/run';

/**
 * Stage 9 — publishing metadata for a reviewed render.
 *
 * A wrapper, like every other stage, so the logic can be driven by a harness.
 *
 * ── It has a caller from the day it exists ───────────────────────────────────
 *
 * `requestMetadata` in `src/lib/review/actions.ts` calls this, and the harness drives
 * `runMetadata` directly. Written this way deliberately: a sweep three rounds ago found
 * four complete-and-unreachable modules, and the cheapest moment to avoid being the fifth
 * is now.
 *
 * ── Replay is safe and produces a second draft ───────────────────────────────
 *
 * Re-running writes another `publications` row rather than replacing the first. That is the
 * right shape for this stage — metadata is editorial, a second opinion is useful, and the
 * publish screen shows drafts for a render. It does mean a replay costs money each time,
 * which is why nothing triggers this automatically on review pass.
 */

const Payload = z.object({
  renderId: z.uuid(),
});

export const metadataTask = schemaTask({
  id: '09-metadata',
  schema: Payload,

  // The cheap stage must not be what finds the account's rate limit and takes an in-flight
  // generation down with it. Same reasoning as stages 2, 3 and 4.
  queue: { concurrencyLimit: 3 },

  run: async (payload, { ctx }): Promise<MetadataRunResult> => {
    const db = serverClient();
    const apiKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');

    const result = await runMetadata(payload, {
      db,
      apiKey,
      usdInrRate: env.USD_INR_RATE,
      runId: ctx.run.id,
      log: logger,
    });

    if (result.ok && !result.unique) {
      // Not a failure and not silent. One repeated shape is a coincidence; four is the
      // pattern a platform treats as templated output, and it is only visible across a
      // channel rather than in any single video.
      logger.warn('this title reuses a shape already on the channel', {
        publicationId: result.publicationId,
        shape: result.shape,
        collidesWith: result.collidesWith,
      });
    }

    return result;
  },
});
