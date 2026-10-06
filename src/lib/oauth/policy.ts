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

/**
 * Two doors onto one MCP server (decision 0016, addendum 0018).
 *
 * A Claude connector is visible to every scheduled task on the account, and Claude offers
 * one connection per connector URL. So a single URL cannot carry Sahil's approver
 * connection for his phone *and* an agent connection for the automations: whichever was
 * made last is what every scheduled task holds. The fix is a second URL whose OAuth server
 * can only ever issue agent connections.
 *
 * Each door is its own protected resource, with its own authorization-server issuer and
 * endpoints. That is deliberate rather than tidy: the agent door's refusal must not depend
 * on a connector sending the RFC 8707 `resource` parameter. A client that omits it still
 * walks the agent door's metadata to the agent door's authorize page and token endpoint,
 * and neither of those can mint approver.
 *
 *   owner  /api/mcp        issuer = origin           approver (default) or agent
 *   agent  /api/mcp/agent  issuer = origin/oauth/agent  agent, fixed
 *
 * Everything else — clients, registration, the token rows, revocation, scope enforcement in
 * TypeScript and in the database — is shared.
 */
export const MCP_DOORS = ['owner', 'agent'] as const;
export type McpDoor = (typeof MCP_DOORS)[number];

export interface DoorPolicy {
  /** The MCP endpoint, relative to the origin. The resource every token from this door is bound to. */
  readonly mcpPath: string;
  /** Appended to the origin to make the issuer. Empty for the owner door: the bare origin. */
  readonly issuerPath: string;
  readonly authorizePath: string;
  readonly tokenPath: string;
  /** What this door's consent screen may grant and its token endpoint may mint. */
  readonly scopes: readonly OAuthScope[];
  readonly defaultScope: OAuthScope;
}

export const DOORS: Readonly<Record<McpDoor, DoorPolicy>> = {
  owner: {
    mcpPath: '/api/mcp',
    issuerPath: '',
    authorizePath: '/oauth/authorize',
    tokenPath: '/api/oauth/token',
    scopes: OAUTH_SCOPES,
    defaultScope: DEFAULT_SCOPE,
  },
  agent: {
    mcpPath: '/api/mcp/agent',
    issuerPath: '/oauth/agent',
    authorizePath: '/oauth/agent/authorize',
    tokenPath: '/api/oauth/agent/token',
    scopes: ['agent'],
    defaultScope: 'agent',
  },
};

/** The owner door's paths, under the names every caller before the agent door used. */
export const MCP_PATH = DOORS.owner.mcpPath;
export const AUTHORIZE_PATH = DOORS.owner.authorizePath;
export const TOKEN_PATH = DOORS.owner.tokenPath;
export const REGISTER_PATH = '/api/oauth/register';

function trimOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

export function resourceFor(origin: string, door: McpDoor = 'owner'): string {
  return `${trimOrigin(origin)}${DOORS[door].mcpPath}`;
}

export function issuerFor(origin: string, door: McpDoor = 'owner'): string {
  return `${trimOrigin(origin)}${DOORS[door].issuerPath}`;
}

/** RFC 9728 §3.1: the metadata URL for a resource with a path inserts the path after the well-known name. */
export function resourceMetadataUrlFor(origin: string, door: McpDoor = 'owner'): string {
  return `${trimOrigin(origin)}/.well-known/oauth-protected-resource${DOORS[door].mcpPath}`;
}

/** RFC 8414 §3.1: the same insertion for an issuer with a path. The owner door's has none. */
export function authorizationServerMetadataUrlFor(origin: string, door: McpDoor = 'owner'): string {
  return `${trimOrigin(origin)}/.well-known/oauth-authorization-server${DOORS[door].issuerPath}`;
}

/** Which door a well-known suffix names, or null for a path that is neither. */
export function doorForResourcePath(suffix: string): McpDoor | null {
  const s = suffix.replace(/\/$/, '');
  if (s === '' || s === DOORS.owner.mcpPath) return 'owner';
  if (s === DOORS.agent.mcpPath) return 'agent';
  return null;
}

export function doorForIssuerPath(suffix: string): McpDoor | null {
  const s = suffix.replace(/\/$/, '');
  if (s === DOORS.owner.issuerPath) return 'owner';
  if (s === DOORS.agent.issuerPath) return 'agent';
  return null;
}

/**
 * The origin a request arrived on, from its headers — used by every OAuth surface: the
 * route handlers, the consent page and its Server Action. One function because the issuer
 * and resource the consent page computes must equal what the token endpoint computes, and a
 * page has only headers. Not `request.nextUrl.origin`: verify:public found `next start`
 * reporting `localhost` there while the Host header said `127.0.0.1`, which would have made
 * the token endpoint refuse every code as `resource_not_this_server`.
 */
export function originFromHeaders(get: (name: string) => string | null): string {
  const host = get('x-forwarded-host') ?? get('host');
  if (!host) throw new Error('No host header; cannot tell which server this is.');
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = get('x-forwarded-proto')?.split(',')[0]?.trim() ?? (local ? 'http' : 'https');
  return `${proto}://${host}`;
}
