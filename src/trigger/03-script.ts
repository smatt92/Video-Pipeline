import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { requireCredential } from '@/lib/integrations/credentials';
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

  run: async (payload, { ctx }): Promise<ScriptDraftResult> => {
    const db = serverClient();

    // From the integration record via Vault, with the environment as a local fallback —
    // not straight from process.env. A key rotated in settings must take effect on the
    // next run without a redeploy, which is the whole reason 0003 moved credentials into
    // the database.
    const apiKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');

    const result = await runScriptDraft(payload, {
      db,
      apiKey,
      usdInrRate: await requireUsdInrRate(db, 'writing the cost row for 03-script'),
      // Stable across attempts of the same run, which is the property the ledger's
      // idempotency key needs. An attempt id would charge a retry twice.
      runId: ctx.run.id,
      log: logger,
    });

    // ── Stage 4, chained ────────────────────────────────────────────────────
    //
    // `04-prompt-compile` was complete and reachable from nowhere: its own header says it
    // is "replayable from stage 3's output", which was true of the design and false of the
    // running system, because stage 3 ended here and told nobody.
    //
    // Triggered rather than awaited. `triggerAndWait` would hold this task open for the
    // length of another model call for no benefit — nothing here reads the shotlist — and
    // it would make a compile failure look like a script failure, so a retry would redraft
    // a script that was fine and charge for it.
    //
    // Enqueue failure is logged and swallowed for the same reason: the script is written
    // and paid for. Losing it because the follow-up could not be queued would be the
    // expensive half failing over the cheap half.
    // Only on success. A refusal from stage 3 — no concept, an unpriced model, a response
    // that failed its schema — leaves nothing for stage 4 to compile, and queueing it
    // anyway would turn one legible failure into two.
    if (result.ok) {
      try {
        const { shotlistTask } = await import('./04-prompt-compile');
        await shotlistTask.trigger({ scriptId: result.scriptId });
      } catch (err) {
        logger.error('script drafted, but stage 4 could not be enqueued', {
          scriptId: result.scriptId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  },
});
