import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Db } from '../db/server';
import { hashToken } from '../bureau/tokens';
import { resolveClient, type FetchDocument, type OAuthClient } from './clients';
import {
  ACCESS_TOKEN_TTL_S,
  ALLOWED_REDIRECT_URIS,
  AUTH_CODE_TTL_S,
  DEFAULT_SCOPE,
  OAUTH_SCOPES,
  REFRESH_TOKEN_TTL_S,
  resourceFor,
  type OAuthScope,
} from './policy';
import { OAuthError } from './errors';

/**
 * Authorization code + PKCE, and refresh with rotation.
 *
 * ── Where the redirect is allowed to happen ──────────────────────────────────
 * OAuth splits authorize-time errors in two. If the client or the redirect URI cannot be
 * trusted, the error is shown *here* and nothing is sent anywhere — redirecting an error to
 * an unvalidated URI is the open redirect the check exists to prevent. Once both are known
 * good, every later problem (bad PKCE method, wrong resource, the person pressing Deny) goes
 * back to the client as `?error=` on its own callback, which is how a connector learns why.
 * `AuthorizeRefusal.redirectable` carries that split.
 *
 * ── What a successful exchange creates ───────────────────────────────────────
 * One mcp_tokens row of kind `oauth` (the connection: scope, channel, person, revocation,
 * and the hash of the current access token) and one oauth_refresh_tokens row. Revoking the
 * mcp_tokens row on Settings ends both — see 0045.
 */

const ACCESS_PREFIX = { approver: 'kb_oa_', agent: 'kb_og_' } as const;
const REFRESH_PREFIX = 'kbr_';

export interface AuthorizeParams {
  response_type: string | null;
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  state: string | null;
  scope: string | null;
  resource: string | null;
}

export const AUTHORIZE_PARAM_NAMES = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;

export function authorizeParamsFrom(get: (name: string) => string | null | undefined): AuthorizeParams {
  const out = {} as Record<(typeof AUTHORIZE_PARAM_NAMES)[number], string | null>;
  for (const n of AUTHORIZE_PARAM_NAMES) {
    const v = get(n);
    out[n] = typeof v === 'string' && v.length > 0 ? v : null;
  }
  return out as AuthorizeParams;
}

export interface ValidAuthorize {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
  /** What consent preselects: the requested scope when it names exactly one, else approver. */
  suggestedScope: OAuthScope;
}

export type AuthorizeCheck =
  | { ok: true; request: ValidAuthorize }
  | { ok: false; error: OAuthError; redirectTo: string | null };

/** `redirect_uri?error=…&state=…&iss=…` */
export function errorRedirect(redirectUri: string, err: OAuthError, state: string | null, issuer: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set('error', err.error);
  u.searchParams.set('error_description', err.description);
  if (state) u.searchParams.set('state', state);
  u.searchParams.set('iss', issuer);
  return u.toString();
}

function suggested(scope: string | null): OAuthScope {
  if (!scope) return DEFAULT_SCOPE;
  const asked = scope.split(/\s+/).filter((s) => (OAUTH_SCOPES as readonly string[]).includes(s));
  return asked.length === 1 ? (asked[0] as OAuthScope) : DEFAULT_SCOPE;
}

/**
 * Validate an authorize request. Called by the consent page to render, and again by the
 * consent action before it issues anything — the hidden form fields are the client's
 * input coming round a second time, not something this server vouched for.
 */
