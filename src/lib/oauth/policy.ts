/**
 * The fixed facts of Kiln's OAuth server for /api/mcp. Decision 0016 is the reasoning.
 *
 * Constants rather than environment variables on purpose. Every value here is a security
 * boundary, and a boundary that can be widened by a dashboard edit is one that will be
 * widened during a debugging session and never narrowed again. Changing one is a commit,
 * which is reviewable and which CI runs the OAuth harness against.
 */

/**
 * Where an authorization code may be sent. Claude's connector callback, on both of the
 * hosts Claude serves from. Anything else is refused with `redirect_uri_not_allowed`, by
 * name, before any redirect happens — an unvalidated redirect_uri is how a code ends up at
 * an attacker, and the error must never itself be delivered to the URI being refused.
 *
 * Claude Code is deliberately absent: it reaches Kiln with a static kb_ token through
 * `--header`, and its OAuth callback is a localhost port that would make this list mean
 * "any program on any machine".
 */
export const ALLOWED_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

/**
 * Hosts whose Client ID Metadata Documents are accepted. A metadata-document client_id is
 * an https URL the client controls; fetching an arbitrary one would make the authorize
 * endpoint an open request-forgery relay, so only Claude's own hosts are dialled. The
 * redirect URI check above still applies to whatever the document lists.
 */
export const ALLOWED_METADATA_HOSTS: readonly string[] = ['claude.ai', 'claude.com'];

/** Access tokens are short so revocation does not depend on revocation alone. */
export const ACCESS_TOKEN_TTL_S = 60 * 60;

/** Sliding: every refresh issues a new one with a fresh lifetime. */
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;

/** Long enough for a redirect and one token request, short enough to be useless when stolen. */
export const AUTH_CODE_TTL_S = 120;

/** The two scopes, which are mcp_tokens.scope — the same rules, enforced in the same places. */
export const OAUTH_SCOPES = ['approver', 'agent'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** Consent preselects this. Sahil approving from his phone is the reason this server exists. */
export const DEFAULT_SCOPE: OAuthScope = 'approver';

/** The MCP endpoint, relative to the origin. The resource every token is bound to. */
export const MCP_PATH = '/api/mcp';

export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/api/oauth/token';
export const REGISTER_PATH = '/api/oauth/register';

export function resourceFor(origin: string): string {
  return `${origin.replace(/\/$/, '')}${MCP_PATH}`;
}

/** RFC 9728 §3.1: the metadata URL for a resource with a path inserts the path after the well-known name. */
export function resourceMetadataUrlFor(origin: string): string {
  return `${origin.replace(/\/$/, '')}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/**
 * The origin a page request arrived on, from its headers. Route handlers have
 * `request.nextUrl.origin`; a page and a Server Action have only headers, and the consent
 * screen must compute the same issuer and resource the token endpoint will.
 */
export function originFromHeaders(get: (name: string) => string | null): string {
  const host = get('x-forwarded-host') ?? get('host');
  if (!host) throw new Error('No host header; cannot tell which server this is.');
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = get('x-forwarded-proto')?.split(',')[0]?.trim() ?? (local ? 'http' : 'https');
  return `${proto}://${host}`;
}
