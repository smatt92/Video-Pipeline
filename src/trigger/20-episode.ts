import { writeFile } from 'node:fs/promises';

import { logger, schemaTask, tasks, wait } from '@trigger.dev/sdk';
import { z } from 'zod';

import { afterBundle } from '@/lib/bureau/after-bundle';
import { notify } from '@/lib/bureau/alerts';
import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import {
  assembleEpisode,
  bundleEpisode,
  enqueueGeneration,
  FPS,
  generationSettled,
  HEIGHT,
  planShots,
  prepareScript,
  qcClips,
  setStatus,
  voiceStep,
  WIDTH,
} from '@/lib/bureau/episode-steps';
import { measureLoudness, normaliseLoudness, sampleFrames, signalQc, visionQc } from '@/lib/bureau/qc';
import { renderBureau } from '@/lib/bureau/layer-render';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { PROVIDER_INTEGRATION, ROUTE_PROVIDERS } from '@/lib/drivers/jobs';
import { serverClient } from '@/lib/db/server';
import { VOICE_CREDENTIAL_FIELDS, synthLine } from '@/lib/drivers/voice-synth';
import { requireCredential } from '@/lib/integrations/credentials';
import { usability } from '@/lib/integrations/verify';
import { storage } from '@/lib/storage';
import { putterFor } from '@/lib/storage/put';
import { alignLine } from '@/lib/voice/align';

/**
 * One Bureau episode, from an approved brief to a publish bundle.
 *
 * Started by `brief_approve` (the approval IS the first gate — decision 0012 #15). The second
 * gate is the cut: this run parks on a Trigger wait token that `cut_approve` / `cut_reject`
 * completes from the MCP server. A third wait sits between generation and QC: the run parks
 * on a token the dispatcher (`21-gen-dispatch`) completes when the episode's last job is
 * terminal — so nothing here polls a vendor or the database in a loop.
 *
 * Order: polish → shots → estimate/fit → voice → generate → QC (≤2 re-rolls) → assemble →
 * cut gate → bundle. Voice before video: see pipeline.ts.
 *
 * Caller: `approveBrief` in src/lib/bureau/control.ts, via the Kiln MCP connector's
 * brief_approve tool (and the Approvals page). Replayable: every step skips work it finds done.
 */

const Payload = z.object({ episodeId: z.uuid() });

async function download(url: string, out: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
}

