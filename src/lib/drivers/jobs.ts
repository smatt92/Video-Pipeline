import { z } from 'zod';

import { httpJson, type HttpFail } from './http';
import { CREDIT_USD, readCreditBalance, readTask, RUNWAY_KEY_FIELD } from './runway';
import type { DriverErrorCode } from './types';
import { submitPerformance, submitVideo } from './video-runway';
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
 * ── Polling, and the one webhook that is now dormant ──────────────────────────
 *
 * Rule 4 prefers webhooks. Since 0015 every route's primary is Runway, which offers none
 * (0013), so `21-gen-dispatch` polls its tasks — once a minute, through the per-provider
 * concurrency the queue already enforces. That is the recorded exception to rule 4 for this
 * vendor. The previous character-beat vendor keeps its webhook path for when failover is
 * switched on; a job routed there is completed by the callback and never polled.
 *
 * ── Nothing here is verified against a live account ──────────────────────────
 *
 * Endpoints and response shapes are written from vendor documentation and parsed with Zod,
 * so a drifted shape fails loudly as `upstream` with the parse error rather than as a
 * silent success. Model ids come from prompt recipes, never from this file. 0008 §B1.
 */

export type RenderRoute = 'overlay' | 'picture_clip' | 'character_beat' | 'acted_beat' | 'money_shot';
type GeneratedRoute = Exclude<RenderRoute, 'overlay'>;

/**
 * Which provider serves a route, and what it may fall over to (decision 0015).
 *
 * Runway first for every generated route: one vendor, one credit pool. The previous primaries
 * stay as **dormant failover** — still in the code, still typechecked and harnessed, and
 * routed to only when `GENERATION_FAILOVER=on`. With the flag off (the default, and the
 * state production runs in) a missing HIGGSFIELD_* or FAL_KEY blocks nothing, because no
 * route ever names them.
 */
export const ROUTE_PROVIDERS: Record<GeneratedRoute, { primary: string; failover: readonly string[] }> = {
  // A clip animated from the shot's own picture (0052, the engineered format). No failover:
  // the dormant providers were never wired for a first-frame clip of an arbitrary picture.
  picture_clip: { primary: 'runway', failover: [] },
  character_beat: { primary: 'runway', failover: ['higgsfield', 'fal'] },
  acted_beat: { primary: 'runway', failover: [] },
  money_shot: { primary: 'runway', failover: ['gemini'] },
};

export const FailoverSchema = z.enum(['off', 'on']);

/**
 * Whether failover providers are routed to. Read from the raw environment rather than the
 * validated `env` proxy, because reading the proxy validates every variable the app has and
 * this predicate runs in the pure-function harnesses too. A value other than off/on throws:
 * "true" silently meaning off is the shape of bug this repo keeps finding.
 */
export function failoverEnabled(raw: string | undefined = process.env.GENERATION_FAILOVER): boolean {
  const parsed = FailoverSchema.safeParse(raw ?? 'off');
  if (!parsed.success) throw new Error(`GENERATION_FAILOVER must be "off" or "on", got "${raw}".`);
  return parsed.data === 'on';
}

/**
 * THE routing predicate. Primary first, then failover when enabled. The estimator
 * (`recipeForRoute` → `estimateEpisode` / `fitToCap`) and the submitter (`enqueueGeneration`
 * writes `gen_jobs.provider` from the same recipe) both resolve through this one function,
 * so the provider a shot is priced against is the provider it is submitted to.
 */
export function providersForRoute(route: GeneratedRoute, opts: { failover?: boolean } = {}): string[] {
  const r = ROUTE_PROVIDERS[route];
  const failover = opts.failover ?? failoverEnabled();
  return failover ? [r.primary, ...r.failover] : [r.primary];
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

/**
 * A params key holding a character's locked reference frame as stored (`storage:<key>` or an
 * https URL). The dispatcher resolves it to a short-lived URL right before submit and never
 * persists the resolved URL — a presigned link in `gen_jobs.params` would outlive its use.
 */
export const REFERENCE_FRAME_PARAM = 'reference_frame';

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
  | {
      state: 'succeeded';
      outputUrl: string;
      downloadHeaders: Record<string, string>;
      /** What the vendor says it charged, when it says. Null / absent is "not told", never 0. */
      charged?: Charged | null;
    }
  | { state: 'failed'; code: DriverErrorCode; detail: string; retryAfterS: number | null; charged?: Charged | null };

/**
 * A vendor-reported charge, already in USD so core code never learns the vendor's unit price.
 * Becomes a `cost_ledger` reconcile row with `cost_source = 'measured'` (0032: "the vendor
 * told us").
 */
export interface Charged {
  quantity: number;
  unit: string;
  usd: number;
}

const chargedOf = (credits: number | null | undefined): Charged | null =>
  credits === null || credits === undefined ? null : { quantity: credits, unit: 'credit', usd: credits * CREDIT_USD };

const fail = (f: HttpFail) => ({
  ok: false as const,
  code: f.code,
  detail: f.detail,
  retryAfterS: f.retryAfterS,
});

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
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
      // One client for the vendor (runway.ts). Act-Two keeps its own body; everything else is
      // image/text-to-video, built and constrained in video-runway.ts.
      const call = { apiKey: input.credentials[RUNWAY_KEY_FIELD] ?? '', fetchImpl: f };
      const r = input.model === 'act_two' ? await submitPerformance(input.model, p, call) : await submitVideo(input.model, p, call);
      return r.ok
        ? { ok: true, requestId: r.taskId, pollRef: r.estimatedCredits === null ? {} : { estimated_credits: String(r.estimatedCredits) } }
        : r;
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
      const t = await readTask({ apiKey: input.credentials[RUNWAY_KEY_FIELD] ?? '', taskId: input.requestId, fetchImpl: f });
      if (t.state === 'succeeded') {
        return { state: 'succeeded', outputUrl: t.outputUrl, downloadHeaders: {}, charged: chargedOf(t.chargedCredits) };
      }
      if (t.state === 'failed') {
        return { state: 'failed', code: t.code, detail: t.detail, retryAfterS: t.retryAfterS, charged: chargedOf(t.chargedCredits) };
      }
      return t;
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
 * models, Runway reads the organisation (and its credit balance), fal has no free read so it
 * is reported unprobed.
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
    const r = await readCreditBalance(values[RUNWAY_KEY_FIELD] ?? '', fetchImpl);
    return r.ok ? { passed: true, detail: `Organisation read; ${r.credits} API credits.` } : { passed: false, detail: r.detail };
  }
  return null;
}
