import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { z } from 'zod';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { routed } from '../llm/router';
import type { CaptionCue } from '../review/timeline';
import type { BureauVideoProps } from '../../remotion/bureau/bureau-video';
import type { ScriptLine } from './script-lines';
import { toSrt } from './episode-steps';
import type { CredentialRefusal } from '../integrations/verify';

/**
 * One dub job: the episode's VO stem → the vendor's dubbing → a language audio track, a
 * translated caption file and a caption-layer render, for YouTube Studio's multi-language
 * audio upload (hi, es, pt-BR).
 *
 * Cost: the vendor publishes no dubbing rate. The submit response carries
 * `estimatedCost.credits` — "the maximum credits this task may charge" — and that upper bound
 * × the published credit price is what the ledger records, at submit, as an estimate. Every
 * surface that shows a dub cost labels it "rate unverified". If the response carries no
 * estimate the row is written with cost_inr null (unpriced), never 0.
 *
 * Captions: the dubbing vendor returns audio only. Each script line is translated (fast
 * tier) and shown for the span the English line occupied — dubbing keeps segment timing — and
 * the file says "line-timed" so nobody mistakes it for word-aligned captions.
 */

export const LANG_NAMES: Record<string, string> = { hi: 'Hindi', es: 'Spanish', 'pt-BR': 'Brazilian Portuguese' };

export interface DubDeps {
  db: Db;
  usdInrRate: number;
  presign(key: string): Promise<string>;
  putBytes(key: string, body: Readable): Promise<number>;
  download(url: string, out: string): Promise<void>;
  /**
   * The dubbing key if its integration has verified, else the refusal by name. Production:
   * `verifiedCredential` (integrations/verify.ts), the Settings banner's predicate.
   */
  apiKey(): Promise<{ ok: true; value: string } | CredentialRefusal>;
  submit(input: { apiKey: string; audioUrl: string; language: 'hi' | 'es' | 'pt-BR'; speakers: number }): Promise<{ ok: true; taskId: string; estimatedCredits: number | null } | { ok: false; code: string; detail: string }>;
  wait(taskId: string, apiKey: string): Promise<{ state: 'succeeded'; outputUrl: string } | { state: 'failed'; code: string; detail: string } | { state: 'running'; vendorState: string }>;
  translate?(lines: string[], language: string): Promise<string[]>;
  renderCaptions?(props: BureauVideoProps, durationInFrames: number, outputPath: string): Promise<{ ok: boolean; detail?: string }>;
  rateKey: { driver: string; model: string; endpoint: string; unit: string };
}

