import { coverStillWith } from '@/lib/bureau/cover-still';
import { buildInstagramDraft } from '@/lib/bureau/instagram-draft';
import { writeFile } from 'node:fs/promises';

import { logger, schemaTask, tasks, wait } from '@trigger.dev/sdk';
import { z } from 'zod';

import { afterBundle } from '@/lib/bureau/after-bundle';
import { notify } from '@/lib/bureau/alerts';
import {
  type AssembleDeps,
  assembleEpisode,
  bundleEpisode,
  enqueueGeneration,
  FPS,
  generateStills,
  generationSettled,
  HEIGHT,
  planShots,
  prepareScript,
  qcClips,
  setStatus,
  voiceStep,
  WIDTH,
} from '@/lib/bureau/episode-steps';
import { assembleLongForm, LF_HEIGHT, LF_WIDTH, planLongForm } from '@/lib/bureau/longform';
import { measureLoudness, normaliseLoudness, sampleFrames, signalQc, visionQc } from '@/lib/bureau/qc';
import { renderBureau } from '@/lib/bureau/layer-render';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { PROVIDER_INTEGRATION, ROUTE_PROVIDERS } from '@/lib/drivers/jobs';
import { refResolver } from '@/lib/bureau/picture-cast';
import { serverClient } from '@/lib/db/server';
import { readTuning } from '@/lib/settings/tuning';
import { STILL_CREDENTIAL_FIELD, STILL_INTEGRATION, submitStill, waitStill } from '@/lib/drivers/still-image';
import { VOICE_CREDENTIAL_FIELDS, synthLine } from '@/lib/drivers/voice-synth';
import { requireCredential } from '@/lib/integrations/credentials';
import { usability, verifiedCredential } from '@/lib/integrations/verify';
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
 * Order: polish → shots → estimate/fit → voice → stills → generate → QC (≤2 re-rolls) →
 * assemble → cut gate → bundle. Voice before video: see pipeline.ts. Stills (0021) are made
 * here with a bounded wait each (the vendor has no callback; drivers/still-image.ts), sequentially
 * so each re-reads the cap; one that fails becomes its overlay, recorded for Cuts.
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
  // CPU time, not wall time (waits are excluded — Trigger docs, max-duration). A 51 s Short renders
  // three 1080×1920 layers on the worker; the ProRes caption layer alone ran past 40 min on
  // S001 (07-Oct) and the 1 h ceiling cut the run off. Three hours is a ceiling, not a target.
  maxDuration: 10_800,

  run: async ({ episodeId }, { ctx }) => {
    const db = serverClient();
    const driver = storage();
    const presign = async (key: string) => (await driver.presignGet({ key, expiresIn: 3600 })).url;
    const put = putterFor(driver).put;

    // The episode's own channel: its kill switch, its re-roll budget, its notifications.
    const { data: epRow } = await db.from('episodes').select('channel_id').eq('id', episodeId).single();
    if (!epRow) throw new Error(`episode ${episodeId} not found`);
    const channelId = epRow.channel_id;
    const { data: pol } = await db.from('channel_policy').select('kill_switch, rerolls_max').eq('channel_id', channelId).single();
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
      const { data: kindRow } = await db.from('episodes').select('kind').eq('id', episodeId).single();
      const longForm = kindRow?.kind === 'long_form';
      const plan = longForm
        ? await planLongForm(db, episodeId, { usdInrRate })
        : await planShots(db, episodeId, { usdInrRate, actedBeatAvailable: acted, log: logger });
      logger.info('shots planned', plan);

      // 3. Voice — before any video, because it sets the durations
      const voice = await voiceStep(db, episodeId, {
        usdInrRate,
        // Verified, not merely present (the Settings banner's predicate); voiceStep refuses by name.
        apiKeyFor: (provider) => verifiedCredential(db, provider, VOICE_CREDENTIAL_FIELDS[provider]),
        synth: (i) => synthLine(i),
        align: (i) => alignLine(i),
        putBytes: put,
        presign,
        log: logger,
      });
      if (!voice.ok) {
        await setStatus(db, episodeId, 'halted', `${voice.code}: ${voice.detail}`);
        await notify(db, channelId, 'qc_failed', `Kiln stopped episode ${episodeId.slice(0, 8)} at voice: ${voice.detail} Fix the voice on Voices, then restart the run.`);
        return { halted: voice.code };
      }

      // 3b. Scene stills — before the video queue, and never holding the run on a failure
      if (!longForm) {
        const st = await generateStills(db, episodeId, {
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
          // 'characters' format: each locked sheet as a presigned URL, minted at submit.
          resolveRef: refResolver(presign),
          log: logger,
        });
        logger.info('stills', st);
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
          const token = await wait.createToken({ timeout: '3h', idempotencyKey: `gen:${episodeId}:${ctx.run.id}:${round}`, tags: [`episode:${episodeId}`] });
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
                  { db, apiKey: anthropicKey, usdInrRate, subject: { kind: 'channel', channelId: channelId, idempotencyKey: `qc:${episodeId}:${round}:${description.slice(0, 20)}:${Date.now()}`, stage: '20-qc' } },
                );
              }
            : undefined,
          log: logger,
        });
        logger.info('qc', qc);
        if (qc.flagged) await notify(db, channelId, 'qc_failed', `Episode ${episodeId.slice(0, 8)} · ${qc.flagged} clip${qc.flagged === 1 ? '' : 's'} failed QC after re-rolls. Regenerate or send back on Cuts.`);
        if (qc.rerolled === 0) break;
      }

      // 7. Assemble three layers
      const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
      const asmDeps: AssembleDeps = {
        usdInrRate,
        presign,
        putBytes: put,
        download,
        normaliseAudio: normaliseLoudness,
        render: (i) => renderBureau({ ...i, width: longForm ? LF_WIDTH : WIDTH, height: longForm ? LF_HEIGHT : HEIGHT, fps: FPS, browserExecutable }),
        log: logger,
      };
      const lf = longForm ? await assembleLongForm(db, episodeId, asmDeps) : null;
      const assembled = lf
        ? lf.ok
          ? { ok: true as const, compositeRenderId: lf.renderId, frames: lf.frames }
          : lf
        : await assembleEpisode(db, episodeId, asmDeps, { layers: ['composite'] });
      if (!assembled.ok) {
        await setStatus(db, episodeId, 'failed', `${assembled.code}: ${assembled.detail}`);
        return { failed: assembled.code };
      }

      // Loudness, measured on what was rendered — the instrument closest to the thing.
      const { data: comp } = await db.from('renders').select('asset_id').eq('id', assembled.compositeRenderId!).single();
      const { data: compAsset } = await db.from('assets').select('storage_key').eq('id', comp!.asset_id!).single();
      const local = `/tmp/composite-${episodeId}.mp4`;
      await download(await presign(compAsset!.storage_key), local);
      const lufs = await measureLoudness(local);
      const { data: epNow } = await db.from('episodes').select('qc').eq('id', episodeId).single();
      // The target it was normalised to (Settings → Assembly) travels with it, so Cuts judges
      // the measurement against the channel's own number rather than a constant.
      const loudnessTarget = (await readTuning(db, channelId)).values.loudnessLufs;
      await db.from('episodes').update({ qc: { ...((epNow?.qc ?? {}) as object), loudness_lufs: lufs, loudness_target_lufs: loudnessTarget } }).eq('id', episodeId);

      // 8. The cut gate. Token keys carry the run id: a restarted run — a re-cut after a
      // rejection — would otherwise get back the previous run's completed token, and with it
      // the rejection, before anyone had watched the new cut.
      for (let attempt = 0; attempt < 3; attempt++) {
        const token = await wait.createToken({ timeout: '14d', idempotencyKey: `cut:${episodeId}:${ctx.run.id}:${attempt}`, tags: [`episode:${episodeId}`] });
        await db.from('episodes').update({ cut_wait_token: token.id, status: 'awaiting_cut', status_detail: null }).eq('id', episodeId);
        await notify(db, channelId, 'cut_ready', `Cut ready for episode ${episodeId.slice(0, 8)} · ${(assembled.frames / FPS).toFixed(1)} s · ${lufs === null ? 'loudness — (unmeasured)' : `${lufs} LUFS`}. Watch it on Cuts.`);
        const decision = await wait.forToken<{ approved: boolean; note: string | null }>(token);
        if (!decision.ok) {
          await setStatus(db, episodeId, 'halted', 'cut review timed out after 14 days');
          return { halted: 'cut_timeout' };
        }
        if (decision.output.approved) {
          // 8b. The deliverable layers, rendered only once the cut is approved.
          if (!longForm) {
            const extra = await assembleEpisode(db, episodeId, asmDeps, { layers: ['clean_master', 'caption_layer'] });
            if (!extra.ok) {
              await setStatus(db, episodeId, 'failed', `${extra.code}: ${extra.detail}`);
              return { failed: extra.code };
            }
          }
          // 9. Bundle
          const b = await bundleEpisode(db, episodeId);
          // The Instagram half: a manual Reels draft beside the YouTube bundle when the channel
          // publishes there (decision 0020). Refused by name for a channel without the target;
          // never fails the run.
          const ig = await buildInstagramDraft(db, b.publicationId, { coverStill: coverStillWith({ presign, putBytes: put }) }).catch((err) => ({ ok: false as const, refused: err instanceof Error ? err.message : String(err) }));
          // Both flags false today: this records "bundle only" and does nothing else.
          const next = await afterBundle(db, b.publicationId, {
            startUpload: async (publicationId) => (await tasks.trigger('10-publish', { publicationId, idempotencyKey: `publish:${publicationId}` })).id,
          });
          await notify(db, channelId, 'info', `Bundle ready for episode ${episodeId.slice(0, 8)}${b.slotTime ? ` · slot ${b.slotTime}` : ''}. YouTube: ${next.youtube}. Instagram: ${ig.ok ? 'Reels draft ready' : ig.refused}. Download it on Ready.`);
          return { bundled: b.publicationId, ...next };
        }
        // Rejected: re-rolls queued by shot_regenerate are generated, then the cut is rebuilt.
        const open = await generationSettled(db, episodeId);
        if (open.settled) {
          await setStatus(db, episodeId, 'cut_rejected', `rejected: ${decision.output.note ?? ''} — queue a re-roll with shot_regenerate and re-run, or brief a replacement`);
          return { rejected: true };
        }
        const gen = await wait.createToken({ timeout: '3h', idempotencyKey: `gen:${episodeId}:${ctx.run.id}:cut${attempt}` });
        await db.from('episodes').update({ gen_wait_token: gen.id, status: 'generating' }).eq('id', episodeId);
        await wait.forToken(gen);
        const re = longForm ? await assembleLongForm(db, episodeId, asmDeps) : await assembleEpisode(db, episodeId, asmDeps, { layers: ['composite'] });
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
