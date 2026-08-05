import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { primaryForKind } from '@/lib/drivers/catalog';
import { serverClient } from '@/lib/db/server';
import { requireEnv } from '@/lib/env';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { expectedWebhookSecret } from '@/lib/drivers/video-status';
import { requireCredential } from '@/lib/integrations/credentials';
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

    const video = primaryForKind('video');
    if (!video) {
      throw new Error('No integration in the catalogue is marked primary for video.');
    }

    // Throws when absent, and that is the intended shape — see the note above. The message
    // names the integration and the field, because "credential missing" without either is
    // a message that sends someone to the wrong settings screen.
    const apiKey = await requireCredential(db, video.slug, video.secretFields[0].key);
    const apiSecret = await requireCredential(db, video.slug, video.secretFields[1].key);

    // Through the driver layer, not from `env` directly: the variable carries the vendor's
    // name and `pnpm check:vendors` refuses it here, correctly. The driver already had this
    // accessor for the receiving side of the same secret.
    const webhookSecret = expectedWebhookSecret();

    // Same class as the missing secret below: a submit whose completion has nowhere to
    // arrive. Separate check so the message names which half is absent.
    //
    // Through `requireEnv` rather than a hand-rolled `if (!env.X) throw`, which is what
    // this was. The variable is optional at boot on purpose and `src/lib/env.ts` says so
    // in five places, each promising that `requireEnv` catches it at the point of use —
    // and `requireEnv` had no callers anywhere in the repo. The behaviour was right and
    // the mechanism the documentation named was inert, so deleting this line would have
    // left every one of those comments still claiming coverage.
    const webhookBaseUrl = requireEnv('WEBHOOK_CALLBACK_BASE_URL', 'submitting a generation');

    if (!webhookSecret) {
      // Refusing here rather than submitting is the whole of rule 4's safety. A submit with
      // no callback secret produces a job whose completion has nowhere to arrive: it runs,
      // it bills, and nothing ever confirms it.
      throw new Error(
        'The webhook shared secret is unset, so a completion would have nowhere to arrive. ' +
          'Refusing to submit rather than paying for a generation nothing can confirm.',
      );
    }

    // The account-wide ceiling, read rather than assumed. `concurrency_source` on the row
    // records whether this is a reading or the fallback, so a screen can say which.
    const { data: integration } = await db
      .from('integrations')
      .select('concurrency_limit, concurrency_source')
      .eq('slug', video.slug)
      .maybeSingle();

    const concurrency = integration?.concurrency_limit ?? 1;

    logger.info('submitting', {
      scriptId: payload.scriptId,
      driver: video.slug,
      concurrency,
      concurrencySource: integration?.concurrency_source ?? 'absent',
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
