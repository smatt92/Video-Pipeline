import {
  HiggsfieldClient,
  AuthenticationError,
  CredentialsMissedError,
  NotEnoughCreditsError,
  ValidationError,
  BadInputError,
  TimeoutError,
} from '@higgsfield/client';

import { env } from '../env';
import type { DriverErrorCode } from './types';

/**
 * Submitting a generation. The half of the video driver that did not exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What was actually missing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `submitShots` was described everywhere as "the stage-5 submit path", and STATE.md
 * recorded that nothing called it. Both true, and both beside the point: reading it to give
 * it a caller showed that **it never called a vendor either**. It priced the work, wrote a
 * `cost_ledger` estimate, inserted a `generations` row with `status = 'queued'` and no
 * `external_job_id`, and marked the shot `generating`.
 *
 * Wiring a caller to that, unchanged, would have been worse than leaving it unreachable. It
 * would have produced ledger rows for calls that never happened, shots stuck in `generating`
 * for ever, and a webhook that could never match a delivery to a row because no row had a
 * job id. Every one of those states looks like a vendor problem from the outside.
 *
 * So this is the missing half, and the shape of the gap is worth recording: the function
 * was *complete for the part it owned* — pricing, idempotency, the cost row before the
 * submit, the concurrency pool, the character-reference refusal — which is exactly why
 * nothing flagged it. The category is not "unfinished". It is **"finished up to a boundary
 * that was never crossed"**, and no register catches that, because everything on this side
 * of the boundary is correct.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Webhook, never polling
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **`withPolling: false` is passed explicitly, because the SDK's default is `true`.**
 *
 * `options?.withPolling ?? true` — so omitting it, which is what "we don't poll" looks like
 * in the source, produces polling. The first version of this file left it off with a
 * comment saying that avoided polling, and the comment was the exact inverse of the
 * behaviour. The harness hung on its first real submit, which is how it was found; in
 * production it would have held a Trigger worker open for the length of a video generation
 * while hammering an undocumented rate limit that fails silently.
 *
 * This is CLAUDE.md rule 4 at its single most important site, and the lesson is narrower
 * than "read the docs": **an option whose default is the behaviour you are avoiding has to
 * be passed, not omitted.** Omission is not a position.
 *
 * The `webhook` option is what makes the completion arrive at `/api/webhooks/*` instead,
 * which is the path `verify:webhook` proves.
 *
 * The returned `JobSet.id` is the only thing this function keeps. It becomes
 * `generations.external_job_id`, and it is what the callback is matched on — so a submit
 * that returns no id is a failure even when the vendor accepted it, because a generation
 * nobody can match a callback to is a generation that will hang until it times out, after
 * the money was spent.
 */

export interface SubmitParams {
  readonly endpoint: string;
  readonly params: Record<string, unknown>;
  readonly apiKey: string;
  readonly apiSecret: string;
  /** The deployment's public origin. The route path is this module's business. */
  readonly webhookBaseUrl: string;
  readonly webhookSecret: string;
}

/**
 * Where this vendor's callbacks arrive.
 *
 * Here rather than at the call site, and `pnpm check:vendors` is why: the path contains the
 * vendor's name, so building it in `src/lib/generate/submit.ts` put a vendor name outside
 * the driver layer. The check caught it on the first run after the submit was wired.
 *
 * That is rule 1 working exactly as CLAUDE.md describes — "if a task seems to need a vendor
 * call elsewhere, the driver interface is wrong; fix the interface". The interface was
 * wrong: a caller should hand over an origin and know nothing about the route.
 */
