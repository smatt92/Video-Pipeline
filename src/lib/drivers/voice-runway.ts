import { startTask, type Submitted } from './runway';
import { TTS_PRESET_IDS } from './voice-route';

/**
 * Voice, dubbing and sound effects on the Runway API (plan v2.2, decision 0013).
 *
 * Read from the vendor's published OpenAPI-generated SDK typings (runwayml/sdk-node,
 * `src/resources/{text-to-speech,voice-dubbing,sound-effect,tasks}.ts`) on 2026-10-06.
 * **Never called from this environment** — the API host is outside the egress allowlist —
 * so every shape is Zod-parsed and a drift fails as `upstream` with the parse error.
 *
 * The HTTP client, the task schema and the polling live in `runway.ts` (0015): one client
 * for every Runway surface.
 *
 * ── Tasks, polled ────────────────────────────────────────────────────────────
 *
 * Every endpoint starts a task and returns `{ id, estimatedCost: { credits } }`. The result
 * arrives on `GET /v1/tasks/{id}` as `status: SUCCEEDED, output: [url]`. The SDK has no
 * webhook or callback option on any of these endpoints and the task resource carries no
 * callback field, so CLAUDE.md rule 4 cannot be met here: the caller polls, with backoff,
 * inside the Trigger task (recorded in 0013). `THROTTLED` is the vendor's own queue and is
 * waited on, not failed.
 *
 * ── Options whose default is the behaviour we avoid are passed explicitly ────
 *
 * Text normalisation (`auto` lets the model rewrite numbers — "3.8 cm" read differently from
 * the script breaks forced alignment), dubbing's voice cloning (on — the dub must sound like
 * the character, not a generic voice) and background removal (off — we dub the voice stem).
 */

export { CREDIT_USD, readCreditBalance, readTask, RUNWAY_BASE, RUNWAY_VERSION, waitForTask } from './runway';
export type { Submitted, TaskState } from './runway';
export const VOICE_DRIVER = 'runway';

export type TtsModel = 'eleven_v3' | 'eleven_multilingual_v2';

const start = (path: string, body: Record<string, unknown>, apiKey: string, fetchImpl?: typeof fetch): Promise<Submitted> =>
  startTask(path, body, { apiKey, fetchImpl });

export function submitSpeech(input: {
  apiKey: string;
  text: string;
  presetId: (typeof TTS_PRESET_IDS)[number];
  model?: TtsModel;
  languageCode?: string;
  seed?: number;
  fetchImpl?: typeof fetch;
}): Promise<Submitted> {
  const model = input.model ?? 'eleven_v3';
  return start(
    '/text_to_speech',
    {
      model,
      promptText: input.text,
      voice: { type: 'runway-preset', presetId: input.presetId },
      // v2 takes neither field; v3 takes both, and its normaliser default is the one we avoid.
      ...(model === 'eleven_v3'
        ? { applyTextNormalization: 'off', ...(input.languageCode ? { languageCode: input.languageCode } : {}) }
        : {}),
      ...(input.seed !== undefined && model === 'eleven_v3' ? { seed: input.seed } : {}),
    },
    input.apiKey,
    input.fetchImpl,
  );
}

/** Runway's target codes: `pt` for Brazilian Portuguese (a regional code is read as its language). */
export const DUB_TARGET: Record<'hi' | 'es' | 'pt-BR', string> = { hi: 'hi', es: 'es', 'pt-BR': 'pt' };

export function submitDub(input: {
  apiKey: string;
  audioUrl: string;
  language: 'hi' | 'es' | 'pt-BR';
  speakers: number;
  fetchImpl?: typeof fetch;
}): Promise<Submitted> {
  return start(
    '/voice_dubbing',
    {
      model: 'eleven_voice_dubbing',
      audioUri: input.audioUrl,
      targetLang: DUB_TARGET[input.language],
      disableVoiceCloning: false,
      dropBackgroundAudio: false,
      numSpeakers: input.speakers,
    },
    input.apiKey,
    input.fetchImpl,
  );
}

export function submitSoundEffect(input: { apiKey: string; prompt: string; durationS: number; fetchImpl?: typeof fetch }): Promise<Submitted> {
  return start(
    '/sound_effect',
    { model: 'eleven_text_to_sound_v2', promptText: input.prompt, duration: input.durationS, loop: false },
    input.apiKey,
    input.fetchImpl,
  );
}
