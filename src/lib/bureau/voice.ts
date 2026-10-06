import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { TTS_RATE_KEY, voiceKey, voiceRouteFor, type VoiceProvider, type VoiceRoute } from '../drivers/voice-route';
import type { LineAudio } from '../drivers/voice-synth';
import type { AlignResult } from '../voice/align';
import { shiftBy, type WordTiming } from '../voice/timings';
import { characterBySlug } from './bible';
import type { ScriptLine } from './script-lines';
import type { CredentialRefusal } from '../integrations/verify';

const run = promisify(execFile);

/**
 * Stage 6 for the Bureau: every line in its speaker's locked voice, word timings recovered by
 * forced alignment, shot durations derived from them — or nothing derived, and a named reason.
 *
 * Runs BEFORE generation (Addendum 02 §1, CLAUDE.md: stage 6 before stage 5), because the
 * character beats are generated at the durations this sets.
 *
 * ── The money ─────────────────────────────────────────────────────────────────
 *
 * One `cost_ledger` estimate row for the whole script, written before the first line is
 * synthesised (rule 5): characters × the rate-card row (1 credit / 50 chars at $0.01 —
 * a published price, so `cost_source = rate_card`). Never a reconcile: nothing here
 * observes a balance move. A retry re-uses every line that already has audio, so it does
 * not pay twice, and the ledger's unique (script, stage, kind, unit) key keeps one row.
 *
 * ── The refusal ───────────────────────────────────────────────────────────────
 *
 * Any line whose alignment is not confident gets `word_timings = []` with its audio stored,
 * and NO shot is marked `derived_from_vo`. The episode halts naming the line; the blocker
 * view says "voice was synthesised but forced alignment did not confirm every word".
 */

