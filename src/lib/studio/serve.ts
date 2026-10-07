import 'server-only';

import type { Db } from '../db/server';
import { dispatch, PROTOCOL_VERSION, studioSurface, type McpSurface } from './mcp';
import { bearerFrom, verifySessionToken } from './token';
import { bureauSurface, loadTokenChannel, NO_EFFECTS, type BureauSideEffects } from '../bureau/mcp/surface';
import { isBureauToken, resolveBureauToken } from '../bureau/tokens';

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
  /** `STUDIO_MCP_TOKEN_SECRET`. Absent means this deployment cannot authenticate a Studio
   *  session. Bureau tokens do not use it — they are looked up by hash. */
  secret: string | undefined;
  /** The Bureau control plane's side effects (start an episode run, wake a cut gate). */
  bureau?: BureauSideEffects;
  /**
   * RFC 9728 protected-resource metadata URL. When set, every 401 carries
   * `WWW-Authenticate: Bearer resource_metadata="…"` — the header a Claude connector reads
   * to discover the OAuth server (decision 0016). Absent, a 401 is a bare refusal, as before.
   */
  resourceMetadataUrl?: string;
  /**
   * `agent` for /api/mcp/agent: Bureau tokens of agent scope only (static or OAuth), nothing
   * else. Absent, or `owner`, is /api/mcp, unchanged. Decision 0018.
   */
  door?: 'owner' | 'agent';
}

/** Deliberately uninformative: a caller who guessed wrong learns nothing about how wrong. */
const REFUSED = { error: 'unauthorized' };

/**
 * A 401, with the discovery header when this deployment advertises OAuth.
 *
 * `error="invalid_token"` only when a token was presented (RFC 6750 §3.1): a request with no
 * credential is told where to get one, and a request with a dead one is told it is dead —
 * which is what makes a connector refresh rather than start the whole consent again.
 */
function unauthorized(deps: McpDeps, presented: boolean): McpResponse {
  if (!deps.resourceMetadataUrl) return { status: 401, body: REFUSED };
  const parts = [`resource_metadata="${deps.resourceMetadataUrl}"`];
  if (presented) parts.push('error="invalid_token"');
  return { status: 401, body: REFUSED, headers: { 'www-authenticate': `Bearer ${parts.join(', ')}` } };
}

export async function serveMcp(request: McpRequest, deps: McpDeps): Promise<McpResponse> {
  const bearer = bearerFrom(request.authorization);

  // ── The Bureau control plane ─────────────────────────────────────────────
  // A different token family (`kb_…`, hashed in mcp_tokens), a different tool registry, and
  // scope enforced inside every tool and again in the database. Routed first because it
  // needs no HMAC secret: a deployment without STUDIO_MCP_TOKEN_SECRET can still serve it.
  if (bearer && isBureauToken(bearer)) {
    const resolved = await resolveBureauToken(deps.db, bearer);
    if (!resolved.ok) {
      return resolved.reason === 'lookup_failed'
        ? { status: 503, body: { error: 'token lookup failed', detail: resolved.detail } }
        : unauthorized(deps, true);
    }
    // The agent door serves agent connections and nothing else. An approver token here is
    // refused before any tool runs — not left to the per-tool scope check, which would let it
    // *read* through a URL whose whole promise is that nothing on it holds approver.
    // 403 rather than 401: the token is valid, and a connector told invalid_token would
    // refresh and present the same approver token again.
    if (deps.door === 'agent' && resolved.token.scope !== 'agent') {
      return {
        status: 403,
        body: {
          error: 'approver_not_allowed_here',
          detail:
            'This endpoint (/api/mcp/agent) accepts agent-scoped tokens only. Approver ' +
            'connections and tokens use /api/mcp.',
        },
      };
    }
    const channel = await loadTokenChannel(deps.db, resolved.token.channelId);
    const surface = bureauSurface({ db: deps.db, token: resolved.token, effects: deps.bureau ?? NO_EFFECTS, channel });
    return answer(request.body, surface);
  }

  // No credential at all is the same answer whatever is configured.
  if (!bearer) return unauthorized(deps, false);

  // Studio session tokens belong to /api/mcp. The agent door is the Bureau's only.
  if (deps.door === 'agent') return unauthorized(deps, true);

  // An OAuth refresh token (decision 0016) is never a bearer. Said as invalid_token rather
  // than falling through to the Studio check, where a deployment without the HMAC secret
  // would answer 503 — which a connector reads as "server down", not "use the other token".
  if (bearer.startsWith('kbr_')) return unauthorized(deps, true);

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

  const check = verifySessionToken(bearer, secret);
  if (!check.ok) return unauthorized(deps, true);

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
  if (!session) return unauthorized(deps, true);

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

  return answer(request.body, studioSurface(ctx));
}

async function answer(body: unknown, surface: McpSurface): Promise<McpResponse> {
  const headers = { 'mcp-protocol-version': PROTOCOL_VERSION };

  // A batch is an array. Notifications inside one produce no response, and a batch that is
  // all notifications produces no body at all — which is why this filters rather than maps.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => dispatch(m, surface)))).filter(
      (r) => r !== null,
    );
    return responses.length === 0
      ? { status: 202, body: null }
      : { status: 200, body: responses, headers };
  }

  const response = await dispatch(body, surface);
  return response === null
    ? { status: 202, body: null }
    : { status: 200, body: response, headers };
}
