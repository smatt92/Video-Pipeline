import type { Db } from '../db/server';
import { registerClient, type FetchDocument } from './clients';
import { REGISTER_PATH, TOKEN_PATH } from './policy';
import { OAuthError } from './errors';
import { exchangeToken } from './flow';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

/**
 * The OAuth endpoints that are plain HTTP, minus the framework — the same split as
 * `studio/serve.ts`. Each Next route under `src/app/.well-known` and `src/app/api/oauth` is
 * a three-line adapter over this, and `scripts/verify-oauth.mjs` puts this same function
 * behind a `node:http` server, so what the harness drives over a socket is what ships.
 *
 * The one endpoint not here is authorize: it is a page, because it needs a signed-in person
 * to look at it, and its logic is `checkAuthorize` + `decideConsent` in flow.ts.
 */

export interface OAuthHttpRequest {
  method: string;
  path: string;
  /** Scheme + host the request arrived on. The issuer and the resource derive from it. */
  origin: string;
  contentType: string | null;
  authorization: string | null;
  rawBody: string;
}

export interface OAuthHttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface OAuthDeps {
  db: Db;
  fetchDocument: FetchDocument;
}

// The connector calls these from a server, not a browser, so CORS is not what makes them
// work. It is what lets a browser-based MCP client (an inspector, a desktop shell) read the
// discovery documents, and none of these responses carries anything a cookie unlocks.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
};

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function json(status: number, body: unknown, extra: Record<string, string> = {}): OAuthHttpResponse {
  return { status, body, headers: { ...CORS, ...extra } };
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function formFrom(req: OAuthHttpRequest): URLSearchParams {
  if (req.contentType?.includes('application/json')) {
    try {
      const obj = JSON.parse(req.rawBody) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(obj).filter(([, v]) => typeof v === 'string') as [string, string][],
      );
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(req.rawBody);
}

export async function serveOAuth(req: OAuthHttpRequest, deps: OAuthDeps): Promise<OAuthHttpResponse> {
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return { status: 204, body: null, headers: CORS };

  try {
    if (under(req.path, '/.well-known/oauth-protected-resource')) {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return json(200, protectedResourceMetadata(req.origin));
    }
    if (under(req.path, '/.well-known/oauth-authorization-server')) {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return json(200, authorizationServerMetadata(req.origin));
    }
    if (req.path === REGISTER_PATH) {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
      let body: unknown;
      try {
        body = JSON.parse(req.rawBody);
      } catch {
        throw new OAuthError('invalid_client_metadata', 'registration_not_json', 'The registration body must be JSON.');
      }
      return json(201, await registerClient(deps.db, body), NO_STORE);
    }
    if (req.path === TOKEN_PATH) {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
      const token = await exchangeToken(deps.db, formFrom(req), req.authorization, req.origin);
      return json(200, token, NO_STORE);
    }
    return json(404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof OAuthError) return json(err.status, err.toJSON(), NO_STORE);
    console.error('[oauth] unexpected failure:', err);
    return json(500, { error: 'server_error', error_description: 'unexpected failure' }, NO_STORE);
  }
}
