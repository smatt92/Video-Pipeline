import 'server-only';

import type { Db } from '../db/server';
import { dispatch, PROTOCOL_VERSION } from './mcp';
import { bearerFrom, verifySessionToken } from './token';

/**
 * The MCP server, minus the framework.
 *
 * `src/app/api/mcp/route.ts` is the Next adapter over this; `scripts/verify-studio.mjs`
 * puts it behind a plain `node:http` server and drives it with real requests. Same
 * function, two transports — the pattern the ingest and assembly harnesses already use,
 * and the reason those found real bugs instead of confirming a copy of themselves.
 *
 * Everything security-relevant is here rather than in the route: the token check, the
 * session-active check, and the shape of a refusal. A route that owned any of those would
 * have exactly one caller and would therefore never be exercised by anything.
 */

export interface McpRequest {
  authorization: string | null;
  /** Already parsed. The adapter owns turning a stream into JSON and reporting a bad one. */
  body: unknown;
}

export interface McpResponse {
  status: number;
  /** `null` means an empty body — a notification, answered 202. */
  body: unknown;
  headers?: Record<string, string>;
}

export interface McpDeps {
  db: Db;
  /** `STUDIO_MCP_TOKEN_SECRET`. Absent means this deployment cannot authenticate anyone. */
  secret: string | undefined;
}

/** Deliberately uninformative: a caller who guessed wrong learns nothing about how wrong. */
const REFUSED = { error: 'unauthorized' };

export async function serveMcp(request: McpRequest, deps: McpDeps): Promise<McpResponse> {
  const secret = deps.secret?.trim();

  if (!secret) {
    // Refusing is the only safe answer. Accepting tool calls because the key is unset would
    // make the security of a publicly reachable endpoint that writes rows depend on nobody
    // finding the URL.
    console.error('[mcp] STUDIO_MCP_TOKEN_SECRET is not set; refusing all tool calls.');
    return {
      status: 503,
      body: { error: 'not configured', detail: 'This deployment cannot authenticate MCP callers.' },
    };
  }

  const check = verifySessionToken(bearerFrom(request.authorization), secret);
  if (!check.ok) return { status: 401, body: REFUSED };

  // The signature proves the token was minted here. It does not prove the session may still
  // spend money — a capped or archived session's token is still validly signed, and this is
  // the revocation the token itself cannot carry.
  const { data: session, error } = await deps.db
    .from('studio_sessions')
    .select('id, status, spend_cap_inr, stopped_reason')
    .eq('id', check.sessionId)
    .maybeSingle();

  if (error) return { status: 503, body: { error: 'session lookup failed', detail: error.message } };

  // Not 404, and not a distinct message: from outside, a session that never existed and one
  // this token may not touch are the same answer.
  if (!session) return { status: 401, body: REFUSED };

  if (session.status !== 'active') {
    // 403, and here the reason *is* given — this caller authenticated, so telling it the
    // session stopped is telling it something it is entitled to know. It is the difference
    // between the model reporting "the session hit its cap" and the model retrying until
    // something else breaks.
    return {
      status: 403,
      body: {
        error: 'session_not_active',
        status: session.status,
        detail:
          session.stopped_reason ?? `This session is ${session.status} and its tools no longer run.`,
      },
    };
  }

  const ctx = {
    db: deps.db,
    sessionId: session.id,
    spendCapInr: session.spend_cap_inr === null ? null : Number(session.spend_cap_inr),
  };

  const headers = { 'mcp-protocol-version': PROTOCOL_VERSION };

  // A batch is an array. Notifications inside one produce no response, and a batch that is
  // all notifications produces no body at all — which is why this filters rather than maps.
  if (Array.isArray(request.body)) {
    const responses = (await Promise.all(request.body.map((m) => dispatch(m, ctx)))).filter(
      (r) => r !== null,
    );
    return responses.length === 0
      ? { status: 202, body: null }
      : { status: 200, body: responses, headers };
  }

  const response = await dispatch(request.body, ctx);
  return response === null
    ? { status: 202, body: null }
    : { status: 200, body: response, headers };
}
