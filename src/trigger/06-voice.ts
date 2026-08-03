import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { DEFAULT_CONCURRENCY, primaryForKind } from '@/lib/drivers/catalog';
import { env } from '@/lib/env';
import { requireCredential } from '@/lib/integrations/credentials';
import { runVoice, type VoiceRunResult } from '@/lib/voice/run';

/**
 * Stage 6 — voice. Numbered 6 and scheduled **before** 5.
 *
 * The numbering is the pipeline stage, not the running order. Addendum 02 §1 inverted the
 * DAG: VO first, its word timings set shot durations, video generated to fit real speech.
 * Renumbering the files would have made every reference in the architecture doc wrong to
 * fix a comment, so the number stays and the order is a fact about the graph.
 *
 * ** NEVER RUN. ** The vendor host is refused by this environment's egress policy.
 */

const Payload = z.object({
  scriptId: z.uuid(),
  voiceId: z.string().min(1),
  language: z.string().min(2).default('en'),
  format: z.enum(['short', 'long']).default('short'),
  seed: z.number().int().optional(),
});

export const voiceTask = schemaTask({
  id: '06-voice',
  schema: Payload,

  /**
   * One script at a time per worker. The real ceiling is the account's parallel-request
   * limit, read from the integration record at run time — a hardcoded number above the
   * true limit produces a steady failure rate that reads as vendor flakiness, which is why
   * `concurrency_source` exists to say whether anybody actually read it.
   *
   * Trigger's queue limit and the vendor's are different things: this bounds runs, the
   * value passed into `runVoice` bounds requests. Setting this one alone would let two runs
   * each open the vendor's full allowance.
   */
  queue: { concurrencyLimit: 2 },

  run: async (payload, { ctx }): Promise<VoiceRunResult> => {
    const db = serverClient();

    // By capability, not by name. Swapping the voice vendor is a catalogue row.
    const audio = primaryForKind('audio');
    if (!audio) throw new Error('No audio integration is marked primary in the catalogue.');

    const apiKey = await requireCredential(db, audio.slug, audio.secretFields[0].key);

    // Read, never assumed. Null means nothing established one and the conservative floor
    // applies — guessing high produces a constant failure rate blamed on the vendor.
    const { data: integration } = await db
      .from('integrations')
      .select('concurrency_limit, concurrency_source')
      .eq('slug', audio.slug)
      .maybeSingle();

    const concurrency = integration?.concurrency_limit ?? DEFAULT_CONCURRENCY;

    if (integration?.concurrency_source !== 'tier') {
      logger.info('concurrency is not a reading', {
        concurrency,
        source: integration?.concurrency_source ?? 'unset',
      });
    }

    const result = await runVoice(payload, {
      db,
      apiKey,
      usdInrRate: env.USD_INR_RATE,
      concurrency,
      runId: ctx.run.id,
      log: logger,
    });

    // ── Then stage 5, which was waiting on exactly this ─────────────────────
    //
    // The last link in the chain, and the one that makes the audio-first ordering real
    // rather than documented. Stage 5 refuses any shot whose `duration_source` is still an
    // estimate; this stage is what sets `derived_from_vo`, so it is the only correct place
    // to hand over.
    //
    // Triggered rather than awaited: nothing here reads the submit's outcome, and waiting
    // would make a vendor refusal at stage 5 look like a voice failure — so a retry would
    // re-render audio that was fine, and pay for it.
    if (result.ok) {
      try {
        const { generateTask } = await import('./05-generate');
        await generateTask.trigger({ scriptId: payload.scriptId });
      } catch (err) {
        logger.error('voice rendered, but stage 5 could not be enqueued', {
          scriptId: payload.scriptId,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  },
});