export interface VoiceDeps {
  db: Db;
  usdInrRate: number;
  /** The provider's key if its integration has verified, else the refusal by name.
   *  Production: `verifiedCredential` (integrations/verify.ts). */
  apiKeyFor(provider: VoiceProvider): Promise<{ ok: true; value: string } | CredentialRefusal>;
  synth(input: { route: Extract<VoiceRoute, { ok: true }>; text: string; apiKey: string; outPath: string }): Promise<LineAudio>;
  align(input: { audioPath: string; text: string }): Promise<AlignResult>;
  putBytes(key: string, body: Readable): Promise<number>;
  /** Signed GET for a stored line, so a replay can rebuild the track from paid-for audio. */
  presign(key: string): Promise<string>;
  /** Override the character → voice decision (harnesses lock presets without editing the bible). */
  routeFor?(slug: string): VoiceRoute;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type VoiceOutcome =
  | { ok: true; lines: number; totalS: number; voAssetId: string; chars: number; costInr: number; shotsTimed: number; reused: number }
  | { ok: false; code: string; detail: string };

/** Silence between lines, so the cut has room to breathe and captions do not collide. */
export const LINE_GAP_S = 0.18;
/** Hold after the last word, so the loop line lands before the video restarts. */
export const TAIL_S = 0.6;

export async function runEpisodeVoice(scriptId: string, deps: VoiceDeps): Promise<VoiceOutcome> {
  const { db } = deps;
  const log = deps.log ?? { info() {}, error() {} };

  const { data: script } = await db.from('scripts').select('id, concept_id, vo_text, beats').eq('id', scriptId).single();
  if (!script) return { ok: false, code: 'no_script', detail: `script ${scriptId} not found` };
  const lines = (script.beats as unknown as { lines?: ScriptLine[] }).lines ?? [];
  if (!lines.length) return { ok: false, code: 'no_lines', detail: 'the script carries no dialogue lines' };

  // ── Every speaker must have a locked voice before anything is spent ─────────
  const routes = new Map<string, Extract<VoiceRoute, { ok: true }>>();
  const refusals: string[] = [];
  for (const slug of new Set(lines.map((l) => l.speaker))) {
    const c = characterBySlug(slug);
    if (!c) {
      refusals.push(`${slug}: not in the cast`);
      continue;
    }
    const r = deps.routeFor ? deps.routeFor(slug) : voiceRouteFor(c);
    if (r.ok) routes.set(slug, r);
    else refusals.push(r.detail);
  }
  if (refusals.length) return { ok: false, code: 'voice_not_locked', detail: refusals.join(' ') };

  const keys = new Map<string, string>();
  for (const r of routes.values()) {
    if (keys.has(r.provider)) continue;
    const k = await deps.apiKeyFor(r.provider);
    if (!k.ok) return { ok: false, code: k.code, detail: `The voice stage cannot speak: ${k.reason}` };
    keys.set(r.provider, k.value);
  }

  // ── Price before speaking ──────────────────────────────────────────────────
  const rate = await currentRate(db, { ...TTS_RATE_KEY });
  if (!rate.found) return { ok: false, code: 'unpriced', detail: `Refusing to synthesise: ${rate.detail}` };
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  const costUsd = chars * rate.rate.unitCostUsd;
  const costInr = costUsd * deps.usdInrRate;
  const { error: ledgerError } = await db.from('cost_ledger').insert({
    script_id: script.id,
    concept_id: script.concept_id,
    driver: TTS_RATE_KEY.driver,
    stage: '06-voice',
    entry_kind: 'estimate',
    unit: 'character',
    quantity: chars,
    cost_usd: costUsd,
    cost_inr: costInr,
    usd_inr_rate: deps.usdInrRate,
    cost_source: 'rate_card',
  });
  if (ledgerError && !/duplicate key|unique constraint/i.test(ledgerError.message)) {
    return { ok: false, code: 'ledger_failed', detail: `Refusing to synthesise without a ledger row: ${ledgerError.message}` };
  }

  const work = await mkdtemp(join(tmpdir(), 'kiln-voice-'));
  try {
    const { data: existing } = await db
      .from('vo_takes')
      .select('chunk_idx, asset_id, word_timings, duration_s')
      .eq('script_id', script.id)
      .eq('language', 'en');
    const files: string[] = [];
    const lineWords: (WordTiming[] | null)[] = [];
    const durations: number[] = [];
    let reused = 0;
    const failedLines: string[] = [];

    for (const line of lines) {
      const route = routes.get(line.speaker)!;
      const prior = (existing ?? []).find((t) => t.chunk_idx === line.idx && t.asset_id);
      const outPath = join(work, `line-${line.idx}.audio`);

      let words: WordTiming[] | null = null;
      if (prior) {
        // Re-use what was already paid for: fetch the stored audio rather than re-speaking it.
        const { data: asset } = await db.from('assets').select('storage_key').eq('id', prior.asset_id!).single();
        files.push(asset ? `storage:${asset.storage_key}` : outPath);
        const w = prior.word_timings as unknown as WordTiming[];
        words = Array.isArray(w) && w.length ? w : null;
        lineWords.push(words);
        durations.push(Number(prior.duration_s ?? 0));
        reused++;
        if (!words) failedLines.push(`line ${line.idx} (${line.speaker}): alignment previously not confident`);
        continue;
      }

      const audio = await deps.synth({ route, text: line.text, apiKey: keys.get(route.provider)!, outPath });
      if (!audio.ok) return { ok: false, code: `synth_${audio.code}`, detail: `line ${line.idx} (${line.speaker}): ${audio.detail}` };

      const wav = join(work, `line-${line.idx}.wav`);
      await run('ffmpeg', ['-v', 'error', '-y', '-i', audio.path, '-ac', '1', '-ar', '48000', wav]);

      if (audio.words) {
        words = audio.words.length === line.text.trim().split(/\s+/).length ? audio.words : null;
      } else {
        const aligned = await deps.align({ audioPath: wav, text: line.text });
        if (aligned.ok) words = aligned.words;
        else failedLines.push(`line ${line.idx} (${line.speaker}): ${aligned.code} — ${aligned.detail}`);
      }
      const durationS = await probeDuration(wav);
      const key = `vo/${script.id}/en/${String(line.idx).padStart(3, '0')}.wav`;
      const bytes = await deps.putBytes(key, createReadStream(wav));
      const { data: asset, error: assetError } = await db
        .from('assets')
        .insert({ kind: 'audio', storage_key: key, bytes, duration_s: durationS, meta: { line: line.idx, speaker: line.speaker } as Json })
        .select('id')
        .single();
      if (assetError || !asset) return { ok: false, code: 'asset_failed', detail: assetError?.message ?? 'no asset row' };

      const { error: takeError } = await db.from('vo_takes').upsert(
        {
          script_id: script.id,
          chunk_idx: line.idx,
          driver: route.provider,
          model: route.model,
          voice_id: voiceKey(route),
          language: 'en',
          text_in: line.text,
          asset_id: asset.id,
          word_timings: (words ?? []) as unknown as Json,
          offset_s: 0,
          duration_s: durationS,
          request_id: audio.requestId,
          characters_billed: line.text.length,
        },
        { onConflict: 'script_id,chunk_idx,language' },
      );
      if (takeError) return { ok: false, code: 'take_failed', detail: takeError.message };

      files.push(wav);
      lineWords.push(words);
      durations.push(durationS);
    }

    // ── Offsets: lines end to end with a fixed gap ────────────────────────────
    const offsets: number[] = [];
    let t = 0;
    for (const d of durations) {
      offsets.push(round3(t));
      t += d + LINE_GAP_S;
    }
    const totalS = round3(t - LINE_GAP_S + TAIL_S);
    for (const [i, line] of lines.entries()) {
      await db.from('vo_takes').update({ offset_s: offsets[i] }).eq('script_id', script.id).eq('chunk_idx', line.idx).eq('language', 'en');
    }

    if (failedLines.length) {
      log.error('alignment not confident; durations stay estimates', { failedLines });
      return { ok: false, code: 'alignment_failed', detail: failedLines.join('; ') };
    }

    // ── The full VO track ──────────────────────────────────────────────────────
    const local = await Promise.all(
      files.map(async (f, i) => (f.startsWith('storage:') ? materialiseFromStorage(deps.presign, f.slice(8), join(work, `reuse-${i}.wav`)) : f)),
    );
    const track = join(work, 'vo.m4a');
    await concatWithGaps(local, LINE_GAP_S, TAIL_S, track);
    const trackKey = `vo/${script.id}/en/track.m4a`;
    const trackBytes = await deps.putBytes(trackKey, createReadStream(track));
    const { data: trackAsset } = await db
      .from('assets')
      .insert({ kind: 'audio', storage_key: trackKey, bytes: trackBytes, duration_s: totalS, meta: { role: 'vo_track', language: 'en' } as Json })
      .select('id')
      .single();

    // ── Shot durations, contiguous ────────────────────────────────────────────
    const allWords = lineWords.flatMap((w, i) => shiftBy(w!, offsets[i]));
    const shotsTimed = await deriveContiguous(db, script.id, lines, offsets, totalS);
    log.info('voice complete', { lines: lines.length, totalS, words: allWords.length, shotsTimed });

    return { ok: true, lines: lines.length, totalS, voAssetId: trackAsset!.id, chars, costInr, shotsTimed, reused };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * A shot runs from the start of its first line to the start of the next shot's first line
 * (the last shot to the end of the track). Pauses belong to the shot they follow, so the
 * shots tile the audio exactly — the sum of shot durations IS the VO track's length.
 */
async function deriveContiguous(db: Db, scriptId: string, lines: ScriptLine[], offsets: number[], totalS: number) {
  const { data: shots } = await db.from('shots').select('id, idx, vo_char_start, vo_char_end').eq('script_id', scriptId).order('idx');
  const lineAt = (char: number) => lines.findIndex((l) => char >= l.voStart && char < l.voEnd + 1);
  const starts = (shots ?? []).map((s) => (s.vo_char_start === null ? -1 : lineAt(s.vo_char_start)));
  let timed = 0;
  for (const [i, s] of (shots ?? []).entries()) {
    if (starts[i] < 0) continue;
    const from = offsets[starts[i]];
    const nextStart = starts.slice(i + 1).find((x) => x >= 0);
    const to = nextStart === undefined ? totalS : offsets[nextStart];
    const d = round3(to - from);
    if (d <= 0) continue;
    const { error } = await db.from('shots').update({ duration_s: d, duration_source: 'derived_from_vo' }).eq('id', s.id);
    if (!error) timed++;
  }
  return timed;
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe could not read a duration for ${path}`);
  return round3(d);
}

async function concatWithGaps(files: string[], gapS: number, tailS: number, out: string) {
  const inputs = files.flatMap((f) => ['-i', f]);
  const n = files.length;
  const parts = files.map((_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=${i === n - 1 ? tailS : gapS}[a${i}]`);
  const filter = `${parts.join(';')};${files.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[out]`;
  await run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', out]);
  await stat(out);
}

/** Bytes back from storage for a re-used line, through the same driver everything uses. */
async function materialiseFromStorage(presign: (key: string) => Promise<string>, key: string, outPath: string): Promise<string> {
  const res = await fetch(await presign(key));
  if (!res.ok) throw new Error(`re-used line ${key} could not be read back: HTTP ${res.status}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
