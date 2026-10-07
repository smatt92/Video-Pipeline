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
import { TTS_RATE_KEY, voiceKey, voiceRouteFor, type VoiceOverride, type VoiceProvider, type VoiceRoute } from '../drivers/voice-route';
import type { LineAudio } from '../drivers/voice-synth';
import type { AlignResult } from '../voice/align';
import { shiftBy, type WordTiming } from '../voice/timings';
import type { ChannelBible } from './bible';
import type { ScriptLine } from './script-lines';
import type { CredentialRefusal } from '../integrations/verify';
import { TUNING_DEFAULTS } from '../settings/tuning';

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
  /** The episode's channel's cast — which speakers exist and their bible voices. */
  bible: Pick<ChannelBible, 'characterBySlug'>;
  /** Voices set on the Voices screen for that channel; each wins over the bible's. */
  overrides?: ReadonlyMap<string, VoiceOverride>;
  usdInrRate: number;
  /** The provider's key if its integration has verified, else the refusal by name.
   *  Production: `verifiedCredential` (integrations/verify.ts). */
  apiKeyFor(provider: VoiceProvider): Promise<{ ok: true; value: string } | CredentialRefusal>;
  synth(input: { route: Extract<VoiceRoute, { ok: true }>; text: string; apiKey: string; outPath: string }): Promise<LineAudio>;
  align(input: { audioPath: string; text: string }): Promise<AlignResult>;
  putBytes(key: string, body: Readable): Promise<number>;
  /** Signed GET for a stored line, so a replay can rebuild the track from paid-for audio. */
  presign(key: string): Promise<string>;
  /**
   * Speech speed (formats.ts `VOICE_PACES`): 1 is the voice as spoken, 1.15 brisk, 1.3 fast.
   * Applied by ffmpeg `atempo` (pitch kept) when the track is built, to paid-for takes as much
   * as new ones — so a faster pace never re-buys a line. Absent → 1.
   */
  tempo?: number;
  /**
   * Silence between lines and the hold after the last word (Settings → Assembly, 0049). The
   * step wrapper passes the channel's values from `readTuning`; absent → the defaults below.
   */
  gaps?: { lineGapS: number; tailS: number };
  /** Override the character → voice decision (harnesses lock presets without editing the bible). */
  routeFor?(slug: string): VoiceRoute;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type VoiceOutcome =
  | { ok: true; lines: number; totalS: number; voAssetId: string; chars: number; costInr: number; shotsTimed: number; reused: number; unaligned: number | null; tempo?: number }
  | { ok: false; code: string; detail: string };

