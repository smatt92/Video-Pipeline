import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { requireCredential } from '@/lib/integrations/credentials';
import { runConcepts, type ConceptRunResult } from '@/lib/concepts/run';

/**
 * Stage 2 — propose and score concepts for a channel.
 *
 * A wrapper, like every other stage. The logic is in `src/lib/concepts/run.ts` so it can be
 * driven by a harness with a different transport.
 *
 * ── It has a caller from the day it exists ───────────────────────────────────
 *
 * Written after a sweep found four complete-and-unreachable modules, so: this is invoked by
 * `proposeConceptsAction` and by the harness, and both existed before this file was
 * committed. A stage whose only caller is the Trigger dashboard is a stage that will be
 * reported as built and will not be.
 *
 * ── Replayable, and what that means when the output is a list ────────────────
 *
 * Every other stage replays by replacing its output. This one appends: a re-run with the
 * same channel proposes *more* concepts rather than the same ones, because the model is
 * shown the existing titles and told not to repeat them. That is deliberate and it is the
 * only sensible reading — a concept queue is a queue, and "replay" on a queue that has
 * already been triaged would throw away the triage.
 *
 * The consequence to know about: replaying this costs money every time and never
 * deduplicates by itself. `count` is small by default for that reason.
 */

const Payload = z.object({
  channelId: z.uuid(),
  count: z.number().int().min(1).max(10).default(5),
  seed: z.string().min(3).max(500).optional(),
});

export const conceptTask = schemaTask({
  id: '02-concept',
  schema: Payload,

  // Same reasoning as stages 3 and 4: the cheap stage must not be what finds the account's
  // rate limit and takes an in-flight generation down with it.
  queue: { concurrencyLimit: 3 },

  run: async (payload, { ctx }): Promise<ConceptRunResult> => {
    const db = serverClient();

    // From the integration record via Vault, with the environment as a local fallback — a
    // key rotated in settings must take effect on the next run without a redeploy.
    const apiKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');

    const result = await runConcepts(payload, {
      db,
      apiKey,
      usdInrRate: requireUsdInrRate('writing the cost row for 02-concept'),
      // Stable across attempts of the same run, which is what the ledger's idempotency key
      // needs. An attempt id would charge a retry twice.
      runId: ctx.run.id,
      log: logger,
    });

    if (result.ok && result.created.length === 0) {
      // Loud. A paid-for call that produced nothing usable means the prompt is drifting or
      // the niche is exhausted, and both are worth seeing before the queue empties.
      logger.warn('a paid batch produced no concepts', {
        channelId: payload.channelId,
        rejected: result.rejected,
        costInr: result.costInr,
      });
    }

    return result;
  },
});
