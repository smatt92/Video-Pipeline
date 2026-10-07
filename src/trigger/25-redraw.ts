import { writeFile } from 'node:fs/promises';

import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { FPS, HEIGHT, WIDTH, type AssembleDeps } from '@/lib/bureau/episode-steps';
import { renderBureau } from '@/lib/bureau/layer-render';
import { measureLoudness, normaliseLoudness } from '@/lib/bureau/qc';
import { runRedraw } from '@/lib/bureau/redraw';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { STILL_CREDENTIAL_FIELD, STILL_INTEGRATION, submitStill, waitStill } from '@/lib/drivers/still-image';
import { requireCredential } from '@/lib/integrations/credentials';
import { verifiedCredential } from '@/lib/integrations/verify';
import { storage } from '@/lib/storage';
import { putterFor } from '@/lib/storage/put';

/**
 * "Redraw this picture" — one request from Cuts (or shot_regenerate on a picture shot).
 *
 * Numbered after the episode run's helpers (20 episode, 21 dispatch … 24 dubs): it belongs to
 * stage 5's stills, and the number is not the running order (CLAUDE.md conventions).
 *
 * The body is `runRedraw` (src/lib/bureau/redraw.ts), which a harness drives with fakes: new
 * still(s) for the asked parts → the composite only → final_render_id → loudness. This file
 * resolves configuration and hands it down; every refusal is in the lib.
 *
 * Caller: the Redraw button under each picture on Cuts (`redrawAction` → requestRedraw →
 * productionEffects.startRedraw), and the Kiln connector's shot_regenerate on a still shot.
 *
 * Replayable: a finished request returns its result, and attempts count per part, so a replay
 * of an unfinished one draws under a new attempt key rather than re-using a paid one. No
 * automatic retry: a retry after the vendor was called would pay for a second picture.
 * Concurrency 1: renders are heavy, and one redraw per episode is the rule anyway.
 */

const Payload = z.object({
  episodeId: z.uuid(),
  shotId: z.uuid(),
  parts: z.array(z.number().int().min(0)).min(1).max(8),
  note: z.string().max(200).nullable(),
  redrawId: z.uuid(),
});

async function download(url: string, out: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
}

export const redrawTask = schemaTask({
  id: '25-redraw',
  schema: Payload,
  queue: { concurrencyLimit: 1 },
  machine: 'medium-2x',
  retry: { maxAttempts: 1 },
  maxDuration: 3_600,

  run: async (payload) => {
    const db = serverClient();
    const driver = storage();
    const presign = async (key: string) => (await driver.presignGet({ key, expiresIn: 3600 })).url;
    const put = putterFor(driver).put;
    const usdInrRate = await requireUsdInrRate(db, 'writing the cost rows for 25-redraw');
    const anthropicKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY').catch(() => null);
    const assemble: AssembleDeps = {
      usdInrRate,
      presign,
      putBytes: put,
      download,
      normaliseAudio: normaliseLoudness,
      render: (i) => renderBureau({ ...i, width: WIDTH, height: HEIGHT, fps: FPS, browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE }),
      log: logger,
    };
    const r = await runRedraw(db, payload, {
      still: {
        usdInrRate,
        llmKey: anthropicKey,
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
      },
      assemble,
      // Measured on what was rendered, as 20-episode does.
      measureLoudness: async (renderId) => {
        const { data: r } = await db.from('renders').select('asset_id').eq('id', renderId).single();
        const { data: a } = await db.from('assets').select('storage_key').eq('id', r!.asset_id!).single();
        const local = `/tmp/redraw-${renderId}.mp4`;
        await download(await presign(a!.storage_key), local);
        return measureLoudness(local);
      },
    });
    logger.info('redraw', r);
    return r;
  },
});