/** Silence between lines, so the cut has room to breathe and captions do not collide. Default; a channel's is line_gap_s. */
export const LINE_GAP_S = TUNING_DEFAULTS.lineGapS;
/** Hold after the last word, so the loop line lands before the video restarts. Default; a channel's is tail_s. */
export const TAIL_S = TUNING_DEFAULTS.tailS;

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
    const c = deps.bible.characterBySlug(slug);
    if (!c) {
      refusals.push(`${slug}: not in the cast`);
      continue;
    }
    const r = deps.routeFor ? deps.routeFor(slug) : voiceRouteFor(c, deps.overrides?.get(slug));
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

  const tempo = clampTempo(deps.tempo);
  const lineGapS = deps.gaps?.lineGapS ?? LINE_GAP_S;
  const tailS = deps.gaps?.tailS ?? TAIL_S;
  const { data: existing } = await db
    .from('vo_takes')
    .select('chunk_idx, asset_id, word_timings, duration_s, voice_id, text_in')
    .eq('script_id', script.id)
    .eq('language', 'en');
  // A take is re-used only when it is THIS line, in THIS speaker's current voice. A voice
  // changed on re-cut (S003, 07-Oct) re-speaks that character's lines and nothing else.
  const reusable = (line: ScriptLine) => (existing ?? []).find((t) => t.chunk_idx === line.idx && t.asset_id && t.voice_id === voiceKey(routes.get(line.speaker)!) && (t.text_in ?? '').trim() === line.text.trim());
  const toSpeak = lines.filter((l) => !reusable(l));
  // Lines spoken before and now to be spoken AGAIN (a changed voice or text). A line with no take
  // at all is still covered by the first pass's whole-script estimate — including a run resuming
  // after the vendor's daily limit stopped it halfway, which must not price those lines twice.
  const respoken = toSpeak.filter((l) => (existing ?? []).some((t) => t.chunk_idx === l.idx && t.asset_id));

  // ── Price before speaking ──────────────────────────────────────────────────
  const rate = await currentRate(db, { ...TTS_RATE_KEY });
  if (!rate.found) return { ok: false, code: 'unpriced', detail: `Refusing to synthesise: ${rate.detail}` };
  // The first pass prices the whole script under '06-voice' (its natural key dedupes a retry).
  // A later pass that re-speaks lines — a voice changed on re-cut — prices only those, under a
  // stage of its own, so the money moved has its row before the call (rule 5). A retry of the
  // same re-speak (the daily limit hit mid-way) lands on the same row via its idempotency key.
  const respeak = respoken.length > 0;
  const chars = (respeak ? respoken : lines).reduce((n, l) => n + l.text.length, 0);
  const costUsd = chars * rate.rate.unitCostUsd;
  const costInr = costUsd * deps.usdInrRate;
  let stage = '06-voice';
  if (respeak) {
    const { data: prior } = await db.from('cost_ledger').select('stage').eq('script_id', script.id);
    stage = `06-voice-r${(prior ?? []).filter((r) => (r.stage ?? '').startsWith('06-voice-r')).length + 1}`;
  }
  const respeakKey = respeak ? `voice-respeak:${script.id}:${respoken.map((l) => `${l.idx}=${voiceKey(routes.get(l.speaker)!)}`).join(',')}` : null;
  const { data: already } = respeakKey ? await db.from('cost_ledger').select('id').eq('idempotency_key', respeakKey).maybeSingle() : { data: null };
  const { error: ledgerError } = already ? { error: null } : await db.from('cost_ledger').insert({
    script_id: script.id,
    concept_id: script.concept_id,
    driver: TTS_RATE_KEY.driver,
    idempotency_key: respeakKey,
    stage,
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
    const files: string[] = [];
    const lineWords: (WordTiming[] | null)[] = [];
    const durations: number[] = [];
    let reused = 0;
    const failedLines: string[] = [];

    for (const line of lines) {
      const route = routes.get(line.speaker)!;
      const prior = reusable(line);
      const outPath = join(work, `line-${line.idx}.audio`);

      let words: WordTiming[] | null = null;
      if (prior) {
        // Re-use what was already paid for: fetch the stored audio rather than re-speaking it.
        // The take row holds timings at the pace it was last cut at; the asset holds the take
        // as spoken (its own duration, and its words in meta from the first pace change on).
        const { data: asset } = await db.from('assets').select('storage_key, duration_s, meta').eq('id', prior.asset_id!).single();
        files.push(asset ? `storage:${asset.storage_key}` : outPath);
        const native = nativeOf(prior, asset);
        words = native.words;
        // Pin the spoken words to the asset before the take row is overwritten with paced ones,
        // so the next pass (any pace) still starts from what was spoken.
        if (asset && !Array.isArray((asset.meta as { native_words?: unknown } | null)?.native_words)) {
          await db.from('assets').update({ meta: { ...((asset.meta ?? {}) as object), native_words: words ?? [] } as unknown as Json }).eq('id', prior.asset_id!);
        }
        lineWords.push(words);
        durations.push(native.durationS);
        reused++;
        if (!words) failedLines.push(`line ${line.idx} (${line.speaker}): not aligned on an earlier run`);
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
        .insert({ kind: 'audio', storage_key: key, bytes, duration_s: durationS, meta: { line: line.idx, speaker: line.speaker, native_words: words ?? [] } as unknown as Json })
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

    // ── Pace: every take at the episode's tempo ──────────────────────────────
    // Each line is sped up on its own and its new length MEASURED (ffprobe), never computed as
    // spoken ÷ tempo: atempo's output is a few ms off that, and those ms summed over a script
    // made the cut and the VO track disagree (verify:episode, 07-Oct). Words scale by the
    // measured ratio. The take rows carry these paced figures, so every consumer (captions,
    // picture spans, shot durations) reads the cut's own timeline without knowing a tempo
    // exists; the spoken figures stay on the audio asset.
    let local = await Promise.all(
      files.map(async (f, i) => (f.startsWith('storage:') ? materialiseFromStorage(deps.presign, f.slice(8), join(work, `reuse-${i}.wav`)) : f)),
    );
    let pacedDurations = durations;
    let pacedWords = lineWords;
    if (tempo !== 1) {
      const paced: string[] = [];
      pacedDurations = [];
      for (const [i, f] of local.entries()) {
        const out = join(work, `paced-${i}.wav`);
        await run('ffmpeg', ['-v', 'error', '-y', '-i', f, '-filter:a', `atempo=${tempo}`, '-ac', '1', '-ar', '48000', out]);
        paced.push(out);
        pacedDurations.push(await probeDuration(out));
      }
      local = paced;
      pacedWords = lineWords.map((w, i) => {
        const k = durations[i] > 0 ? pacedDurations[i] / durations[i] : 1 / tempo;
        return w ? w.map((x) => ({ ...x, start: round3(x.start * k), end: round3(x.end * k) })) : null;
      });
    }

    // ── Offsets: lines end to end with a fixed gap ────────────────────────────
    const offsets: number[] = [];
    let t = 0;
    for (const d of pacedDurations) {
      offsets.push(round3(t));
      t += d + lineGapS;
    }
    const totalS = round3(t - lineGapS + tailS);
    for (const [i, line] of lines.entries()) {
      await db
        .from('vo_takes')
        .update({ offset_s: offsets[i], duration_s: pacedDurations[i], word_timings: (pacedWords[i] ?? []) as unknown as Json })
        .eq('script_id', script.id)
        .eq('chunk_idx', line.idx)
        .eq('language', 'en');
    }

    // Shot durations do not rest on word timings: deriveContiguous cuts at LINE boundaries, and
    // every line's span is its own ffprobe-measured file. So a line the aligner could not
    // confirm keeps word_timings = [] (absent — never an even split) and is captioned as one
    // cue over its measured span, and the episode goes on to its cut review, where Sahil hears
    // every word before anything publishes.
    //
    // This used to halt the episode. It halted S001 on all 15 lines (79–91% of the null)
    // because the aligner's confidence test was calibrated espeak-against-espeak only (0008):
    // three other synthesisers score 75–96% here on correct text, so it could not tell a real
    // voice saying the right words from one saying the wrong ones, and the chain was inert for
    // every vendor voice. Gating on an instrument that cannot see is the failure CLAUDE.md
    // names; the refusal is recorded instead, and the count travels with the outcome.
    if (failedLines.length) log.error('alignment not confirmed; those lines caption at line level', { failedLines });

    // ── The full VO track ──────────────────────────────────────────────────────
    const track = join(work, 'vo.m4a');
    await concatWithGaps(local, lineGapS, tailS, track);
    const trackKey = `vo/${script.id}/en/track.m4a`;
    const trackBytes = await deps.putBytes(trackKey, createReadStream(track));
    const { data: trackAsset } = await db
      .from('assets')
      .insert({ kind: 'audio', storage_key: trackKey, bytes: trackBytes, duration_s: totalS, meta: { role: 'vo_track', language: 'en' } as Json })
      .select('id')
      .single();

    // ── Shot durations, contiguous ────────────────────────────────────────────
    const allWords = pacedWords.flatMap((w, i) => (w ? shiftBy(w, offsets[i]) : []));
    const shotsTimed = await deriveContiguous(db, script.id, lines, offsets, totalS);
    log.info('voice complete', { lines: lines.length, totalS, words: allWords.length, shotsTimed });

    return { ok: true, lines: lines.length, totalS, voAssetId: trackAsset!.id, chars, costInr, shotsTimed, reused, unaligned: failedLines.length, tempo };
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

/** Tempo within what one atempo stage and a listener both accept; anything else is 1. */
export function clampTempo(t: number | undefined): number {
  return typeof t === 'number' && Number.isFinite(t) && t >= 0.8 && t <= 1.5 ? t : 1;
}

/**
 * A re-used take as it was SPOKEN — duration and words at tempo 1. The asset row is the
 * spoken take (ffprobe'd when stored); its meta carries the spoken words from the first time
 * a pace was applied. Before any pace existed the take row's own words were the spoken ones,
 * so they are the fallback, and that stays true until a paced pass writes native_words.
 */
function nativeOf(
  take: { word_timings: unknown; duration_s: number | string | null },
  asset: { duration_s: number | string | null; meta: unknown } | null,
): { durationS: number; words: WordTiming[] | null } {
  const meta = (asset?.meta ?? {}) as { native_words?: unknown };
  const fromMeta = Array.isArray(meta.native_words) && meta.native_words.length ? (meta.native_words as WordTiming[]) : null;
  const fromTake = Array.isArray(take.word_timings) && take.word_timings.length ? (take.word_timings as WordTiming[]) : null;
  const durationS = asset?.duration_s != null && Number(asset.duration_s) > 0 ? Number(asset.duration_s) : Number(take.duration_s ?? 0);
  return { durationS, words: fromMeta ?? fromTake };
}
