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

    const result = await runShotlist(payload, {
      db,
      apiKey,
      usdInrRate: env.USD_INR_RATE,
      // Which driver's recipes to compile against. Absent means no video driver has been
      // selected yet, in which case nothing can resolve and every shot says so.
      videoDriver: env.VIDEO_DRIVER ?? 'unset',
      runId: ctx.run.id,
      log: logger,
    });

    // ── Stage 6 next, not stage 5 ───────────────────────────────────────────
    //
    // The audio-first inversion, as running code rather than as a comment. Stage 5 refuses
    // any shot whose `duration_source` is still the shotlist's estimate, and **only stage 6
    // sets `derived_from_vo`** — so chaining 04 → 05 directly would submit nothing, every
    // time, for ever. That is exactly what happened: the chain existed, was green, and was
    // inert, because stage 6 had no caller at all.
    //
    // Stage 6 needs a voice, and the voice lives on the channel (0024). Null is a legible
    // stop rather than a failure: the script and shotlist are real and a human can pick a
    // voice and replay from here.
    const db2 = serverClient();
    const { data: channel } = await db2
      .from('scripts')
      .select('concepts(channels(id, host_voice_id, voice_language))')
      .eq('id', payload.scriptId)
      .maybeSingle();

    const voice = channel?.concepts?.channels;

    if (!voice?.host_voice_id) {
      logger.warn('shotlist compiled, and the chain stops here', {
        scriptId: payload.scriptId,
        reason:
          'the channel has no host voice, so stage 6 cannot run — and without stage 6 the ' +
          'durations stay estimates and stage 5 refuses every shot. Set one in Settings, ' +
          'then replay this script from stage 6.',
      });
      return result;
    }

    try {
      const { voiceTask } = await import('./06-voice');
      await voiceTask.trigger({
        scriptId: payload.scriptId,
        voiceId: voice.host_voice_id,
        language: voice.voice_language ?? 'en',
      });
    } catch (err) {
      logger.error('shotlist compiled, but stage 6 could not be enqueued', {
        scriptId: payload.scriptId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  },
});
