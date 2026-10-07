import { CREDIT_USD, RUNWAY_INTEGRATION, RUNWAY_KEY_FIELD, waitForTask, type RunwayCall } from './runway';
import { imageCredits, imageRateUnit, PROMPT_MAX, submitImage } from './video-runway';
import type { Charged } from './jobs';
import type { DriverErrorCode } from './types';

/**
 * Scene stills — the vendor-neutral face of one text-to-image call (decision 0021).
 *
 * Core code (`src/lib/bureau/stills.ts`) asks this module for a still and never learns which
 * vendor drew it (rule 1). Today it is the same vendor and credit pool as everything else
 * (0015): `gen4_image` at `720:1280`, 5 credits, priced by migration 0044's verified
 * `image_720p` row.
 *
 * ── No webhook, so a bounded wait ───────────────────────────────────────────
 *
 * The vendor's task endpoints accept no callback (0013, re-read for text-to-image in 0015).
 * A still takes seconds, not minutes, so it is waited on inside the episode step with the
 * same bounded backoff the voice stage uses (`waitForTask`: 5 s doubling to 20 s, the
 * vendor's own "no more than one read per five seconds"), capped at `STILL_WAIT_MS`. That is
 * the recorded exception to rule 4 for this call, for the same reason as 0013's: there is
 * nothing to subscribe to. Queueing stills through `gen_jobs` and the minute-cadence
 * dispatcher would add a minute of latency per still for no saving.
 */

export const STILL_PROVIDER = 'runway';
export const STILL_INTEGRATION = RUNWAY_INTEGRATION;
export const STILL_CREDENTIAL_FIELD = RUNWAY_KEY_FIELD;
export const STILL_MODEL = 'gen4_image' as const;
export const STILL_RATIO = '720:1280' as const;
export const STILL_WIDTH = 720;
export const STILL_HEIGHT = 1280;
/** The longest a single still is waited on before the shot falls back to its overlay. */
export const STILL_WAIT_MS = 180_000;
/** The vendor's prompt limit; a still prompt over it is refused, never clipped. */
export const STILL_PROMPT_MAX = PROMPT_MAX;
/**
 * Reference images one still may carry, and the tag shape the prompt names them by
 * (`@Pip`). Read from the vendor's SDK typings for text-to-image (sdk-node main,
 * `TextToImageCreateParams`, re-read 07-Oct-2026 for decision 0024): "one to three images";
 * a tag "must be 3-16 characters, start with a letter, and use only letters, digits, and
 * underscores"; a uri is "a HTTPS URL, Runway upload URI, or base64 data URI … up to 5MB".
 * `imageRequestBody` enforces the same limits before anything is ledgered.
 */
export const STILL_MAX_REFERENCES = 3;
export const STILL_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
export const STILL_TAG = /^[A-Za-z][A-Za-z0-9_]{2,15}$/;

/** Where the still's price lives in `rate_card` — the row the estimate and the ledger read. */
export const STILL_RATE_KEY = {
  driver: STILL_PROVIDER,
  model: STILL_MODEL,
  endpoint: '/v1/text_to_image',
  unit: imageRateUnit(STILL_RATIO),
} as const;

/** Credits one still costs at the published figure — checked against the rate row by test:bureau. */
export const STILL_CREDITS = imageCredits(STILL_MODEL, STILL_RATIO);
export const STILL_USD = STILL_CREDITS === null ? null : STILL_CREDITS * CREDIT_USD;

export type StillSubmitted = { ok: true; taskId: string } | { ok: false; code: DriverErrorCode; detail: string };

export type StillOutcome =
  | { state: 'succeeded'; outputUrl: string; charged: Charged | null }
  | { state: 'failed'; code: DriverErrorCode; detail: string; charged: Charged | null };

const charged = (credits: number | null | undefined): Charged | null =>
  credits === null || credits === undefined ? null : { quantity: credits, unit: 'credit', usd: credits * CREDIT_USD };

export async function submitStill(input: { prompt: string; apiKey: string; seed?: number; references?: { uri: string; tag: string }[]; fetchImpl?: typeof fetch; baseUrl?: string }): Promise<StillSubmitted> {
  const call: RunwayCall = { apiKey: input.apiKey, fetchImpl: input.fetchImpl, baseUrl: input.baseUrl };
  const r = await submitImage({ model: STILL_MODEL, prompt: input.prompt, ratio: STILL_RATIO, references: input.references ?? [], seed: input.seed }, call);
  return r.ok ? { ok: true, taskId: r.taskId } : { ok: false, code: r.code, detail: r.detail };
}

export async function waitStill(input: { apiKey: string; taskId: string; maxWaitMs?: number; sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch; baseUrl?: string }): Promise<StillOutcome> {
  const t = await waitForTask({ ...input, maxWaitMs: input.maxWaitMs ?? STILL_WAIT_MS });
  if (t.state === 'succeeded') return { state: 'succeeded', outputUrl: t.outputUrl, charged: charged(t.chargedCredits) };
  if (t.state === 'failed') return { state: 'failed', code: t.code, detail: t.detail, charged: charged(t.chargedCredits) };
  return { state: 'failed', code: 'timeout', detail: `still task ${input.taskId} still ${t.vendorState}`, charged: null };
}
