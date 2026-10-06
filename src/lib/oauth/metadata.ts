import {
  AUTHORIZE_PATH,
  OAUTH_SCOPES,
  REGISTER_PATH,
  TOKEN_PATH,
  resourceFor,
} from './policy';

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
 */

function trim(origin: string): string {
  return origin.replace(/\/$/, '');
}

/** RFC 9728. */
export function protectedResourceMetadata(origin: string) {
  const o = trim(origin);
  return {
    resource: resourceFor(o),
    authorization_servers: [o],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Kiln',
    resource_documentation: `${o}/about`,
  };
}

/** RFC 8414, with the MCP spec's additions (PKCE S256 only; metadata-document clients). */
export function authorizationServerMetadata(origin: string) {
  const o = trim(origin);
  return {
    issuer: o,
    authorization_endpoint: `${o}${AUTHORIZE_PATH}`,
    token_endpoint: `${o}${TOKEN_PATH}`,
    registration_endpoint: `${o}${REGISTER_PATH}`,
    scopes_supported: [...OAUTH_SCOPES],
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
