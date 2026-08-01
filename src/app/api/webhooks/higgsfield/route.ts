import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { expectedWebhookSecret, WEBHOOK_SECRET_HEADER } from '@/lib/drivers/video-status';
import { confirmAndIngest } from '@/lib/generate/confirm';

/**
 * The generation callback.
 *
 * ── This endpoint cannot verify a signature, because there is not one ────────
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
 *
 * ── Never redirected, never gated ────────────────────────────────────────────
 *
 * `/api/webhooks/*` is in the middleware's PUBLIC_PATHS. A 307 to an HTML sign-in page is a
 * delivery most vendors will not retry, and the generation it was reporting then hangs
 * until it times out — after the money was spent.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only the job identifier is read from the body. Nothing else is believed. */
const CallbackSchema = z.object({
  id: z.string().min(1).optional(),
  job_set_id: z.string().min(1).optional(),
  jobSetId: z.string().min(1).optional(),
});

function secretMatches(presented: string | null, expected: string): boolean {
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

export async function POST(request: NextRequest) {
  const expected = expectedWebhookSecret();

  if (!expected) {
    // Refusing is the only safe answer. Accepting unauthenticated callbacks because the
    // secret is unset would make the deployment's security depend on nobody finding the URL.
    console.error('[webhook] the shared secret is not configured; refusing all callbacks.');
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }

  if (!secretMatches(request.headers.get(WEBHOOK_SECRET_HEADER), expected)) {
    // Deliberately uninformative. A caller who guessed wrong learns nothing about how wrong.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const parsed = CallbackSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'unrecognised payload' }, { status: 400 });
  }

  const jobId = parsed.data.id ?? parsed.data.job_set_id ?? parsed.data.jobSetId;
  if (!jobId) {
    return NextResponse.json({ error: 'no job identifier' }, { status: 400 });
  }

  const db = serverClient();

  // Record that a callback arrived, separately from whether it was true. Both matter: a
  // job that got a callback and no confirmation is a different problem from one that got
  // neither.
  await db
    .from('generations')
    .update({ webhook_received_at: new Date().toISOString() })
    .eq('external_job_id', jobId);

  // 202, not 200, and returned by the caller below only after the confirmation runs. The
  // vendor is told the callback was accepted; whether the outcome was good is not its
  // business and a non-2xx would make it retry a delivery that was fine.
  try {
    const result = await confirmAndIngest(db, jobId);
    return NextResponse.json({ accepted: true, outcome: result.outcome }, { status: 202 });
  } catch (err) {
    // A failure here must not tell the vendor to retry forever. The generation row records
    // the problem; a 202 stops the redelivery loop and leaves a human to look.
    console.error('[webhook] confirmation failed', { jobId, err });
    return NextResponse.json({ accepted: true, outcome: 'confirmation_failed' }, { status: 202 });
  }
}
