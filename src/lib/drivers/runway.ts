import { z } from 'zod';

import { httpJson, type HttpFail } from './http';
import type { DriverErrorCode } from './types';

/**
 * The one Runway HTTP client (decisions 0013 and 0015).
 *
 * Voice, dubs, sound effects, Act-Two, image-to-video, text-to-video and text-to-image all
 * start a task with a POST and finish on `GET /v1/tasks/{id}`. Before 0015 there were two
 * copies of that: this file's predecessor in `voice-runway.ts` and a hand-rolled block in
 * `jobs.ts` for Act-Two, with different task schemas — one parsed `status` as an enum, the
 * other as any string. Two clients for one vendor is the "two modules for one concept"
 * defect in CLAUDE.md waiting for its first divergence, so both now import from here.
 *
 * Shapes read from the vendor's OpenAPI-generated SDK (`runwayml/sdk-node` 4.21.0, main,
 * `src/resources/{tasks,image-to-video,text-to-video,text-to-image,organization}.ts`,
 * fetched 2026-10-06). **Never called from this container** — the API host is outside the
 * egress allowlist — so every response is Zod-parsed and a drift fails as `upstream` with
 * the parse error.
 *
 * ── No webhooks ──────────────────────────────────────────────────────────────
 *
 * No task-starting endpoint accepts a callback and the task resource has no callback field
 * (0013). Tasks are polled with backoff. The SDK's own note on `tasks.retrieve`: "Consumers
 * of this API should not expect updates more frequent than once every five seconds".
 *
 * ── What a terminal task tells us about money ────────────────────────────────
 *
 * SUCCEEDED, FAILED and CANCELLED carry `cost.credits` — "Final cost in credits for a
 * terminal task. Fully refunded tasks report 0". That is the vendor telling us what it
 * charged, which is what `cost_ledger.cost_source = 'measured'` means (0032). It is parsed
 * as optional because it has never been observed: a terminal task without it yields
 * `chargedCredits: null`, and null is "not told", never 0.
 */

export const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
export const RUNWAY_VERSION = '2024-11-06';
/** 1 credit = USD 0.01 (published; Runway API credits, a separate pool from app credits). */
export const CREDIT_USD = 0.01;
/** The integration slug whose credential this client needs. */
export const RUNWAY_INTEGRATION = 'runway';
export const RUNWAY_KEY_FIELD = 'RUNWAY_API_KEY';

const Started = z.object({
  id: z.string().min(1),
  estimatedCost: z.object({ credits: z.number().nonnegative() }).optional(),
});

const Credits = z.object({ credits: z.number().nonnegative() });

export const RunwayTaskSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['PENDING', 'THROTTLED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  output: z.array(z.string()).optional(),
  failure: z.string().optional(),
  failureCode: z.string().optional(),
  cost: Credits.optional(),
  estimatedCost: Credits.optional(),
});

export type Submitted =
  | { ok: true; taskId: string; estimatedCredits: number | null }
  | { ok: false; code: DriverErrorCode; detail: string; retryAfterS: number | null };

export type TaskState =
  | { state: 'running'; vendorState: string }
  | { state: 'succeeded'; outputUrl: string; chargedCredits: number | null }
  | { state: 'failed'; code: DriverErrorCode; detail: string; retryAfterS: number | null; chargedCredits?: number | null };

export interface RunwayCall {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Harness override only. Production always talks to RUNWAY_BASE. */
  baseUrl?: string;
}

const headers = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  'x-runway-version': RUNWAY_VERSION,
  'content-type': 'application/json',
});

const fail = (f: HttpFail): Submitted => ({ ok: false, code: f.code, detail: f.detail, retryAfterS: f.retryAfterS });

/** POST a task-starting endpoint. `path` is relative to /v1, e.g. `/image_to_video`. */
export async function startTask(path: string, body: Record<string, unknown>, call: RunwayCall): Promise<Submitted> {
  if (!call.apiKey) {
    return { ok: false, code: 'auth', detail: 'No RUNWAY_API_KEY — Settings → Integrations → Runway.', retryAfterS: null };
  }
  const res = await httpJson(`${call.baseUrl ?? RUNWAY_BASE}${path}`, {
    method: 'POST',
    headers: headers(call.apiKey),
    body: JSON.stringify(body),
    fetchImpl: call.fetchImpl,
    timeoutMs: 30_000,
  });
  if (!res.ok) return fail(res);
  const parsed = Started.safeParse(res.json);
  if (!parsed.success) {
    return { ok: false, code: 'upstream', detail: `task start did not match the documented shape: ${parsed.error.message}`, retryAfterS: null };
  }
  return { ok: true, taskId: parsed.data.id, estimatedCredits: parsed.data.estimatedCost?.credits ?? null };
}

export async function readTask(input: RunwayCall & { taskId: string }): Promise<TaskState> {
  const res = await httpJson(`${input.baseUrl ?? RUNWAY_BASE}/tasks/${encodeURIComponent(input.taskId)}`, {
    headers: headers(input.apiKey),
    fetchImpl: input.fetchImpl,
    timeoutMs: 20_000,
  });
  if (!res.ok) return { state: 'failed', code: res.code, detail: res.detail, retryAfterS: res.retryAfterS };
  const t = RunwayTaskSchema.safeParse(res.json);
  if (!t.success) return { state: 'failed', code: 'upstream', detail: `task did not match the documented shape: ${t.error.message}`, retryAfterS: null };
  const charged = t.data.cost?.credits ?? null;
  if (t.data.status === 'SUCCEEDED') {
    const url = t.data.output?.[0];
    return url
      ? { state: 'succeeded', outputUrl: url, chargedCredits: charged }
      : { state: 'failed', code: 'upstream', detail: 'SUCCEEDED with no output URL', retryAfterS: null, chargedCredits: charged };
  }
  if (t.data.status === 'FAILED' || t.data.status === 'CANCELLED') {
    return {
      state: 'failed',
      code: /SAFETY|MODERATION/i.test(t.data.failureCode ?? '') ? 'content_rejected' : 'upstream',
      detail: t.data.failure ?? t.data.status,
      retryAfterS: null,
      chargedCredits: charged,
    };
  }
  // THROTTLED is the vendor's own queue, not a failure: it is still ours to wait on.
  return { state: 'running', vendorState: t.data.status };
}

/**
 * Poll a task to completion with backoff: 5 s doubling to 20 s (the vendor asks for no more
 * than one read per five seconds), up to `maxWaitMs`. A rate-limited read waits its
 * Retry-After. Injected sleep so a harness is instant.
 */
export async function waitForTask(
  input: RunwayCall & { taskId: string; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<TaskState> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (input.maxWaitMs ?? 10 * 60_000);
  let delay = 5_000;
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

/** Organisation read — the cheapest authenticated call, and the balance a measurement watches. */
export async function readCreditBalance(
  apiKey: string,
  fetchImpl?: typeof fetch,
  baseUrl?: string,
): Promise<{ ok: true; credits: number } | { ok: false; detail: string }> {
  const res = await httpJson(`${baseUrl ?? RUNWAY_BASE}/organization`, { headers: headers(apiKey), fetchImpl, timeoutMs: 15_000 });
  if (!res.ok) return { ok: false, detail: res.detail };
  const parsed = z.object({ creditBalance: z.number() }).safeParse(res.json);
  return parsed.success ? { ok: true, credits: parsed.data.creditBalance } : { ok: false, detail: 'organization read did not carry creditBalance' };
}
