import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { generateCharacterSheet } from '@/lib/bureau/character-sheets';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { STILL_CREDENTIAL_FIELD, STILL_INTEGRATION, submitStill, waitStill } from '@/lib/drivers/still-image';
import { verifiedCredential } from '@/lib/integrations/verify';
import { storage } from '@/lib/storage';
import { putterFor } from '@/lib/storage/put';

/**
 * One character sheet — Library → Characters → "Generate sheet" (decision 0024).
 *
 * Numbered after the redraw and the Instagram post (25, 26): it belongs to stage 5's pictures,
 * and the number is not the running order (CLAUDE.md conventions). On the worker because the
 * image is waited on with a bounded backoff and its bytes go vendor → worker → bucket; neither
 * may happen on Vercel (rules 2 and 3).
 *
 * The body is `generateCharacterSheet` (src/lib/bureau/character-sheets.ts), which a harness
 * drives with a stub vendor; this file resolves configuration and hands it down, and every
 * refusal is in the lib. The sheet is a CANDIDATE: nothing here locks it. Sahil looks at it on
 * the Characters screen and locks it there.
 *
 * Caller: the "Generate sheet" button on Library → Characters (`requestSheetAction` →
 * requestCharacterSheet → productionSheetEffects.startSheet), and the manual "Sheet probe"
 * workflow for the one real check.
 *
 * Replayable: the request id is in the idempotency key, so a replay returns the sheet it made
 * and never pays twice. No automatic retry, for the same reason as 25-redraw: a retry after the
 * vendor was called would pay for a second image. Concurrency 1.
 */

const Payload = z.object({
  channelId: z.uuid(),
  slug: z.string().min(1).max(64),
  note: z.string().max(200).nullable(),
  requestId: z.uuid(),
});

export const characterSheetTask = schemaTask({
  id: '27-character-sheet',
  schema: Payload,
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },
  maxDuration: 600,

  run: async (payload) => {
    const db = serverClient();
    const put = putterFor(storage()).put;
    const usdInrRate = await requireUsdInrRate(db, 'writing the cost rows for 27-character-sheet');
    const r = await generateCharacterSheet(db, payload, {
      usdInrRate,
      apiKey: () => verifiedCredential(db, STILL_INTEGRATION, STILL_CREDENTIAL_FIELD),
      submit: (i) => submitStill(i),
      wait: (i) => waitStill(i),
      fetchBytes: async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      },
      putBytes: put,
      log: logger,
    });
    logger.info('sheet', r);
    return r;
  },
});