export const episodeTask = schemaTask({
  id: '20-episode',
  schema: Payload,
  queue: { concurrencyLimit: 2 },
  machine: 'medium-2x',
  maxDuration: 3_600,

  run: async ({ episodeId }) => {
    const db = serverClient();
    const driver = storage();
    const presign = async (key: string) => (await driver.presignGet({ key, expiresIn: 3600 })).url;
    const put = putterFor(driver).put;

    const { data: pol } = await db.from('channel_policy').select('kill_switch, rerolls_max').eq('channel_id', BUREAU_CHANNEL_ID).single();
    if (pol?.kill_switch) {
      await setStatus(db, episodeId, 'halted', 'kill switch is on');
      return { halted: 'kill_switch' };
    }

    const usdInrRate = await requireUsdInrRate(db, 'writing the cost rows for 20-episode');
    const anthropicKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY').catch(() => null);

    try {
      // 1–2. Script and shots
      const script = await prepareScript(db, episodeId, { apiKey: anthropicKey, usdInrRate, log: logger });
      logger.info('script', script);
      const acted = (await usability(db, PROVIDER_INTEGRATION[ROUTE_PROVIDERS.acted_beat.primary])).usable;
      const plan = await planShots(db, episodeId, { usdInrRate, actedBeatAvailable: acted, log: logger });
      logger.info('shots planned', plan);

      // 3. Voice — before any video, because it sets the durations
      const voice = await voiceStep(db, episodeId, {
        usdInrRate,
        apiKeyFor: async (provider) => requireCredential(db, provider, VOICE_CREDENTIAL_FIELDS[provider]).catch(() => null),
        synth: (i) => synthLine(i),
        align: (i) => alignLine(i),
        putBytes: put,
        presign,
        log: logger,
      });
      if (!voice.ok) {
        await setStatus(db, episodeId, 'halted', `${voice.code}: ${voice.detail}`);
        await notify(db, BUREAU_CHANNEL_ID, 'qc_failed', `Episode ${episodeId.slice(0, 8)} halted at voice: ${voice.detail}`);
        return { halted: voice.code };
      }

      // 4–6. Generate, QC, re-roll (bounded by rerolls_max + 1 rounds)
      const rounds = (pol?.rerolls_max ?? 2) + 1;
      for (let round = 0; round < rounds; round++) {
        if (round === 0) {
          const q = await enqueueGeneration(db, episodeId, { usdInrRate });
          logger.info('generation queued', q);
        }
        const open = await generationSettled(db, episodeId);
        if (!open.settled) {
          await setStatus(db, episodeId, 'generating', `${open.open} job(s) in flight`);
          const token = await wait.createToken({ timeout: '3h', idempotencyKey: `gen:${episodeId}:${round}`, tags: [`episode:${episodeId}`] });
          await db.from('episodes').update({ gen_wait_token: token.id }).eq('id', episodeId);
          const woke = await wait.forToken<{ failed: number }>(token);
          if (!woke.ok) logger.error('generation wait timed out; continuing with what exists');
        }
        const qc = await qcClips(db, episodeId, {
          presign,
          download,
          signal: (p, d) => signalQc(p, d),
          vision: anthropicKey
            ? async ({ path, referenceUrl, description }) => {
                const frames = await sampleFrames(path);
                const refPng = referenceUrl ? Buffer.from(await (await fetch(referenceUrl)).arrayBuffer()).toString('base64') : null;
                return visionQc(
                  { frames, referencePng: refPng, description },
                  { db, apiKey: anthropicKey, usdInrRate, subject: { kind: 'channel', channelId: BUREAU_CHANNEL_ID, idempotencyKey: `qc:${episodeId}:${round}:${description.slice(0, 20)}:${Date.now()}`, stage: '20-qc' } },
                );
              }
            : undefined,
          log: logger,
        });
        logger.info('qc', qc);
        if (qc.flagged) await notify(db, BUREAU_CHANNEL_ID, 'qc_failed', `Episode ${episodeId.slice(0, 8)}: ${qc.flagged} clip(s) failed QC after re-rolls — see Cuts.`);
        if (qc.rerolled === 0) break;
      }

      // 7. Assemble three layers
      const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
      const assembled = await assembleEpisode(db, episodeId, {
        usdInrRate,
        presign,
        putBytes: put,
        download,
        normaliseAudio: normaliseLoudness,
        render: (i) => renderBureau({ ...i, width: WIDTH, height: HEIGHT, fps: FPS, browserExecutable }),
        log: logger,
      });
      if (!assembled.ok) {
        await setStatus(db, episodeId, 'failed', `${assembled.code}: ${assembled.detail}`);
        return { failed: assembled.code };
      }

      // Loudness, measured on what was rendered — the instrument closest to the thing.
      const { data: comp } = await db.from('renders').select('asset_id').eq('id', assembled.compositeRenderId).single();
      const { data: compAsset } = await db.from('assets').select('storage_key').eq('id', comp!.asset_id!).single();
      const local = `/tmp/composite-${episodeId}.mp4`;
      await download(await presign(compAsset!.storage_key), local);
      const lufs = await measureLoudness(local);
      const { data: epNow } = await db.from('episodes').select('qc').eq('id', episodeId).single();
      await db.from('episodes').update({ qc: { ...((epNow?.qc ?? {}) as object), loudness_lufs: lufs } }).eq('id', episodeId);

      // 8. The cut gate
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await wait.createToken({ timeout: '14d', idempotencyKey: `cut:${episodeId}:${attempt}`, tags: [`episode:${episodeId}`] });
        await db.from('episodes').update({ cut_wait_token: token.id, status: 'awaiting_cut', status_detail: null }).eq('id', episodeId);
        await notify(db, BUREAU_CHANNEL_ID, 'cut_ready', `Cut ready for review: episode ${episodeId.slice(0, 8)} (${(assembled.frames / FPS).toFixed(1)} s, ${lufs === null ? 'loudness unmeasured' : `${lufs} LUFS`}).`);
        const decision = await wait.forToken<{ approved: boolean; note: string | null }>(token);
        if (!decision.ok) {
          await setStatus(db, episodeId, 'halted', 'cut review timed out after 14 days');
          return { halted: 'cut_timeout' };
        }
        if (decision.output.approved) {
          // 9. Bundle
          const b = await bundleEpisode(db, episodeId);
          // Both flags false today: this records "bundle only" and does nothing else.
          const next = await afterBundle(db, b.publicationId, {
            startUpload: async (publicationId) => (await tasks.trigger('10-publish', { publicationId, idempotencyKey: `publish:${publicationId}` })).id,
          });
          await notify(db, BUREAU_CHANNEL_ID, 'info', `Publish bundle ready for episode ${episodeId.slice(0, 8)}${b.slotTime ? ` — slot ${b.slotTime}` : ''}. YouTube: ${next.youtube}.`);
          return { bundled: b.publicationId, ...next };
        }
        // Rejected: re-rolls queued by shot_regenerate are generated, then the cut is rebuilt.
        const open = await generationSettled(db, episodeId);
        if (open.settled) {
          await setStatus(db, episodeId, 'cut_rejected', `rejected: ${decision.output.note ?? ''} — queue a re-roll with shot_regenerate and re-run, or brief a replacement`);
          return { rejected: true };
        }
        const gen = await wait.createToken({ timeout: '3h', idempotencyKey: `gen:${episodeId}:cut${attempt}` });
        await db.from('episodes').update({ gen_wait_token: gen.id, status: 'generating' }).eq('id', episodeId);
        await wait.forToken(gen);
        const re = await assembleEpisode(db, episodeId, { usdInrRate, presign, putBytes: put, download, normaliseAudio: normaliseLoudness, render: (i) => renderBureau({ ...i, width: WIDTH, height: HEIGHT, fps: FPS, browserExecutable }), log: logger });
        if (!re.ok) {
          await setStatus(db, episodeId, 'failed', `${re.code}: ${re.detail}`);
          return { failed: re.code };
        }
      }
      await setStatus(db, episodeId, 'cut_rejected', 'three cuts rejected; brief a replacement');
      return { rejected: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await setStatus(db, episodeId, 'failed', detail.slice(0, 500));
      throw err;
    }
  },
});
