import { writeFile } from 'node:fs/promises';

import { logger, schedules } from '@trigger.dev/sdk';

import { runDubJob, translateLines } from '@/lib/bureau/dubs';
import { renderBureau } from '@/lib/bureau/layer-render';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { DUB_CREDENTIAL, DUB_RATE_KEY, submitDubbing, waitForVoiceTask } from '@/lib/drivers/voice-synth';
import { requireCredential } from '@/lib/integrations/credentials';
import { verifiedCredential } from '@/lib/integrations/verify';
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
    const { data: queuedAll } = await db.from('dub_jobs').select('id, episode_id').eq('status', 'queued').order('created_at').limit(10);
    if (!queuedAll?.length) return { ran: 0 };
    // Each job's own channel (through its episode): a kill switch on one channel stops that
    // channel's dubs only.
    const channelOf = new Map<string, string>();
    const { data: eps } = await db.from('episodes').select('id, channel_id').in('id', [...new Set(queuedAll.map((j) => j.episode_id))]);
    for (const e of eps ?? []) channelOf.set(e.id, e.channel_id);
    const killed = new Set<string>();
    for (const ch of new Set(channelOf.values())) {
      const { data: pol } = await db.from('channel_policy').select('kill_switch').eq('channel_id', ch).maybeSingle();
      if (pol?.kill_switch) killed.add(ch);
    }
    const queued = queuedAll.filter((j) => !killed.has(channelOf.get(j.episode_id) ?? '')).slice(0, 2);
    if (!queued.length) return { ran: 0, skipped: 'kill_switch' };

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
        // Verified, not merely present: runDubJob refuses by name before anything moves.
        apiKey: () => verifiedCredential(db, DUB_CREDENTIAL.integration, DUB_CREDENTIAL.field),
        submit: (i) => submitDubbing(i),
        wait: (taskId, apiKey) => waitForVoiceTask({ apiKey, taskId, maxWaitMs: 20 * 60_000 }),
        translate: anthropic ? (lines, language) => translateLines(lines, language, { db, apiKey: anthropic, usdInrRate, channelId: channelOf.get(j.episode_id)! }) : undefined,
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
