import { DOORS, REGISTER_PATH, issuerFor, resourceFor, type McpDoor } from './policy';

/**
 * The two discovery documents the MCP authorization spec has a client read.
 *
 * Order of discovery, as a connector does it: POST /api/mcp with no token → 401 whose
 * WWW-Authenticate names the protected-resource metadata URL → that document names this
 * origin as the authorization server → RFC 8414 metadata at
 * /.well-known/oauth-authorization-server → authorize, token, register.
 *
 * Kiln is its own authorization server, so `issuer` is the bare origin and every endpoint
 * is on it. Nothing here is per-request except the origin, which comes from the request
 * that asked: a preview deployment is its own issuer, and a token it issues is bound to
 * its own /api/mcp and is useless anywhere else.
 *
 * Two doors since the agent connector (see `DOORS` in policy.ts): each document is per door,
 * and the agent door's names only the agent scope, its own issuer and its own endpoints.
 * Registration is shared — a client is a client whichever door it is connecting through.
 */

function trim(origin: string): string {
  return origin.replace(/\/$/, '');
}

/** RFC 9728. */
export function protectedResourceMetadata(origin: string, door: McpDoor = 'owner') {
  const o = trim(origin);
  return {
    resource: resourceFor(o, door),
    authorization_servers: [issuerFor(o, door)],
    scopes_supported: [...DOORS[door].scopes],
    bearer_methods_supported: ['header'],
    resource_name: door === 'agent' ? 'Kiln — agent connector' : 'Kiln',
    resource_documentation: `${o}/about`,
  };
}

/** RFC 8414, with the MCP spec's additions (PKCE S256 only; metadata-document clients). */
export function authorizationServerMetadata(origin: string, door: McpDoor = 'owner') {
  const o = trim(origin);
  return {
    issuer: issuerFor(o, door),
    authorization_endpoint: `${o}${DOORS[door].authorizePath}`,
    token_endpoint: `${o}${DOORS[door].tokenPath}`,
    registration_endpoint: `${o}${REGISTER_PATH}`,
    scopes_supported: [...DOORS[door].scopes],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Public clients only: PKCE carries the proof a client secret would, and a secret
    // stored by a connector in somebody else's infrastructure adds a thing to leak and
    // nothing to check.
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/about`,
  };
}
