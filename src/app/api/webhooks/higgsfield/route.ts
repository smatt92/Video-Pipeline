import { NextResponse, type NextRequest } from 'next/server';

import { serverClient } from '@/lib/db/server';
import { expectedWebhookSecret, WEBHOOK_SECRET_HEADER } from '@/lib/drivers/video-status';
import { handleCallback } from '@/lib/generate/webhook';

/**
 * The generation callback — the HTTP adapter, and nothing else.
 *
 * Every decision this endpoint makes lives in `src/lib/generate/webhook.ts`: the
 * constant-time secret comparison, the rule that the body is never trusted beyond a job
 * id, the delivery record, the confirmation, and the 202-on-failure. Read that file for
 * why each one is what it is.
 *
 * The split is not tidiness. A route file can only be reached by starting Next and builds
 * its own database client from module scope, which is why 0008 §5b could prove the SQL
 * under this endpoint and nothing above it. `handleCallback` takes its database and its
 * request as arguments, so `pnpm verify:webhook` drives the same code over real HTTP
 * against real Postgres. Same shape as `serveMcp` behind `/api/mcp`, for the same reason.
 *
 * ── Never redirected, never gated ────────────────────────────────────────────
 *
 * `/api/webhooks/*` is in the middleware's PUBLIC_PATHS. A 307 to an HTML sign-in page is a
 * delivery most vendors will not retry, and the generation it was reporting then hangs
 * until it times out — after the money was spent.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const result = await handleCallback(serverClient(), expectedWebhookSecret(), {
    presentedSecret: request.headers.get(WEBHOOK_SECRET_HEADER),
    rawBody: await request.text(),
  });

  return NextResponse.json(result.body, { status: result.status });
}
