import { z } from 'zod';

import { httpJson, type HttpFail } from './http';
import type { DriverErrorCode } from './types';
import { TTS_PRESET_IDS } from './voice-route';

/**
 * Voice, dubbing and sound effects on the Runway API (plan v2.2, decision 0013).
 *
 * Read from the vendor's published OpenAPI-generated SDK typings (runwayml/sdk-node,
 * `src/resources/{text-to-speech,voice-dubbing,sound-effect,tasks}.ts`) on 2026-10-06.
 * **Never called from this environment** — the API host is outside the egress allowlist —
 * so every shape is Zod-parsed and a drift fails as `upstream` with the parse error.
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

export const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
export const RUNWAY_VERSION = '2024-11-06';
export const VOICE_DRIVER = 'runway';
/** 1 credit = USD 0.01 (published). */
export const CREDIT_USD = 0.01;

export type TtsModel = 'eleven_v3' | 'eleven_multilingual_v2';

const Started = z.object({
  id: z.string().min(1),
  estimatedCost: z.object({ credits: z.number().nonnegative() }).optional(),
});

const Task = z.object({
  id: z.string().min(1),
  status: z.enum(['PENDING', 'THROTTLED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  output: z.array(z.string()).optional(),
  failure: z.string().optional(),
  failureCode: z.string().optional(),
});

export type Submitted =
  | { ok: true; taskId: string; estimatedCredits: number | null }
  | { ok: false; code: DriverErrorCode; detail: string; retryAfterS: number | null };

export type TaskState =
  | { state: 'running'; vendorState: string }
  | { state: 'succeeded'; outputUrl: string }
  | { state: 'failed'; code: DriverErrorCode; detail: string; retryAfterS: number | null };

const headers = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  'x-runway-version': RUNWAY_VERSION,
  'content-type': 'application/json',
});

const fail = (f: HttpFail): Submitted => ({ ok: false, code: f.code, detail: f.detail, retryAfterS: f.retryAfterS });

async function start(path: string, body: Record<string, unknown>, apiKey: string, fetchImpl?: typeof fetch): Promise<Submitted> {
  const res = await httpJson(`${RUNWAY_BASE}${path}`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), fetchImpl, timeoutMs: 30_000 });
  if (!res.ok) return fail(res);
  const parsed = Started.safeParse(res.json);
  if (!parsed.success) {
    return { ok: false, code: 'upstream', detail: `task start did not match the documented shape: ${parsed.error.message}`, retryAfterS: null };
  }
  return { ok: true, taskId: parsed.data.id, estimatedCredits: parsed.data.estimatedCost?.credits ?? null };
}

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

export async function readTask(input: { apiKey: string; taskId: string; fetchImpl?: typeof fetch }): Promise<TaskState> {
  const res = await httpJson(`${RUNWAY_BASE}/tasks/${encodeURIComponent(input.taskId)}`, {
    headers: headers(input.apiKey),
    fetchImpl: input.fetchImpl,
    timeoutMs: 20_000,
  });
  if (!res.ok) return { state: 'failed', code: res.code, detail: res.detail, retryAfterS: res.retryAfterS };
  const t = Task.safeParse(res.json);
  if (!t.success) return { state: 'failed', code: 'upstream', detail: `task did not match the documented shape: ${t.error.message}`, retryAfterS: null };
  if (t.data.status === 'SUCCEEDED') {
    const url = t.data.output?.[0];
    return url ? { state: 'succeeded', outputUrl: url } : { state: 'failed', code: 'upstream', detail: 'SUCCEEDED with no output URL', retryAfterS: null };
  }
  if (t.data.status === 'FAILED' || t.data.status === 'CANCELLED') {
    return {
      state: 'failed',
      code: /SAFETY|MODERATION/i.test(t.data.failureCode ?? '') ? 'content_rejected' : 'upstream',
      detail: t.data.failure ?? t.data.status,
      retryAfterS: null,
    };
  }
  return { state: 'running', vendorState: t.data.status };
}

/**
 * Poll a task to completion with backoff: 2 s doubling to 20 s, up to `maxWaitMs`. A
 * rate-limited read waits its Retry-After. Injected sleep so a harness is instant.
 */
export async function waitForTask(input: {
  apiKey: string;
  taskId: string;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<TaskState> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (input.maxWaitMs ?? 10 * 60_000);
  let delay = 2_000;
  for (;;) {
    const s = await readTask(input);
    if (s.state === 'succeeded') return s;
    if (s.state === 'failed' && s.code !== 'rate_limited' && s.code !== 'timeout') return s;
    if (Date.now() + delay > deadline) {
      return { state: 'failed', code: 'timeout', detail: `task ${input.taskId} still ${s.state === 'running' ? s.vendorState : s.code} at the deadline`, retryAfterS: null };
    }
    await sleep(s.state === 'failed' && s.retryAfterS ? s.retryAfterS * 1000 : delay);
    delay = Math.min(delay * 2, 20_000);
  }
}

/** Organisation read — the cheapest authenticated call, for Settings → Integrations. */
export async function readCreditBalance(apiKey: string, fetchImpl?: typeof fetch): Promise<{ ok: true; credits: number } | { ok: false; detail: string }> {
  const res = await httpJson(`${RUNWAY_BASE}/organization`, { headers: headers(apiKey), fetchImpl, timeoutMs: 15_000 });
  if (!res.ok) return { ok: false, detail: res.detail };
  const parsed = z.object({ creditBalance: z.number() }).safeParse(res.json);
  return parsed.success ? { ok: true, credits: parsed.data.creditBalance } : { ok: false, detail: 'organization read did not carry creditBalance' };
}
