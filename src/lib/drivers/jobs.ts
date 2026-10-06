import { z } from 'zod';

import { httpJson, type HttpFail } from './http';
import type { DriverErrorCode } from './types';
import { fetchJobStatus, resultUrl } from './video-status';
import { submitGeneration } from './video-submit';

/**
 * The generation-queue drivers: one submit/poll/download shape over every vendor the
 * Bureau router can send a shot to.
 *
 * The routing table lives here, not in `src/lib/bureau/`, because it is the one place that
 * has to say which vendor serves which shot type — and rule 1 says that sentence may only
 * be written inside this directory. Core code asks for a *route* and receives an opaque
 * provider slug it stores and hands back.
 *
 * ── Webhook for the primary, polling for the rest ────────────────────────────
 *
 * Rule 4 prefers webhooks. The primary character-beat vendor has one and keeps using the
 * existing `/api/webhooks/...` route, so a job routed there is completed by the callback
 * and never polled. The other three expose long-running operations or task ids without a
 * callback we can rely on (one has webhooks; one polling path is easier to reason about
 * than two, and it is not on the critical path), so `23-gen-poll` polls them — at an
 * interval, through the per-provider concurrency the queue already enforces.
 *
 * ── Nothing here is verified against a live account ──────────────────────────
 *
 * Endpoints and response shapes are written from vendor documentation and parsed with Zod,
 * so a drifted shape fails loudly as `upstream` with the parse error rather than as a
 * silent success. Model ids come from prompt recipes, never from this file. 0008 §B1.
 */

export type RenderRoute = 'overlay' | 'character_beat' | 'acted_beat' | 'money_shot';

/** Which provider serves a route, and what to fall over to. Overlay is rendered in-house. */
export const ROUTE_PROVIDERS: Record<
  Exclude<RenderRoute, 'overlay'>,
  { primary: string; failover: string | null; webhook: boolean }
> = {
  character_beat: { primary: 'higgsfield', failover: 'fal', webhook: true },
  acted_beat: { primary: 'runway', failover: null, webhook: false },
  money_shot: { primary: 'gemini', failover: null, webhook: false },
};

/** Primary first, then failover. Core code matches recipes by these opaque slugs. */
export function providersForRoute(route: Exclude<RenderRoute, 'overlay'>): string[] {
  const r = ROUTE_PROVIDERS[route];
  return r.failover ? [r.primary, r.failover] : [r.primary];
}

/** Integration slug whose credentials a provider needs, in catalogue field order. */
export const PROVIDER_INTEGRATION: Record<string, string> = {
  higgsfield: 'higgsfield',
  fal: 'fal',
  runway: 'runway',
  gemini: 'gemini',
};

export function providerUsesWebhook(provider: string): boolean {
  return provider === 'higgsfield';
}

export interface JobSubmitInput {
  provider: string;
  model: string;
  endpoint: string | null;
  params: Record<string, unknown>;
  /** Credential values keyed by catalogue field key. */
  credentials: Record<string, string>;
  webhook?: { baseUrl: string; secret: string };
  fetchImpl?: typeof fetch;
}

export type JobSubmitResult =
  | { ok: true; requestId: string; pollRef: Record<string, string> }
  | { ok: false; code: DriverErrorCode; detail: string; retryAfterS: number | null };

export type JobPollResult =
  | { state: 'running'; vendorState: string }
  | { state: 'succeeded'; outputUrl: string; downloadHeaders: Record<string, string> }
  | { state: 'failed'; code: DriverErrorCode; detail: string; retryAfterS: number | null };

const fail = (f: HttpFail) => ({
  ok: false as const,
  code: f.code,
  detail: f.detail,
  retryAfterS: f.retryAfterS,
});

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';
const FAL_QUEUE = 'https://queue.fal.run';

// ── Response shapes (documented, unobserved) ───────────────────────────────────

