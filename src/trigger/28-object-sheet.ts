import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { redrawObjectSheet } from '@/lib/bureau/object-sheets';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { STILL_CREDENTIAL_FIELD, STILL_INTEGRATION, submitStill, waitStill } from '@/lib/drivers/still-image';
import { verifiedCredential } from '@/lib/integrations/verify';
import { storage } from '@/lib/storage';
import { putterFor } from '@/lib/storage/put';

/**
 * One hero-object sheet redraw — Cuts → "Redraw sheet" on a 3D explainer (0052).
 *
 * The run's own sheets are made inside 20-episode (objectSheetsStep); this task exists for the
 * approver's redraw while the cut waits. Numbered after 27-character-sheet, its sibling: it
 * belongs to stage 5's pictures, and the number is not the running order (CLAUDE.md). On the
 * worker because the image is waited on and its bytes go vendor → worker → bucket (rules 2, 3).
 *
 * The body is `redrawObjectSheet` (src/lib/bureau/object-sheets.ts), which `verify:engineered`
 * drives with a stub vendor; this file resolves configuration and hands it down, and every
 * refusal is in the lib. The new sheet is locked for every picture drawn after it.
 *
 * Caller: the "Redraw sheet" button on Cuts (`redrawObjectSheetAction` →
 * requestObjectSheetRedraw → productionObjectSheetEffects.startObjectSheet).
 *
 * Replay: the attempt number is in the idempotency key, so a replay that finds the previous
 * attempt made draws the NEXT one — so no automatic retry (a retry after the vendor was called
 * would pay for a second image), exactly as 25-redraw and 27-character-sheet. Concurrency 1.
 */

const Payload = z.object({
  episodeId: z.uuid(),
  tag: z.string().min(3).max(16),
  note: z.string().max(200).nullable(),
  requestId: z.uuid(),
});

export const objectSheetTask = schemaTask({
  id: '28-object-sheet',
  schema: Payload,
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },
  maxDuration: 600,

  run: async (payload) => {
    const db = serverClient();
    const put = putterFor(storage()).put;
    const usdInrRate = await requireUsdInrRate(db, 'writing the cost rows for 28-object-sheet');
    const r = await redrawObjectSheet(db, { episodeId: payload.episodeId, tag: payload.tag, note: payload.note }, {
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
    logger.info('object sheet', r);
    return r;
  },
});
