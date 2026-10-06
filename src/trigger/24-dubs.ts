import { writeFile } from 'node:fs/promises';

import { logger, schedules } from '@trigger.dev/sdk';

import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import { runDubJob, translateLines } from '@/lib/bureau/dubs';
import { renderBureau } from '@/lib/bureau/layer-render';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { DUB_CREDENTIAL, DUB_RATE_KEY, submitDubbing, waitForVoiceTask } from '@/lib/drivers/voice-synth';
import { requireCredential } from '@/lib/integrations/credentials';
import { storage } from '@/lib/storage';
import { putterFor } from '@/lib/storage/put';

/**
 * Dub queue, every 10 minutes: up to two queued dub jobs per run (the vendor's concurrency is
 * shared with voice and Act-Two). Jobs are queued by dub_queue(add) — Routine E adds the top
 * 20% by APV from 18-Nov — or from the Cuts page. Caller: the Trigger schedule.
 */
export const dubsTask = schedules.task({
  id: '24-dubs',
  cron: '*/10 * * * *',
  queue: { concurrencyLimit: 1 },

  run: async () => {
    const db = serverClient();
    const { data: queued } = await db.from('dub_jobs').select('id').eq('status', 'queued').order('created_at').limit(2);
    if (!queued?.length) return { ran: 0 };
    const { data: pol } = await db.from('channel_policy').select('kill_switch').eq('channel_id', BUREAU_CHANNEL_ID).single();
    if (pol?.kill_switch) return { ran: 0, skipped: 'kill_switch' };

    const apiKey = await requireCredential(db, DUB_CREDENTIAL.integration, DUB_CREDENTIAL.field);
    const anthropic = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY').catch(() => null);
    const usdInrRate = await requireUsdInrRate(db, 'writing dub cost rows');
    const driver = storage();
    const results = [];
    for (const j of queued) {
      const r = await runDubJob(j.id, {
        db,
        usdInrRate,
        rateKey: DUB_RATE_KEY,
        presign: async (key) => (await driver.presignGet({ key, expiresIn: 3600 })).url,
        putBytes: putterFor(driver).put,
        download: async (url, out) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`download ${res.status}`);
          await writeFile(out, Buffer.from(await res.arrayBuffer()));
        },
        submit: (i) => submitDubbing({ apiKey, ...i }),
        wait: (taskId) => waitForVoiceTask({ apiKey, taskId, maxWaitMs: 20 * 60_000 }),
        translate: anthropic ? (lines, language) => translateLines(lines, language, { db, apiKey: anthropic, usdInrRate, channelId: BUREAU_CHANNEL_ID }) : undefined,
        renderCaptions: async (props, durationInFrames, outputPath) => {
          const r = await renderBureau({ props, width: 1080, height: 1920, fps: 30, durationInFrames, outputPath, browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE });
          return r.ok ? { ok: true } : { ok: false, detail: r.detail };
        },
      });
      results.push({ id: j.id, ...r });
    }
    logger.info('dubs', { results });
    return { ran: results.length, results };
  },
});
