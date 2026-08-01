import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { env } from '@/lib/env';
import { requireCredential } from '@/lib/integrations/credentials';
import { runShotlist, type ShotlistRunResult } from '@/lib/shots/run';

/**
 * Stage 4 — break a script into shots, and compile each against the prompt library.
 *
 * A wrapper, like `03-script.ts`. The logic is in `src/lib/shots/run.ts` so the leg can be
 * run for real outside Trigger through the same code path.
 *
 * Replayable from stage 3's output: the only input is a script id, and a re-run replaces
 * the shotlist wholesale rather than merging into it. Two half-merged shotlists are a video
 * nobody designed.
 *
 * ── What it will and will not do ─────────────────────────────────────────────
 *
 * It writes shots, their descriptions, and the stretch of voiceover each covers. It does
 * not invent driver parameters — those are *selected* from the prompt library, and on a
 * fresh install there is nothing to select. Every shot then comes back unresolved with a
 * note saying so, which is the correct outcome rather than a failure: production reads the
 * library and never improvises (CLAUDE.md), and a plausible-sounding motion name costs real
 * credits to discover was wrong.
 */

const Payload = z.object({
  scriptId: z.uuid(),
  targetSeconds: z.number().int().min(10).max(90).default(30),
});

export const shotlistTask = schemaTask({
  id: '04-prompt-compile',
  schema: Payload,

  /** Same reasoning as stage 3: the cheap stage should not be what finds the account's
   *  rate limit and takes an in-flight generation down with it. */
  queue: { concurrencyLimit: 3 },

  run: async (payload, { ctx }): Promise<ShotlistRunResult> => {
    const db = serverClient();
    const apiKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');

    return runShotlist(payload, {
      db,
      apiKey,
      usdInrRate: env.USD_INR_RATE,
      // Which driver's recipes to compile against. Absent means no video driver has been
      // selected yet, in which case nothing can resolve and every shot says so.
      videoDriver: env.VIDEO_DRIVER ?? 'unset',
      runId: ctx.run.id,
      log: logger,
    });
  },
});
