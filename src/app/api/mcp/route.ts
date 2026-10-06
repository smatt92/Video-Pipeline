import { NextResponse, type NextRequest } from 'next/server';

import { productionEffects } from '@/lib/bureau/effects';
import { serverClient } from '@/lib/db/server';
import { resourceMetadataUrlFor } from '@/lib/oauth/policy';
import { serveMcp } from '@/lib/studio/serve';

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
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Body is not JSON.' } },
      { status: 400 },
    );
  }

  const db = serverClient();
  const result = await serveMcp(
    { authorization: request.headers.get('authorization'), body },
    {
      db,
      secret: process.env.STUDIO_MCP_TOKEN_SECRET,
      // Bound per request to the token's channel inside serveMcp; this is the factory.
      bureau: productionEffects(db),
      // Every 401 points a connector at the OAuth server (decision 0016). The origin is the
      // one the request arrived on, so a preview deployment advertises itself.
      resourceMetadataUrl: resourceMetadataUrlFor(request.nextUrl.origin),
    },
  );

  return result.body === null
    ? new NextResponse(null, { status: result.status })
    : NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

export function GET(request: NextRequest) {
  // Without a credential the answer is the same as POST's: a 401 naming where to get one. A
  // client that probes with GET before it POSTs must still be able to discover OAuth.
  if (!request.headers.get('authorization')) {
    return NextResponse.json(
      { error: 'unauthorized' },
      {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrlFor(request.nextUrl.origin)}"`,
        },
      },
    );
  }
  return NextResponse.json(
    {
      error: 'method_not_allowed',
      detail:
        'This server has no server-initiated messages, so it does not open an SSE stream. ' +
        'Send JSON-RPC over POST.',
    },
    { status: 405, headers: { allow: 'POST' } },
  );
}