const GeminiOperation = z.object({
  name: z.string().min(1),
  done: z.boolean().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
  response: z
    .object({
      generateVideoResponse: z
        .object({
          generatedSamples: z
            .array(z.object({ video: z.object({ uri: z.string().min(1) }) }))
            .optional(),
          raiMediaFilteredReasons: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

const RunwayTask = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  output: z.array(z.string()).optional(),
  failure: z.string().optional(),
  failureCode: z.string().optional(),
});

const FalQueued = z.object({
  request_id: z.string().min(1),
  status_url: z.url(),
  response_url: z.url(),
});
const FalStatus = z.object({ status: z.string().min(1) });
const FalResult = z.object({ video: z.object({ url: z.url() }) });

function parseFail(what: string, err: z.ZodError) {
  return {
    ok: false as const,
    code: 'upstream' as DriverErrorCode,
    detail: `${what} did not match the documented shape: ${err.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')}`,
    retryAfterS: null,
  };
}

/** Image inputs travel as URLs in our params; Gemini wants inline bytes. */
async function inlineImage(url: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Reference frame fetch returned HTTP ${res.status}.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    bytesBase64Encoded: bytes.toString('base64'),
    mimeType: res.headers.get('content-type') ?? 'image/png',
  };
}

export async function submitJob(input: JobSubmitInput): Promise<JobSubmitResult> {
  const f = input.fetchImpl ?? fetch;
  const p = input.params;

  switch (input.provider) {
    case 'higgsfield': {
      if (!input.webhook) {
        return {
          ok: false,
          code: 'invalid_input',
          detail: 'The primary character-beat vendor is webhook-only here; no callback was configured.',
          retryAfterS: null,
        };
      }
      const r = await submitGeneration({
        endpoint: input.endpoint ?? '',
        params: p,
        apiKey: input.credentials.HIGGSFIELD_API_KEY_ID ?? '',
        apiSecret: input.credentials.HIGGSFIELD_API_KEY_SECRET ?? '',
        webhookBaseUrl: input.webhook.baseUrl,
        webhookSecret: input.webhook.secret,
      });
      return r.ok
        ? { ok: true, requestId: r.jobId, pollRef: {} }
        : { ok: false, code: r.code, detail: r.detail, retryAfterS: null };
    }

    case 'gemini': {
      const key = input.credentials.GEMINI_API_KEY ?? '';
      const instance: Record<string, unknown> = { prompt: String(p.prompt ?? '') };
      if (typeof p.image_url === 'string') {
        try {
          instance.image = await inlineImage(p.image_url, f);
        } catch (err) {
          return { ok: false, code: 'invalid_input', detail: String(err), retryAfterS: null };
        }
      }
      const parameters: Record<string, unknown> = {
        aspectRatio: p.aspect_ratio ?? '9:16',
        resolution: p.resolution ?? '720p',
      };
      if (p.duration_s !== undefined) parameters.durationSeconds = Number(p.duration_s);
      if (typeof p.negative_prompt === 'string') parameters.negativePrompt = p.negative_prompt;

      const res = await httpJson(`${GEMINI_BASE}/models/${encodeURIComponent(input.model)}:predictLongRunning`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ instances: [instance], parameters }),
        fetchImpl: f,
      });
      if (!res.ok) return fail(res);
      const op = GeminiOperation.safeParse(res.json);
      if (!op.success) return parseFail('Veo operation', op.error);
      return { ok: true, requestId: op.data.name, pollRef: {} };
    }

    case 'runway': {
      const res = await httpJson(`${RUNWAY_BASE}/character_performance`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.credentials.RUNWAY_API_KEY ?? ''}`,
          'x-runway-version': RUNWAY_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model,
          character: { type: 'image', uri: p.character_image_url },
          reference: { type: 'video', uri: p.reference_video_url },
          ratio: p.ratio ?? '720:1280',
          bodyControl: p.body_control ?? true,
          expressionIntensity: p.expression_intensity ?? 3,
        }),
        fetchImpl: f,
      });
      if (!res.ok) return fail(res);
      const task = RunwayTask.safeParse(res.json);
      if (!task.success) return parseFail('Act-Two task', task.error);
      return { ok: true, requestId: task.data.id, pollRef: {} };
    }

    case 'fal': {
      const res = await httpJson(`${FAL_QUEUE}/${input.model}`, {
        method: 'POST',
        headers: {
          authorization: `Key ${input.credentials.FAL_KEY ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          prompt: p.prompt,
          image_url: p.image_url,
          duration: p.duration_s !== undefined ? String(p.duration_s) : undefined,
          aspect_ratio: p.aspect_ratio ?? '9:16',
          negative_prompt: p.negative_prompt,
        }),
        fetchImpl: f,
      });
      if (!res.ok) return fail(res);
      const q = FalQueued.safeParse(res.json);
      if (!q.success) return parseFail('fal queue submit', q.error);
      return {
        ok: true,
        requestId: q.data.request_id,
        pollRef: { status_url: q.data.status_url, response_url: q.data.response_url },
      };
    }

    default:
      return {
        ok: false,
        code: 'invalid_input',
        detail: `No job driver for provider "${input.provider}".`,
        retryAfterS: null,
      };
  }
}

