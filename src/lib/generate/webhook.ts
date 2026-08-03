import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import type { Db } from '../db/server';
import { confirmAndIngest } from './confirm';

/**
 * The generation callback, as a function of its inputs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this is not in the route
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The route file is a Next.js entry point: it can only be reached by starting Next, and it
 * builds its own database client from module scope. That combination is why 0008 §5b could
 * say the SQL underneath this endpoint had been proven against real Postgres while
 * *everything above the SQL* — the RPC call shape, the `Array.isArray` unwrap, whether a
 * scalar boolean arrives as `data === true` — was read off the generated types and never
 * observed.
 *
 * The same shape as `serveMcp`, and the same fix: the logic takes its database and its
 * request as arguments, the route becomes an adapter, and a harness drives *this* over real
 * HTTP against a real Postgres. Production and the harness then run the same code, which is
 * the only arrangement where a green harness means anything.
 *
 * Nothing here is test-only. The route is genuinely thinner for it, and the dependency on
 * `next/server` now stops at the file that has to have it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This endpoint cannot verify a signature, because there is not one
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ADR 0004: the vendor does not HMAC-sign webhook bodies. It echoes back a shared secret in
 * a header. So there is nothing cryptographic to check — only a bearer token to compare,
 * and anyone who obtains it can forge a completion for any job id they can guess.
 *
 * Two consequences, both structural:
 *
 *   The comparison is constant-time. A byte-by-byte early return leaks the secret to
 *   anyone patient enough to measure, and the secret is the whole of the authentication.
 *
 *   **The body is never trusted.** A valid secret gets the caller as far as "tell me which
 *   job you are talking about". Everything else — did it succeed, where is the file — is
 *   read from the vendor's own status endpoint, at a URL this code constructs from the
 *   stored `external_job_id` and the configured base URL. Never from the payload. A
 *   `status_url` taken from the request body would let a forged callback point the
 *   confirmation at a host the attacker controls, which turns the confirmation step into
 *   theatre.
 *
 * That is the difference between a pipeline that can be lied to and one that cannot. A
 * forged callback with the right secret can, at worst, cause a redundant status fetch.
 */

/** Only the job identifier is read from the body. Nothing else is believed. */
const CallbackSchema = z.object({
  id: z.string().min(1).optional(),
  job_set_id: z.string().min(1).optional(),
  jobSetId: z.string().min(1).optional(),
});

export function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which would itself be a timing signal.
  // Comparing a fixed-width digest of each keeps the comparison constant-time regardless
  // of what length the caller supplied.
  if (a.length !== b.length) {
    const pad = Buffer.alloc(64);
    const other = Buffer.alloc(64);
    a.copy(pad, 0, 0, Math.min(a.length, 64));
    b.copy(other, 0, 0, Math.min(b.length, 64));
    timingSafeEqual(pad, other);
    return false;
  }

  return timingSafeEqual(a, b);
}

export interface CallbackRequest {
  /** The value of the shared-secret header, or null if absent. */
  presentedSecret: string | null;
  /** The raw body. Parsed here so a malformed body is this function's problem. */
  rawBody: string;
}

export interface CallbackResponse {
  status: number;
  body: Record<string, unknown>;
}

export async function handleCallback(
  db: Db,
  expected: string | null,
  request: CallbackRequest,
): Promise<CallbackResponse> {
  if (!expected) {
    // Refusing is the only safe answer. Accepting unauthenticated callbacks because the
    // secret is unset would make the deployment's security depend on nobody finding the URL.
    console.error('[webhook] the shared secret is not configured; refusing all callbacks.');
    return { status: 503, body: { error: 'not configured' } };
  }

  if (!secretMatches(request.presentedSecret, expected)) {
    // Deliberately uninformative. A caller who guessed wrong learns nothing about how wrong.
    return { status: 401, body: { error: 'unauthorized' } };
  }

  let json: unknown = null;
  try {
    json = JSON.parse(request.rawBody);
  } catch {
    json = null;
  }

  const parsed = CallbackSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 400, body: { error: 'unrecognised payload' } };
  }

  const jobId = parsed.data.id ?? parsed.data.job_set_id ?? parsed.data.jobSetId;
  if (!jobId) {
    return { status: 400, body: { error: 'no job identifier' } };
  }

  // Record that a callback arrived, separately from whether it was true. Both matter: a
  // job that got a callback and no confirmation is a different problem from one that got
  // neither.
  //
  // One atomic statement (0015) rather than a read and a write. Two simultaneous
  // deliveries are exactly the case this is here to observe, so the observer cannot have
  // its own race — both would read the same count and write the same number, and a replay
  // would go unrecorded.
  const { data: delivery } = await db.rpc('record_webhook_delivery', { p_job_id: jobId });
  const record = Array.isArray(delivery) ? delivery[0] : delivery;

  if (record && record.deliveries > 1) {
    // Harmless by construction — `confirm_generation_once` refuses the second settlement —
    // but never silent. A vendor retry after a timeout is the ordinary cause. A replay of a
    // delivery somebody captured looks identical from here, and means the shared secret is
    // no longer shared with only us. `v_replayed_callbacks` is where this is read back.
    console.warn('[webhook] repeat delivery', {
      jobId,
      deliveries: record.deliveries,
      alreadyConfirmed: record.already_confirmed,
    });
  }

  // 202, not 200. The vendor is told the callback was accepted; whether the outcome was
  // good is not its business, and a non-2xx would make it retry a delivery that was fine.
  try {
    const result = await confirmAndIngest(db, jobId);
    return { status: 202, body: { accepted: true, outcome: result.outcome } };
  } catch (err) {
    // A failure here must not tell the vendor to retry forever. The generation row records
    // the problem; a 202 stops the redelivery loop and leaves a human to look.
    console.error('[webhook] confirmation failed', { jobId, err });
    return { status: 202, body: { accepted: true, outcome: 'confirmation_failed' } };
  }
}