export function callbackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/webhooks/higgsfield`;
}

export interface SubmitAccepted {
  readonly ok: true;
  /** The vendor's job-set id. Becomes `external_job_id`. */
  readonly jobId: string;
}

export interface SubmitRefused {
  readonly ok: false;
  readonly code: DriverErrorCode;
  readonly detail: string;
}

export type SubmitResult = SubmitAccepted | SubmitRefused;

/**
 * The vendor's error classes → this project's taxonomy.
 *
 * Mapped by class rather than by message, where the SDK gives a class. A message match is a
 * string comparison against text the vendor may reword in a patch release, and the cost of
 * getting it wrong is asymmetric: misreading `insufficient_credits` as `upstream` produces a
 * retry storm against an account that cannot pay for any of it.
 *
 * `content_rejected` has no class, because moderation refusal arrives as a *job status*
 * rather than a submit error — the submit succeeds and the job comes back NSFW. That path
 * is `fetchJobStatus` and the webhook, not this function.
 */
function classify(err: unknown): { code: DriverErrorCode; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);

  if (err instanceof AuthenticationError || err instanceof CredentialsMissedError) {
    return { code: 'auth', detail };
  }
  // Reached on a 403, not a 402 — the SDK's interceptor makes that mapping. See the note
  // by the status codes below.
  if (err instanceof NotEnoughCreditsError) return { code: 'insufficient_credits', detail };
  if (err instanceof ValidationError || err instanceof BadInputError) {
    return { code: 'invalid_input', detail };
  }
  if (err instanceof TimeoutError) return { code: 'timeout', detail };

  // Status codes, for everything the SDK does not model as a class.
  //
  // `statusCode`, and that spelling is the whole of it. The SDK's interceptor converts
  // every unmapped response into `APIError(message, statusCode, responseData)` — not an
  // axios error — so `err.status` and `err.response.status` are both undefined and a 402
  // came out as `unknown`. Found by the harness returning 402 through the real client;
  // reading the SDK's source is the only way to know, because none of it is typed.
  const status =
    (err as { statusCode?: number })?.statusCode ??
    (err as { status?: number })?.status ??
    (err as { response?: { status?: number } })?.response?.status;

  // 401 only. **This vendor signals "out of credits" with 403**, which the SDK maps to
  // NotEnoughCreditsError above — so by the time a bare 403 reaches here it is not an auth
  // failure, and calling it one would send someone to re-check a credential that is fine
  // while the account is empty.
  if (status === 401) return { code: 'auth', detail };
  if (status === 402) return { code: 'insufficient_credits', detail };
  if (status === 404) return { code: 'not_found', detail };
  if (status === 409) return { code: 'concurrency_limited', detail };
  if (status === 429) {
    // The two are genuinely different — one wants backoff, the other wants a queue — and
    // the vendor signals both with 429. A header is the only distinguishing evidence
    // available, and when it is absent the safer read is the one that does not retry-storm.
    const headers = (err as { response?: { headers?: Record<string, string> } })?.response
      ?.headers;
    const concurrency = headers?.['x-concurrency-limit'] ?? headers?.['x-concurrent-requests'];
    return { code: concurrency ? 'concurrency_limited' : 'rate_limited', detail };
  }
  if (typeof status === 'number' && status >= 500) return { code: 'upstream', detail };

  return { code: 'unknown', detail };
}

export async function submitGeneration(p: SubmitParams): Promise<SubmitResult> {
  const client = new HiggsfieldClient({
    apiKey: p.apiKey,
    apiSecret: p.apiSecret,
    // `baseURL`, capital URL — the SDK's spelling. A `baseUrl` key is silently ignored and
    // the client quietly talks to the default host, which in a harness means a test that
    // passes by contacting production.
    baseURL: env.HIGGSFIELD_API_BASE_URL,
  });

  try {
    const jobSet = await client.generate(p.endpoint, p.params, {
      // Explicit, not omitted. The SDK defaults this to true — see the note above.
      withPolling: false,
      webhook: { url: callbackUrl(p.webhookBaseUrl), secret: p.webhookSecret },
    });

    if (!jobSet?.id) {
      return {
        ok: false,
        code: 'upstream',
        detail:
          'the vendor accepted the submit and returned no job id. Nothing can match the ' +
          'callback to a row, so this is a failure even though it looks like a success.',
      };
    }

    return { ok: true, jobId: jobSet.id };
  } catch (err) {
    return { ok: false, ...classify(err) };
  } finally {
    client.close();
  }
}