export async function pollJob(input: {
  provider: string;
  requestId: string;
  pollRef: Record<string, string>;
  credentials: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<JobPollResult> {
  const f = input.fetchImpl ?? fetch;

  switch (input.provider) {
    case 'higgsfield': {
      // Reconciliation only — the webhook is the primary completion path.
      try {
        const status = await fetchJobStatus({
          jobId: input.requestId,
          apiKey: input.credentials.HIGGSFIELD_API_KEY_ID ?? '',
          apiSecret: input.credentials.HIGGSFIELD_API_KEY_SECRET ?? '',
        });
        const url = resultUrl(status);
        if (/complete|succeed/i.test(status.status) && url) {
          return { state: 'succeeded', outputUrl: url, downloadHeaders: {} };
        }
        if (/fail|nsfw|cancel/i.test(status.status)) {
          return { state: 'failed', code: 'upstream', detail: status.status, retryAfterS: null };
        }
        return { state: 'running', vendorState: status.status };
      } catch (err) {
        return { state: 'failed', code: 'upstream', detail: String(err), retryAfterS: 30 };
      }
    }

    case 'gemini': {
      const key = input.credentials.GEMINI_API_KEY ?? '';
      const res = await httpJson(`${GEMINI_BASE}/${input.requestId}`, {
        headers: { 'x-goog-api-key': key },
        fetchImpl: f,
      });
      if (!res.ok) return { state: 'failed', code: res.code, detail: res.detail, retryAfterS: res.retryAfterS };
      const op = GeminiOperation.safeParse(res.json);
      if (!op.success) {
        return { state: 'failed', ...parseFail('Veo operation', op.error), retryAfterS: null };
      }
      if (!op.data.done) return { state: 'running', vendorState: 'pending' };
      if (op.data.error) {
        return { state: 'failed', code: 'upstream', detail: op.data.error.message ?? 'operation error', retryAfterS: null };
      }
      const uri = op.data.response?.generateVideoResponse?.generatedSamples?.[0]?.video.uri;
      if (!uri) {
        const filtered = op.data.response?.generateVideoResponse?.raiMediaFilteredReasons;
        return {
          state: 'failed',
          code: filtered?.length ? 'content_rejected' : 'upstream',
          detail: filtered?.join('; ') || 'Operation finished with no video.',
          retryAfterS: null,
        };
      }
      // The URI needs the key to download. It travels as a header held by the worker,
      // never appended to a URL that would end up in a task payload or a log line.
      return { state: 'succeeded', outputUrl: uri, downloadHeaders: { 'x-goog-api-key': key } };
    }

    case 'runway': {
      const res = await httpJson(`${RUNWAY_BASE}/tasks/${encodeURIComponent(input.requestId)}`, {
        headers: {
          authorization: `Bearer ${input.credentials.RUNWAY_API_KEY ?? ''}`,
          'x-runway-version': RUNWAY_VERSION,
        },
        fetchImpl: f,
      });
      if (!res.ok) return { state: 'failed', code: res.code, detail: res.detail, retryAfterS: res.retryAfterS };
      const task = RunwayTask.safeParse(res.json);
      if (!task.success) return { state: 'failed', ...parseFail('Act-Two task', task.error), retryAfterS: null };
      const s = (task.data.status ?? '').toUpperCase();
      if (s === 'SUCCEEDED' && task.data.output?.[0]) {
        return { state: 'succeeded', outputUrl: task.data.output[0], downloadHeaders: {} };
      }
      if (s === 'FAILED' || s === 'CANCELLED') {
        return {
          state: 'failed',
          code: /SAFETY|MODERATION/i.test(task.data.failureCode ?? '') ? 'content_rejected' : 'upstream',
          detail: task.data.failure ?? s,
          retryAfterS: null,
        };
      }
      // THROTTLED is the vendor's own queue, not a failure: it is still ours to wait on.
      return { state: 'running', vendorState: s || 'UNKNOWN' };
    }

    case 'fal': {
      const auth = { authorization: `Key ${input.credentials.FAL_KEY ?? ''}` };
      const statusUrl = input.pollRef.status_url;
      const responseUrl = input.pollRef.response_url;
      if (!statusUrl || !responseUrl) {
        return { state: 'failed', code: 'invalid_input', detail: 'Missing fal poll URLs.', retryAfterS: null };
      }
      const st = await httpJson(statusUrl, { headers: auth, fetchImpl: f });
      if (!st.ok) return { state: 'failed', code: st.code, detail: st.detail, retryAfterS: st.retryAfterS };
      const parsed = FalStatus.safeParse(st.json);
      if (!parsed.success) return { state: 'failed', ...parseFail('fal status', parsed.error), retryAfterS: null };
      if (parsed.data.status !== 'COMPLETED') return { state: 'running', vendorState: parsed.data.status };
      const out = await httpJson(responseUrl, { headers: auth, fetchImpl: f });
      if (!out.ok) return { state: 'failed', code: out.code, detail: out.detail, retryAfterS: out.retryAfterS };
      const result = FalResult.safeParse(out.json);
      if (!result.success) return { state: 'failed', ...parseFail('fal result', result.error), retryAfterS: null };
      return { state: 'succeeded', outputUrl: result.data.video.url, downloadHeaders: {} };
    }

    default:
      return { state: 'failed', code: 'invalid_input', detail: `No job driver for "${input.provider}".`, retryAfterS: null };
  }
}

/**
 * Cheapest authenticated call per vendor, for Settings → Integrations. Gemini lists
 * models, Runway reads the organisation, fal has no free read so it is reported unprobed.
 */
export async function probeJobVendor(
  slug: string,
  values: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ passed: boolean; detail: string } | null> {
  if (slug === 'gemini') {
    const r = await httpJson(`${GEMINI_BASE}/models?pageSize=1`, {
      headers: { 'x-goog-api-key': values.GEMINI_API_KEY ?? '' },
      fetchImpl,
      timeoutMs: 15_000,
    });
    return r.ok ? { passed: true, detail: 'Model list read.' } : { passed: false, detail: r.detail };
  }
  if (slug === 'runway') {
    const r = await httpJson(`${RUNWAY_BASE}/organization`, {
      headers: { authorization: `Bearer ${values.RUNWAY_API_KEY ?? ''}`, 'x-runway-version': RUNWAY_VERSION },
      fetchImpl,
      timeoutMs: 15_000,
    });
    return r.ok ? { passed: true, detail: 'Organisation read.' } : { passed: false, detail: r.detail };
  }
  return null;
}