export async function runDubJob(jobId: string, deps: DubDeps): Promise<{ ok: true; language: string } | { ok: false; code: string; detail: string }> {
  const { db } = deps;
  const { data: job } = await db.from('dub_jobs').select('*').eq('id', jobId).single();
  if (!job) return { ok: false, code: 'not_found', detail: jobId };
  const { data: ep } = await db.from('episodes').select('id, script_id, voice_detail, channel_id').eq('id', job.episode_id).single();
  const voice = (ep?.voice_detail ?? {}) as { vo_asset_id?: string; total_s?: number };
  if (!ep?.script_id || !voice.vo_asset_id) return fail(db, jobId, 'no_vo', 'the episode has no VO stem to dub');
  const { data: vo } = await db.from('assets').select('storage_key').eq('id', voice.vo_asset_id).single();
  const { data: script } = await db.from('scripts').select('beats').eq('id', ep.script_id).single();
  const lines = (script!.beats as unknown as { lines: ScriptLine[] }).lines;
  const lang = job.language as 'hi' | 'es' | 'pt-BR';

  // Before anything moves. An unverified integration is not this job's failure: the job stays
  // queued, carries the reason in `error` so the row says why it is not moving, and runs on
  // the first tick after "Save and test" passes.
  const key = await deps.apiKey();
  if (!key.ok) {
    await db.from('dub_jobs').update({ error: `${key.code}: ${key.reason}`.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', jobId);
    return { ok: false, code: key.code, detail: key.reason };
  }

  await db.from('dub_jobs').update({ status: 'voicing', error: null, updated_at: new Date().toISOString() }).eq('id', jobId);
  let taskId = job.request_id;
  if (!taskId) {
    const rate = await currentRate(db, deps.rateKey);
    const sub = await deps.submit({ apiKey: key.value, audioUrl: await deps.presign(vo!.storage_key), language: lang, speakers: new Set(lines.map((l) => l.speaker)).size });
    if (!sub.ok) return fail(db, jobId, sub.code, sub.detail);
    taskId = sub.taskId;
    const credits = sub.estimatedCredits;
    const costUsd = credits !== null && rate.found ? credits * rate.rate.unitCostUsd : null;
    // No estimate in the response → the row is UNPRICED (cost_inr null). cost_usd is NOT NULL in
    // the schema, so it carries 0 there; every reader sums cost_inr and counts nulls as unpriced.
    await db.from('cost_ledger').insert({
      script_id: ep.script_id,
      driver: deps.rateKey.driver,
      stage: `dub:${lang}`,
      entry_kind: 'estimate',
      unit: 'credit',
      quantity: credits ?? 0,
      cost_usd: costUsd ?? 0,
      cost_inr: costUsd === null ? null : costUsd * deps.usdInrRate,
      usd_inr_rate: deps.usdInrRate,
      idempotency_key: `dub:${jobId}`,
      cost_source: 'rate_card',
    });
    await db
      .from('dub_jobs')
      .update({ request_id: taskId, credits_estimated: credits, estimate_inr: costUsd === null ? null : costUsd * deps.usdInrRate })
      .eq('id', jobId);
  }

  const done = await deps.wait(taskId, key.value);
  if (done.state !== 'succeeded') return fail(db, jobId, done.state === 'failed' ? done.code : 'timeout', done.state === 'failed' ? done.detail : 'still running');

  const work = await mkdtemp(join(tmpdir(), 'kiln-dub-'));
  try {
    const audioPath = join(work, `${lang}.audio`);
    await deps.download(done.outputUrl, audioPath);
    const audioKey = `dubs/${ep.id}/${lang}.m4a`;
    const bytes = await deps.putBytes(audioKey, createReadStream(audioPath));
    const { data: audio } = await db.from('assets').insert({ kind: 'audio', storage_key: audioKey, bytes, meta: { language: lang, role: 'dub' } as Json }).select('id').single();
    await db.from('dub_jobs').update({ status: 'rendering', audio_asset_id: audio!.id, updated_at: new Date().toISOString() }).eq('id', jobId);

    // Line-timed captions in the target language.
    const { data: takes } = await db.from('vo_takes').select('chunk_idx, offset_s, duration_s').eq('script_id', ep.script_id).eq('language', 'en').order('chunk_idx');
    let translated: string[] | null = null;
    if (deps.translate) {
      try {
        translated = await deps.translate(lines.map((l) => l.text), LANG_NAMES[lang]);
        if (translated.length !== lines.length) translated = null;
      } catch {
        translated = null;
      }
    }
    if (translated) {
      const cues: CaptionCue[] = lines.map((l, i) => {
        const t = takes?.find((x) => x.chunk_idx === l.idx);
        const start = Number(t?.offset_s ?? 0);
        return { startS: start, endS: start + Number(t?.duration_s ?? 0), text: translated![i], words: [] };
      });
      const srtPath = join(work, `${lang}.srt`);
      await writeFile(srtPath, `${toSrt(cues)}\n`);
      const srtKey = `dubs/${ep.id}/${lang}.line-timed.srt`;
      await deps.putBytes(srtKey, createReadStream(srtPath));
      const { data: srt } = await db.from('assets').insert({ kind: 'caption', storage_key: srtKey, meta: { language: lang, timing: 'line' } as Json }).select('id').single();
      await db.from('dub_jobs').update({ srt_asset_id: srt!.id, translated_lines: translated as unknown as Json }).eq('id', jobId);
      if (deps.renderCaptions && voice.total_s) {
        const mov = join(work, `${lang}.mov`);
        const frames = Math.round(voice.total_s * 30);
        const r = await deps.renderCaptions({ layer: 'caption_layer', shots: [], audioUrl: null, musicUrl: null, cues, hook: null, safeBox: { x: 54, y: 154, width: 875, height: 1382 } }, frames, mov);
        if (r.ok) {
          const key = `dubs/${ep.id}/${lang}-captions.mov`;
          const b = await deps.putBytes(key, createReadStream(mov));
          const { data: a } = await db.from('assets').insert({ kind: 'video', storage_key: key, bytes: b, meta: { layer: 'caption_layer', language: lang } as Json }).select('id').single();
          const { data: rr } = await db
            .from('renders')
            .insert({ script_id: ep.script_id, variant_group_id: ep.id, variant_label: `caption_layer-${lang}`, format: 'shorts_9x16', width: 1080, height: 1920, duration_s: frames / 30, asset_id: a!.id, status: 'ready', kind: 'final', layer: 'caption_layer', language: lang })
            .select('id')
            .single();
          await db.from('dub_jobs').update({ caption_render_id: rr!.id }).eq('id', jobId);
        }
      }
    }
    await db.from('dub_jobs').update({ status: 'ready', error: translated ? null : 'captions not translated (no translator or it failed); audio is ready', updated_at: new Date().toISOString() }).eq('id', jobId);
    return { ok: true, language: lang };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function fail(db: Db, jobId: string, code: string, detail: string) {
  await db.from('dub_jobs').update({ status: 'failed', error: `${code}: ${detail}`.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', jobId);
  return { ok: false as const, code, detail };
}

const TranslationSchema = z.object({ lines: z.array(z.string()) });

export async function translateLines(lines: string[], language: string, deps: { db: Db; apiKey: string; usdInrRate: number; channelId: string }): Promise<string[]> {
  const r = await routed(
    {
      task: 'translation',
      system: `Translate each line of an office-comedy script into ${language} for on-screen captions. Keep jokes landing, keep character names as they are, one output line per input line, same order, no additions.`,
      user: lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
      schema: TranslationSchema,
      maxTokens: 2000,
    },
    { db: deps.db, apiKey: deps.apiKey, usdInrRate: deps.usdInrRate, subject: { kind: 'channel', channelId: deps.channelId, idempotencyKey: `translate:${language}:${Date.now()}`, stage: '24-dub-captions' } },
  );
  return r.data.lines;
}
