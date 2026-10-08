import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';

import { productionEffects } from '../bureau/effects';
import { serverClient } from '../db/server';
import { requireCredential } from '../integrations/credentials';
import { originFromHeaders, resourceMetadataUrlFor, type McpDoor } from '../oauth/policy';
import { serveMcp } from './serve';

/**
 * NextRequest → `serveMcp` → NextResponse, for both doors (/api/mcp and /api/mcp/agent).
 *
 * The only framework code in the MCP server, and kept out of tsconfig.verify.json for that
 * reason — the same split as `oauth/next-adapter.ts`. The two route files are three lines
 * each over this, so the doors differ in exactly one argument and cannot drift apart in
 * how they parse a body, which origin they advertise, or what a GET answers.
 */

function metadataUrl(request: NextRequest, door: McpDoor): string {
  // Read from the headers, never `nextUrl.origin`, which `next start` reports as localhost
  // whatever the Host was; the consent page can only read headers, and the two must agree.
  return resourceMetadataUrlFor(originFromHeaders((n) => request.headers.get(n)), door);
}

export async function mcpPost(request: NextRequest, door: McpDoor): Promise<NextResponse> {
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
      // Every 401 points a connector at this door's OAuth server (decisions 0016, 0018).
      resourceMetadataUrl: metadataUrl(request, door),
      door,
      // The Studio tools' writer and judge: the workspace's verified model credential.
      studioLlm: async (d) => {
        const apiKey = await requireCredential(d, 'anthropic', 'ANTHROPIC_API_KEY').catch(() => null);
        return apiKey ? { apiKey } : null;
      },
      appUrl: originFromHeaders((n) => request.headers.get(n)),
    },
  );

  return result.body === null
    ? new NextResponse(null, { status: result.status })
    : NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

export function mcpGet(request: NextRequest, door: McpDoor): NextResponse {
  // Without a credential the answer is the same as POST's: a 401 naming where to get one. A
  // client that probes with GET before it POSTs must still be able to discover OAuth.
  if (!request.headers.get('authorization')) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl(request, door)}"` } },
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
