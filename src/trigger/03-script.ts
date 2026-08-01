import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { env } from '@/lib/env';
import { runScriptDraft, type ScriptDraftResult } from '@/lib/script/run';

/**
 * Stage 3 — draft a script for an approved concept.
 *
 * A wrapper. The logic is in `src/lib/script/run.ts`, so that the leg can be run for real
 * from `pnpm verify:script` against the same database through the same code path. CLAUDE.md
 * rule 8 is that a feature is done when it has run against real APIs, and a verification
 * path that reimplements the thing it verifies proves only that two pieces of code agree.
 *
 * Replayable from stage 2's output: the only input is a concept id, and running it twice
 * produces a new script *version* rather than overwriting one. Old versions stay because
 * they are evidence — `scripts` is the table a demonetisation appeal is argued from
 * (ARCHITECTURE.md §0.2), and evidence you overwrite is evidence you do not have.
 */

const Payload = z.object({
  conceptId: z.uuid(),
  /** 15–60 is the short-form band. Defaulted rather than required so a replay from stage 2
   *  does not have to carry it. */
  targetSeconds: z.number().int().min(10).max(90).default(30),
});

export const scriptTask = schemaTask({
  id: '03-script',
  schema: Payload,

  /**
   * Low on purpose, and not because the API is fragile.
   *
   * Drafting is the cheapest stage and the one most likely to be fanned out over a batch of
   * approved concepts. Ten concurrent drafts against one account is how an organisation
   * rate limit gets found, and the thing that fails is not this task — it is whichever
   * generation was mid-flight when the account got throttled. The limit protects the
   * expensive stages from the cheap one.
   */
  queue: { concurrencyLimit: 3 },

  run: async (payload, { ctx }): Promise<ScriptDraftResult> =>
    runScriptDraft(payload, {
      db: serverClient(),
      apiKey: env.ANTHROPIC_API_KEY,
      usdInrRate: env.USD_INR_RATE,
      // Stable across attempts of the same run, which is the property the ledger's
      // idempotency key needs. An attempt id would charge a retry twice.
      runId: ctx.run.id,
      log: logger,
    }),
});
