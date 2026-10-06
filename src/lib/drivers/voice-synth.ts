import { writeFile } from 'node:fs/promises';

import { synthesise, TtsError } from './audio-tts';
import type { DriverErrorCode } from './types';
import type { VoiceRoute } from './voice-route';
import { submitSpeech, waitForTask } from './voice-runway';
import type { WordTiming } from '../voice/timings';

/**
 * One line of dialogue → one audio file, whichever vendor the character is routed to.
 *
 * The routing decision is `voiceRouteFor` (one predicate, shared). This is the dispatch on
 * its result, and the only place that knows the two vendors' call shapes:
 *
 *   runway       preset voice, eleven_v3, task polled to completion; NO timings — the caller
 *                aligns (src/lib/voice/align.ts)
 *   elevenlabs   designed voice, the existing direct driver; returns character timings,
 *                which the caller uses as-is (and still checks the word count)
 */

/** Integration field names, so core code never spells them. */
export const VOICE_CREDENTIAL_FIELDS = { runway: 'RUNWAY_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' } as const;

export type LineAudio =
  | { ok: true; path: string; requestId: string | null; words: WordTiming[] | null; estimatedCredits: number | null }
  | { ok: false; code: DriverErrorCode | string; detail: string };

export async function synthLine(input: {
  route: Extract<VoiceRoute, { ok: true }>;
  text: string;
  apiKey: string;
  outPath: string;
  language?: string;
  seed?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<LineAudio> {
  const f = input.fetchImpl ?? fetch;
  if (input.route.provider === 'runway') {
    const started = await submitSpeech({
      apiKey: input.apiKey,
      text: input.text,
      presetId: input.route.voiceId as Parameters<typeof submitSpeech>[0]['presetId'],
      model: 'eleven_v3',
      languageCode: input.language,
      seed: input.seed,
      fetchImpl: f,
    });
    if (!started.ok) return { ok: false, code: started.code, detail: started.detail };
    const done = await waitForTask({ apiKey: input.apiKey, taskId: started.taskId, fetchImpl: f, sleep: input.sleep, maxWaitMs: 5 * 60_000 });
    if (done.state !== 'succeeded') {
      return { ok: false, code: done.state === 'failed' ? done.code : 'timeout', detail: done.state === 'failed' ? done.detail : 'still running' };
    }
    const res = await f(done.outputUrl);
    if (!res.ok) return { ok: false, code: 'upstream', detail: `audio download returned HTTP ${res.status}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return { ok: false, code: 'upstream', detail: 'audio download was empty' };
    await writeFile(input.outPath, bytes);
    return { ok: true, path: input.outPath, requestId: started.taskId, words: null, estimatedCredits: started.estimatedCredits };
  }

  try {
    const r = await synthesise({ apiKey: input.apiKey, voiceId: input.route.voiceId, model: input.route.model, text: input.text, languageCode: input.language, seed: input.seed });
    await writeFile(input.outPath, Buffer.from(r.audioBase64, 'base64'));
    return { ok: true, path: input.outPath, requestId: r.requestId, words: r.words, estimatedCredits: null };
  } catch (err) {
    if (err instanceof TtsError) return { ok: false, code: err.code, detail: err.message };
    throw err;
  }
}

/** Where a dub's credit price lives in `rate_card` (0040): the credit is priced, the dub is not. */
export const DUB_RATE_KEY = { driver: 'runway', model: 'eleven_voice_dubbing', endpoint: '/v1/voice_dubbing', unit: 'credit' } as const;

/** The dubbing vendor's calls and credential, under names core code may use. */
export { submitDub as submitDubbing, waitForTask as waitForVoiceTask } from './voice-runway';
export const DUB_CREDENTIAL = { integration: DUB_RATE_KEY.driver, field: VOICE_CREDENTIAL_FIELDS.runway } as const;
