import { backoffMs, dispositionFor, modelFor, synthesise, TtsError } from '../drivers/audio-tts';
import { primaryForKind } from '../drivers/catalog';
import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { chunkVoText, ChunkError } from './chunk';
import { deriveShotDurations, shiftBy, takeDuration, type WordTiming } from './timings';

/**
 * Stage 6 — voice. Runs **ahead** of stage 5, which is the whole point.
 *
 * Addendum 02 §1 inverts the DAG: the VO is synthesised first, its word timings define the
 * beat boundaries, and those boundaries set `shots.duration_s`. Video is then generated to
 * fit real speech rather than speech being stretched to fit video. The reason is economic —
 * VO costs about a hundredth of video generation, so a bad duration estimate should be paid
 * for by regenerating the cheap artifact.
 *
 * This is where `shots.vo_char_start/end` is finally used. Its absence was recorded as a
 * specification error in 0009: the addendum specified word-timing-derived durations and
 * gave shots no link to a range of speech, which made the mechanism uncomputable on the
 * page that specified it.
 *
 * ** NEVER RUN. ** The vendor host is refused by this environment's egress policy.
 */

export interface VoicePayload {
  scriptId: string;
  voiceId: string;
  language?: string;
  format?: 'short' | 'long';
  seed?: number;
}