export async function checkAuthorize(
  db: Db,
  params: AuthorizeParams,
  origin: string,
  fetchDoc: FetchDocument,
): Promise<AuthorizeCheck> {
  // 1. Client and redirect URI. Refusals here are shown, never redirected.
  let client: OAuthClient;
  try {
    client = await resolveClient(db, params.client_id, fetchDoc);
  } catch (err) {
    if (err instanceof OAuthError) return { ok: false, error: err, redirectTo: null };
    throw err;
  }
  const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (!redirectUri) {
    return { ok: false, redirectTo: null, error: new OAuthError('invalid_request', 'redirect_uri_missing',
      `${client.clientName} declares several redirect URIs, so the request must say which.`) };
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false, redirectTo: null, error: new OAuthError('invalid_request', 'redirect_uri_not_registered',
      `${redirectUri} is not one of the redirect URIs ${client.clientName} declared.`) };
  }
  // resolveClient already refused any client declaring an off-list URI, so a registered URI
  // is an allowed one. Restated rather than relied on: this is the line that matters.
  if (!ALLOWED_REDIRECT_URIS.includes(redirectUri)) {
    return { ok: false, redirectTo: null, error: new OAuthError('invalid_request', 'redirect_uri_not_allowed',
      `${redirectUri} is not Claude's connector callback.`) };
  }

  // 2. Everything else goes back to the client.
  const back = (e: OAuthError): AuthorizeCheck => ({
    ok: false,
    error: e,
    redirectTo: errorRedirect(redirectUri, e, params.state, origin.replace(/\/$/, '')),
  });

  if (params.response_type !== 'code') {
    return back(new OAuthError('unsupported_response_type', 'response_type_not_code',
      `Only response_type=code is supported; got ${params.response_type ?? 'none'}.`));
  }
  if (!params.code_challenge) {
    return back(new OAuthError('invalid_request', 'pkce_required', 'code_challenge is required (PKCE, S256).'));
  }
  if (params.code_challenge_method !== 'S256') {
    return back(new OAuthError('invalid_request', 'pkce_method_not_s256',
      `code_challenge_method must be S256; got ${params.code_challenge_method ?? 'none (which means plain)'}.`));
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) {
    return back(new OAuthError('invalid_request', 'pkce_challenge_malformed',
      'code_challenge must be the base64url SHA-256 of the verifier: 43 characters.'));
  }
  const resource = resourceFor(origin);
  if (params.resource && params.resource.replace(/\/$/, '') !== resource) {
    return back(new OAuthError('invalid_target', 'resource_not_this_server',
      `This server issues tokens for ${resource} only; asked for ${params.resource}.`));
  }

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge: params.code_challenge,
      state: params.state,
      resource,
      suggestedScope: suggested(params.scope),
    },
  };
}

/**
 * The consent decision. The caller has already established that the person is signed in
 * and on ALLOWED_EMAIL — this function takes a profile id it trusts and does nothing else
 * about identity. Returns the URL to send the browser to.
 */
export async function decideConsent(
  db: Db,
  input: {
    request: ValidAuthorize;
    approve: boolean;
    scope: string;
    profileId: string;
    channelId: string;
    origin: string;
  },
): Promise<string> {
  const issuer = input.origin.replace(/\/$/, '');
  const { request } = input;
  if (!input.approve) {
    return errorRedirect(request.redirectUri,
      new OAuthError('access_denied', 'consent_denied', 'The Kiln owner declined this connection.'),
      request.state, issuer);
  }
  if (!(OAUTH_SCOPES as readonly string[]).includes(input.scope)) {
    return errorRedirect(request.redirectUri,
      new OAuthError('invalid_scope', 'scope_unknown', `Scope must be approver or agent; got ${input.scope}.`),
      request.state, issuer);
  }

  const code = randomBytes(32).toString('base64url');
  const { error } = await db.from('oauth_codes').insert({
    code_hash: hashToken(code),
    client_id: request.client.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    scope: input.scope,
    resource: request.resource,
    profile_id: input.profileId,
    channel_id: input.channelId,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_S * 1000).toISOString(),
  });
  if (error) throw new Error(`Storing the authorization code failed: ${error.message}`);

  const u = new URL(request.redirectUri);
  u.searchParams.set('code', code);
  if (request.state) u.searchParams.set('state', request.state);
  u.searchParams.set('iss', issuer);
  return u.toString();
}

// ═════════════════════════════════════════════════════════════════════════════
// The token endpoint
// ═════════════════════════════════════════════════════════════════════════════

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function newAccess(scope: OAuthScope): string {
  return `${ACCESS_PREFIX[scope]}${randomBytes(32).toString('base64url')}`;
}

