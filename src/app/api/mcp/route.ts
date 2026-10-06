import { type NextRequest } from 'next/server';

import { mcpGet, mcpPost } from '@/lib/studio/next-route';

/**
 * Kiln's own MCP server.
 *
 * Addendum 01 §2 argues for this over pointing Opus 5 at a vendor's hosted MCP, and the
 * argument is about rows rather than about protocols: a generation made through a vendor's
 * MCP server lands in the vendor's account and writes nothing here — no `generations` row,
 * no `cost_ledger` row, no idempotency key — so the review screen cannot see it and the
 * cost dashboard is blind to it. Wrapping our own driver costs the same day of work and
 * every row gets written.
 *
 * ── A thin adapter, on purpose ───────────────────────────────────────────────
 *
 * Everything below the framework lives in `src/lib/studio/serve.ts`: authentication, the
 * session-active check, the protocol dispatch. This file turns a `NextRequest` into a
 * plain object and a plain object into a `NextResponse`, and that is all it does — so
 * `scripts/verify-studio.mjs` can drive the *same* handler over a real HTTP server without
 * standing up Next, and the thing it verifies is the thing that ships.
 *
 * ── Streamable HTTP, POST only ───────────────────────────────────────────────
 *
 * The transport permits a GET that opens an SSE stream for server-initiated messages. This
 * server has none to send: it holds no state between calls, and its tool set is compiled
 * in, so there is no `listChanged` to notify. GET therefore answers 405 with the reason
 * rather than opening a stream that would never emit — a client waiting on a silent stream
 * looks exactly like a server that has hung.
 *
 * ── What this route does not do ──────────────────────────────────────────────
 *
 * No media, ever. The tools return ids, statuses and URLs; bytes move browser↔bucket by
 * presigned URL and worker↔bucket directly (rule 2). `stitch_rough_cut` queues a Trigger
 * task rather than running ffmpeg, because ffmpeg does not exist here and would not fit in
 * the time limit if it did (rule 3).
 *
 * ── Two doors ────────────────────────────────────────────────────────────────
 *
 * This is the owner door: approver or agent tokens, the Studio's session tokens, OAuth with
 * an approver default. `/api/mcp/agent` is the same server for agent tokens only, so the
 * scheduled automations can hold a connector that can never approve (decision 0018). The
 * framework glue for both is `src/lib/studio/next-route.ts`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return mcpPost(request, 'owner');
}

export function GET(request: NextRequest) {
  return mcpGet(request, 'owner');
}
