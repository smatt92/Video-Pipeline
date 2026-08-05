import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { env } from '@/lib/env';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { expectedWebhookSecret } from '@/lib/drivers/video-status';
import { resolveDriver } from '@/lib/integrations/resolve';
import { submitShots, type SubmitOutcome } from '@/lib/generate/submit';

/**
 * Stage 5 — submit a script's compiled shots.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The caller `submitShots` never had
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `submitShots` was complete, tested by nothing, and reachable from nowhere: no task, no
 * action, no tool. STATE.md called that out and reading it to fix it found the larger
 * half — it did not call a vendor either. Both are fixed together, because either alone
 * makes things worse: a caller without the vendor call writes ledger rows for work that
 * never happens, and a vendor call with no caller is what was already there.
 *
 * ── Concurrency comes from the integration row, not from here ────────────────
 *
 * The `queue.concurrencyLimit` below bounds *runs of this task* — one per script. The
 * number that matters is how many submits are in flight against the account, and that is
 * an account-wide ceiling this process cannot know: it is read from the integration row
 * and passed into `submitShots`, which runs a fixed pool of that width.
 *
 * Setting the Trigger limit to the vendor's number would be wrong in both directions. Two
 * scripts submitting at once would double it, and a single script with twelve shots would
 * be held to one.
 *
 * ── Why this stage cannot enqueue its own follow-up ──────────────────────────
 *
 * There is no chained "wait for the shots" here, and there must not be. Completion arrives
 * by webhook (rule 4), the callback confirms against the vendor's own status endpoint, and
 * *that* enqueues the ingest. A task that waited would hold a worker open for the length of
 * a video generation and would still be wrong, because the thing it waited for is delivered
 * somewhere else.
 *
 * ── Refusing is a normal outcome, not a failure ──────────────────────────────
 *
 * On a fresh install this returns `submitted: 0` with a reason per shot, and that is
 * correct rather than broken. Shots with no compiled parameters (no library recipe), shots
 * still carrying the shotlist's duration estimate rather than a measured one, an
 * unverified credential, an unpriced model — each is a refusal with a name. The task
 * succeeds and reports them. A thrown error would make Trigger retry a state that retrying
 * cannot change.
 *
 * The one case that *does* throw is a missing credential, and deliberately: it is a
 * configuration fault rather than a per-shot one, it is identical for every shot, and
 * writing twelve identical refusals would bury it.
 */

const Payload = z.object({
  scriptId: z.uuid(),
});

export const generateTask = schemaTask({
  id: '05-generate',
  schema: Payload,

  // One script at a time. The vendor-side ceiling is enforced inside submitShots from the
  // integration row; this only stops two scripts from racing each other into it.
  queue: { concurrencyLimit: 1 },

  run: async (payload): Promise<SubmitOutcome> => {
    const db = serverClient();

    // Resolved in a library function so its refusals are drivable — see
    // `src/lib/integrations/resolve.ts`. The `throw` below is a rethrow of a named refusal
    // and contains no decision of its own, which is the only shape of refusal that belongs
    // in a task: nothing imports a task, so a decision written here is untestable.
    // Two: the API key and its secret. The third catalogue field is the webhook shared
    // secret, which comes through the driver layer below and is refused by submitShots.
    const driver = await resolveDriver(db, 'video', 2);
    if (!driver.ok) throw new Error(`${driver.code}: ${driver.detail}`);
    const [apiKey, apiSecret] = driver.secrets;

    // Through the driver layer, not from `env` directly: the variable carries the vendor's
    // name and `pnpm check:vendors` refuses it here, correctly. The driver already had this
    // accessor for the receiving side of the same secret.
    //
    // ── Resolved here, decided in submitShots ────────────────────────────────
    //
    // Both of these used to be `throw`s in this file, and both were unreachable from every
    // harness in the repo — nothing imports a Trigger task, so a guard written here is a
    // guard no test can drive. They now live in `submitShots`, which refuses on either with
    // a named code that `verify:submit` exercises by passing an empty string.
    //
    // What is left here is resolution: read the environment, hand the values down. That is
    // the task's job. Deciding whether they are sufficient is the function's.
    const webhookSecret = expectedWebhookSecret() ?? '';
    const webhookBaseUrl = env.WEBHOOK_CALLBACK_BASE_URL ?? '';

    // The account-wide ceiling, read rather than assumed, and resolved alongside the
    // credentials. Null means the integration row is absent — not that the ceiling is zero.
    const concurrency = driver.concurrencyLimit ?? 1;

    logger.info('submitting', {
      scriptId: payload.scriptId,
      driver: driver.slug,
      concurrency,
      concurrencySource: driver.concurrencySource ?? 'absent',
    });

    const outcome = await submitShots(payload.scriptId, {
      db,
      apiKey,
      apiSecret,
      webhookBaseUrl,
      webhookSecret,
      usdInrRate: await requireUsdInrRate(db, 'writing the cost row for 05-generate'),
      concurrency,
      log: logger,
    });

    if (outcome.ok && outcome.submitted === 0) {
      // Loud, because "nothing happened" is the outcome most likely to be read as success
      // and most likely to mean the library is empty or stage 6 has not run.
      logger.warn('nothing was submitted', {
        scriptId: payload.scriptId,
        skipped: outcome.skipped,
      });
    }

    return outcome;
  },
});