function newRefresh(): string {
  return `${REFRESH_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function later(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function storeRefresh(db: Db, grantId: string): Promise<string> {
  const plaintext = newRefresh();
  const { error } = await db.from('oauth_refresh_tokens').insert({
    token_hash: hashToken(plaintext),
    grant_id: grantId,
    expires_at: later(REFRESH_TOKEN_TTL_S),
  });
  if (error) throw new OAuthError('server_error', 'refresh_store_failed', error.message, 500);
  return plaintext;
}

async function revokeGrant(db: Db, grantId: string): Promise<void> {
  await db.from('mcp_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', grantId).is('revoked_at', null);
}

const invalidGrant = (kiln: string, detail: string) => new OAuthError('invalid_grant', kiln, detail);

async function exchangeCode(db: Db, form: URLSearchParams, clientId: string | null, origin: string): Promise<TokenResponse> {
  const code = form.get('code');
  const verifier = form.get('code_verifier');
  const redirectUri = form.get('redirect_uri');
  if (!code) throw new OAuthError('invalid_request', 'code_missing', 'code is required.');
  if (!verifier) throw new OAuthError('invalid_request', 'pkce_verifier_missing', 'code_verifier is required.');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new OAuthError('invalid_request', 'pkce_verifier_malformed', 'code_verifier must be 43–128 unreserved characters.');
  }

  const codeHash = hashToken(code);
  // Consume first, atomically: of two concurrent exchanges exactly one gets the row back.
  const { data: row, error } = await db
    .from('oauth_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code_hash', codeHash)
    .is('consumed_at', null)
    .select('client_id, redirect_uri, code_challenge, scope, resource, profile_id, channel_id, expires_at')
    .maybeSingle();
  if (error) throw new OAuthError('server_error', 'code_lookup_failed', error.message, 500);

  if (!row) {
    const { data: used } = await db.from('oauth_codes').select('grant_id').eq('code_hash', codeHash).maybeSingle();
    if (used) {
      // A code arriving twice means it was intercepted or the client is replaying it.
      // Either way the connection it already minted is no longer trustworthy.
      if (used.grant_id) await revokeGrant(db, used.grant_id);
      throw invalidGrant('code_replayed',
        'This authorization code was already used. The connection it created has been revoked; connect again.');
    }
    throw invalidGrant('code_unknown', 'This authorization code does not exist.');
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw invalidGrant('code_expired', 'This authorization code has expired; connect again.');
  }
  if (!clientId || clientId !== row.client_id) {
    throw invalidGrant('client_mismatch', 'The code was issued to a different client_id.');
  }
  if (redirectUri !== row.redirect_uri) {
    throw invalidGrant('redirect_uri_mismatch', 'redirect_uri must be exactly the one the code was issued for.');
  }
  if (!same(s256(verifier), row.code_challenge)) {
    throw invalidGrant('pkce_mismatch', 'code_verifier does not match the code_challenge.');
  }
  const resource = form.get('resource');
  if (resource && resource.replace(/\/$/, '') !== row.resource) {
    throw new OAuthError('invalid_target', 'resource_mismatch', `The code was issued for ${row.resource}.`);
  }
  if (row.resource !== resourceFor(origin)) {
    throw new OAuthError('invalid_target', 'resource_not_this_server', `The code was issued for ${row.resource}.`);
  }

  const { data: client } = await db.from('oauth_clients').select('client_name').eq('client_id', row.client_id).maybeSingle();
  const scope = row.scope as OAuthScope;
  const access = newAccess(scope);
  const { data: grant, error: grantError } = await db
    .from('mcp_tokens')
    .insert({
      name: `${client?.client_name ?? 'OAuth client'} (connector)`,
      scope,
      kind: 'oauth',
      token_hash: hashToken(access),
      token_prefix: access.slice(0, 10),
      profile_id: row.profile_id,
      channel_id: row.channel_id,
      expires_at: later(ACCESS_TOKEN_TTL_S),
      oauth_client_id: row.client_id,
      oauth_redirect_uri: row.redirect_uri,
    })
    .select('id')
    .single();
  if (grantError || !grant) throw new OAuthError('server_error', 'grant_store_failed', grantError?.message ?? 'no row', 500);

  await db.from('oauth_codes').update({ grant_id: grant.id }).eq('code_hash', codeHash);
  const refresh = await storeRefresh(db, grant.id);

  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope };
}

async function exchangeRefresh(db: Db, form: URLSearchParams, clientId: string | null): Promise<TokenResponse> {
  const presented = form.get('refresh_token');
  if (!presented) throw new OAuthError('invalid_request', 'refresh_token_missing', 'refresh_token is required.');
  const hash = hashToken(presented);

  const { data: row, error } = await db
    .from('oauth_refresh_tokens')
    .update({ rotated_at: new Date().toISOString() })
    .eq('token_hash', hash)
    .is('rotated_at', null)
    .select('grant_id, expires_at')
    .maybeSingle();
  if (error) throw new OAuthError('server_error', 'refresh_lookup_failed', error.message, 500);

  if (!row) {
    const { data: used } = await db.from('oauth_refresh_tokens').select('grant_id').eq('token_hash', hash).maybeSingle();
    if (used) {
      await revokeGrant(db, used.grant_id);
      throw invalidGrant('refresh_token_replayed',
        'This refresh token was already used, so two parties hold it. The connection has been revoked; connect again.');
    }
    throw invalidGrant('refresh_token_unknown', 'This refresh token does not exist.');
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw invalidGrant('refresh_token_expired', 'This refresh token has expired; connect again.');
  }

  const { data: grant, error: grantError } = await db
    .from('mcp_tokens')
    .select('id, scope, kind, revoked_at, oauth_client_id')
    .eq('id', row.grant_id)
    .maybeSingle();
  if (grantError) throw new OAuthError('server_error', 'grant_lookup_failed', grantError.message, 500);
  if (!grant || grant.kind !== 'oauth') throw invalidGrant('grant_unknown', 'The connection this token belonged to no longer exists.');
  if (grant.revoked_at) {
    throw invalidGrant('grant_revoked', 'This connection was revoked in Kiln (Settings → MCP tokens). Connect again.');
  }
  if (!clientId || clientId !== grant.oauth_client_id) {
    throw invalidGrant('client_mismatch', 'The refresh token was issued to a different client_id.');
  }

  const scope = grant.scope as OAuthScope;
  const access = newAccess(scope);
  const { error: updateError } = await db
    .from('mcp_tokens')
    .update({ token_hash: hashToken(access), token_prefix: access.slice(0, 10), expires_at: later(ACCESS_TOKEN_TTL_S) })
    .eq('id', grant.id)
    .is('revoked_at', null);
  if (updateError) throw new OAuthError('server_error', 'grant_update_failed', updateError.message, 500);
  const refresh = await storeRefresh(db, grant.id);

  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope };
}

/** client_id from the form, or from HTTP Basic if a client sent it that way. */
export function clientIdFrom(form: URLSearchParams, authorization: string | null): string | null {
  const fromForm = form.get('client_id');
  if (fromForm) return fromForm;
  const m = authorization ? /^basic\s+(.+)$/i.exec(authorization.trim()) : null;
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const id = decoded.split(':')[0];
    return id ? decodeURIComponent(id) : null;
  } catch {
    return null;
  }
}

export async function exchangeToken(
  db: Db,
  form: URLSearchParams,
  authorization: string | null,
  origin: string,
): Promise<TokenResponse> {
  const clientId = clientIdFrom(form, authorization);
  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') return exchangeCode(db, form, clientId, origin);
  if (grantType === 'refresh_token') return exchangeRefresh(db, form, clientId);
  throw new OAuthError('unsupported_grant_type', 'grant_type_not_supported',
    `grant_type must be authorization_code or refresh_token; got ${grantType ?? 'none'}.`);
}