export interface VoiceDeps {
  db: Db;
  apiKey: string;
  usdInrRate: number;
  /** From `integrations.concurrency_limit`. 2 when the tier read fell back to a default. */
  concurrency: number;
  runId: string;
  log?: { info(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
  /** Injected so a test can make backoff deterministic. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export type VoiceRunResult =
  | {
      ok: true;
      scriptId: string;
      takes: number;
      totalDurationS: number;
      charactersBilled: number;
      shotsTimed: number;
      shotsLeftAuthored: number;
      costInr: number;
    }
  | { ok: false; code: string; detail: string; takesWritten: number };

const noop = { info: () => {}, error: () => {} };
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries for the transient classes only. Anything `fail_fast` gets none. */
const MAX_ATTEMPTS = 6;

export async function runVoice(
  payload: VoicePayload,
  deps: VoiceDeps,
): Promise<VoiceRunResult> {
  const { db, apiKey, usdInrRate, runId } = deps;
  const log = deps.log ?? noop;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  const language = payload.language ?? 'en';
  const format = payload.format ?? 'short';

  // Asked for by capability, never named. The voice vendor is a config value like the
  // generator (ARCHITECTURE.md §0.1), and the isolation check refuses a literal here —
  // correctly: the caller wants "the voice driver", not a particular company.
  const audio = primaryForKind('audio');
  if (!audio) throw new Error('No audio integration is marked primary in the catalogue.');
  const driver = audio.slug;

  const { data: script, error: scriptError } = await db
    .from('scripts')
    .select('id, concept_id, vo_text')
    .eq('id', payload.scriptId)
    .single();

  if (scriptError || !script) {
    throw new Error(`Script ${payload.scriptId} not found: ${scriptError?.message}`);
  }

  const choice = modelFor({ format, language });
  log.info('model chosen', { model: choice.model, reason: choice.reason });

  // ── Refuse to spend before the spend can be recorded ───────────────────────
  //
  // Same rule-5 guard as stages 3 and 4, and it will refuse on a fresh install: the
  // character rates are seeded at zero and unverified, because nobody publishes them and
  // they have to be read off a real invoice. That refusal is correct.
  const rate = await currentRate(db, {
    driver,
    model: choice.model,
    endpoint: '/v1/text-to-speech/with-timestamps',
    unit: 'character',
  });

  if (!rate.found) {
    throw new Error(
      `Refusing to synthesise: the call cannot be priced (${rate.reason}). ${rate.detail}\n\n` +
        'Every call that costs money writes a ledger row at the time it is made, and a row ' +
        'that cannot be written is a call that must not be made.',
    );
  }

  // ── Pronunciation dictionaries, applied per request ────────────────────────
  //
  // Not optional for this niche: Indian place names, brand names and gaming acronyms are
  // mispronounced by default. Three is the vendor's cap, so the most recently updated three
  // win rather than the request being rejected outright.
  // Read from the locator view, not from the rules table. `pronunciations` holds rules;
  // the API takes locators for a dictionary uploaded to the vendor, and 0012 added the
  // table that connects the two. A rule in no dictionary is applied to nothing.
  const { data: dictionaries } = await db
    .from('v_pronunciation_locators')
    .select('name, vendor_dictionary_id, vendor_version_id, stale')
    .eq('language', language)
    .order('synced_at', { ascending: false })
    .limit(3);

  const locators = (dictionaries ?? [])
    .filter((d) => d.vendor_dictionary_id && d.vendor_version_id)
    .map((d) => ({
      pronunciation_dictionary_id: d.vendor_dictionary_id!,
      version_id: d.vendor_version_id!,
    }));

  // Stale means the local rules changed after the upload, so the vendor applies the
  // previous set. Surfaced rather than silently used: it presents as a pronunciation fix
  // that did not take, which is a long way to chase from the audio.
  const stale = (dictionaries ?? []).filter((d) => d.stale).map((d) => d.name);
  if (stale.length) log.error('pronunciation dictionaries are stale', { stale });

  // ── Chunk ──────────────────────────────────────────────────────────────────
  let chunks;
  try {
    chunks = chunkVoText(script.vo_text, { maxChars: choice.maxChars });
  } catch (err) {
    if (err instanceof ChunkError) {
      return { ok: false, code: 'unchunkable', detail: err.message, takesWritten: 0 };
    }
    throw err;
  }

  log.info('chunked', { chunks: chunks.length, model: choice.model });

  // ── Synthesise ─────────────────────────────────────────────────────────────
  //
  // Sequential, and not because it is simpler. Each chunk sends the previous chunk's
  // request id so prosody carries across the seam, which makes chunk N depend on chunk N-1
  // having returned. The concurrency ceiling below therefore bounds *scripts* in flight
  // rather than chunks within one — which is what the ceiling is actually for, since it is
  // an account-wide limit.
  const allWords: WordTiming[] = [];
  let offsetS = 0;
  let charactersBilled = 0;
  let previousRequestId: string | null = null;
  let takesWritten = 0;

  for (const chunk of chunks) {
    let attempt = 0;
    let result;

    // Retry loop. `queue_and_wait` and `retry_with_backoff` are different dispositions and
    // both land here, but for different reasons — see the taxonomy in the driver. Queueing
    // waits for a slot the account will free; backing off waits for the vendor to recover.
    for (;;) {
      attempt++;
      try {
        result = await synthesise({
          apiKey,
          voiceId: payload.voiceId,
          model: choice.model,
          text: chunk.text,
          languageCode: language,
          pronunciationLocators: locators.length ? locators : undefined,
          previousRequestIds: previousRequestId ? [previousRequestId] : undefined,
          seed: payload.seed,
        });
        break;
      } catch (err) {
        if (!(err instanceof TtsError)) throw err;

        const disposition = dispositionFor(err.code);
        if (disposition === 'fail_fast' || attempt >= MAX_ATTEMPTS) {
          log.error('synthesis failed', { chunk: chunk.idx, code: err.code, attempt });
          return {
            ok: false,
            code: err.code,
            detail: `chunk ${chunk.idx} after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${err.message}`,
            takesWritten,
          };
        }

        // A concurrency refusal means the slot is occupied, not that the vendor is unwell.
        // Waiting a flat interval for a slot to free is the right shape; jittered
        // exponential backoff is for an overloaded service and would idle through slots
        // that opened seconds ago.
        const waitMs =
          disposition === 'queue_and_wait' ? 2_000 : backoffMs(attempt, random);

        log.info('retrying', { chunk: chunk.idx, code: err.code, disposition, waitMs, attempt });
        await sleep(waitMs);
      }
    }

    const words = result.words;
    const duration = takeDuration(words);

    // The take's words in whole-script time. The offset is the running sum of every
    // preceding take, which is why `duration_s` is stored rather than re-derived.
    allWords.push(...shiftBy(words, offsetS));

    const { error: takeError } = await db.from('vo_takes').upsert(
      {
        script_id: script.id,
        chunk_idx: chunk.idx,
        driver,
        model: choice.model,
        voice_id: payload.voiceId,
        language,
        text_in: chunk.text,
        word_timings: words as unknown as Json,
        offset_s: offsetS,
        duration_s: duration,
        request_id: result.requestId,
        characters_billed: result.charactersBilled,
        seed: payload.seed ?? null,
      },
      { onConflict: 'script_id,chunk_idx,language' },
    );

    if (takeError) {
      // The call was billed. Failing without recording it would under-report the metric
      // that cannot be backfilled, so the ledger row below still gets written for whatever
      // was synthesised.
      log.error('vo_take write failed', { chunk: chunk.idx, error: takeError.message });
      return {
        ok: false,
        code: 'take_write_failed',
        detail: takeError.message,
        takesWritten,
      };
    }

    takesWritten++;
    charactersBilled += result.charactersBilled;
    offsetS += duration;
    previousRequestId = result.requestId;
  }

  // ── Cost ───────────────────────────────────────────────────────────────────
  const costUsd = charactersBilled * rate.rate.unitCostUsd;
  const costInr = costUsd * usdInrRate;

  const { error: costError } = await db.from('cost_ledger').upsert(
    {
      script_id: script.id,
      concept_id: script.concept_id,
      driver,
      stage: '06-voice',
      entry_kind: 'reconcile',
      unit: 'character',
      quantity: charactersBilled,
      cost_usd: costUsd,
      cost_inr: costInr,
      usd_inr_rate: usdInrRate,
    },
    { onConflict: 'script_id,stage,entry_kind,unit', ignoreDuplicates: true },
  );

  if (costError) {
    throw new Error(
      `Cost ledger write failed for script ${script.id} after ${charactersBilled} characters ` +
        `were billed: ${costError.message}`,
    );
  }

  // ── Shot durations ─────────────────────────────────────────────────────────
  //
  // The payoff. Every shot whose span matches spoken words gets a measured duration and
  // `duration_source = 'derived_from_vo'`; the rest keep the shotlist's estimate and say
  // why, rather than being collapsed to zero.
  const { data: shots } = await db
    .from('shots')
    .select('id, idx, vo_char_start, vo_char_end, duration_s')
    .eq('script_id', script.id)
    .order('idx');

  const derived = deriveShotDurations(
    (shots ?? []).map((s) => ({
      shotId: s.id,
      idx: s.idx,
      voCharStart: s.vo_char_start,
      voCharEnd: s.vo_char_end,
      authoredDurationS: Number(s.duration_s),
    })),
    script.vo_text,
    allWords,
  );

  let shotsTimed = 0;
  for (const d of derived) {
    if (d.source !== 'derived_from_vo') continue;
    const { error } = await db
      .from('shots')
      .update({ duration_s: d.durationS, duration_source: 'derived_from_vo' })
      .eq('id', d.shotId);
    if (error) log.error('shot duration not written', { shotId: d.shotId, error: error.message });
    else shotsTimed++;
  }

  log.info('voice complete', {
    takes: takesWritten,
    totalDurationS: offsetS,
    shotsTimed,
    costInr,
    runId,
  });

  return {
    ok: true,
    scriptId: script.id,
    takes: takesWritten,
    totalDurationS: Math.round(offsetS * 1000) / 1000,
    charactersBilled,
    shotsTimed,
    shotsLeftAuthored: derived.length - shotsTimed,
    costInr,
  };
}
