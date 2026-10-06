import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { Db } from '../db/server';
import { ALLOWED_METADATA_HOSTS, ALLOWED_REDIRECT_URIS } from './policy';
import { OAuthError } from './errors';

/**
 * Who is asking. Two ways a client identifies itself, and one rule over both.
 *
 * ── Client ID Metadata Document (preferred) ──────────────────────────────────
 * The client_id is an https URL; the document at that URL describes the client and must
 * name itself as that same client_id. Nothing to register, nothing stored that the client
 * did not publish. Only Claude's hosts are fetched (policy.ts says why).
 *
 * ── Dynamic Client Registration (fallback) ──────────────────────────────────
 * RFC 7591. The client POSTs its metadata and receives a `kiln_dcr_…` id. Public clients
 * only: no secret is issued, and the response says `token_endpoint_auth_method: none` so a
 * conforming client does not try to authenticate at the token endpoint.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * Every redirect URI a client declares must be on ALLOWED_REDIRECT_URIS, whichever way it
 * arrived. A registration is refused whole if one URI is off the list, rather than trimmed
 * to the URIs that are on it: a client that asked for a callback we do not honour has a
 * configuration we do not understand, and quietly accepting part of it would make its
 * failure appear later and somewhere less obvious.
 */

export interface OAuthClient {
  clientId: string;
  registration: 'metadata_document' | 'dynamic';
  clientName: string;
  redirectUris: string[];
}

export type FetchDocument = (url: string) => Promise<unknown>;

const MAX_DOCUMENT_BYTES = 64 * 1024;

/** Production fetcher: bounded in time and size, and does not follow redirects. */
export const fetchClientDocument: FetchDocument = async (url) => {
  const res = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DOCUMENT_BYTES) throw new Error(`document is over ${MAX_DOCUMENT_BYTES} bytes`);
  return JSON.parse(text) as unknown;
};

function refuseRedirects(uris: readonly string[]): void {
  const off = uris.filter((u) => !ALLOWED_REDIRECT_URIS.includes(u));
  if (off.length > 0) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'redirect_uri_not_allowed',
      `${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} not Claude's connector callback. ` +
        `Kiln sends codes only to ${ALLOWED_REDIRECT_URIS.join(' or ')}.`,
    );
  }
}

export function isMetadataDocumentId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

const ClientDocument = z.object({
  client_id: z.string(),
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string()).min(1),
});

const Registration = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

async function upsertClient(db: Db, c: OAuthClient, metadata: unknown): Promise<void> {
  const { error } = await db.from('oauth_clients').upsert(
    {
      client_id: c.clientId,
      registration: c.registration,
      client_name: c.clientName,
      redirect_uris: c.redirectUris,
      metadata: metadata as never,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'client_id' },
  );
  if (error) throw new OAuthError('server_error', 'client_store_failed', error.message, 500);
}

/** Fetch, check and cache a metadata-document client. */
async function resolveMetadataClient(db: Db, clientId: string, fetchDoc: FetchDocument): Promise<OAuthClient> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError('invalid_client', 'client_id_not_a_url', `${clientId} is not a URL.`);
  }
  if (url.protocol !== 'https:' || url.pathname === '/' || url.hash) {
    throw new OAuthError('invalid_client', 'client_id_not_a_metadata_url',
      `${clientId} must be an https URL with a path and no fragment.`);
  }
  if (!ALLOWED_METADATA_HOSTS.includes(url.hostname)) {
    throw new OAuthError('invalid_client', 'client_host_not_allowed',
      `Kiln reads client metadata only from ${ALLOWED_METADATA_HOSTS.join(' and ')}; ${url.hostname} is not one of them.`);
  }

  let raw: unknown;
  try {
    raw = await fetchDoc(clientId);
  } catch (err) {
    throw new OAuthError('invalid_client', 'client_metadata_unreachable',
      `Could not read ${clientId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const doc = ClientDocument.safeParse(raw);
  if (!doc.success) {
    throw new OAuthError('invalid_client', 'client_metadata_malformed',
      `${clientId} did not return a client metadata document (client_id and redirect_uris are required).`);
  }
  if (doc.data.client_id !== clientId) {
    throw new OAuthError('invalid_client', 'client_metadata_mismatch',
      `The document at ${clientId} names itself ${doc.data.client_id}.`);
  }
  refuseRedirects(doc.data.redirect_uris);

  const client: OAuthClient = {
    clientId,
    registration: 'metadata_document',
    clientName: doc.data.client_name?.trim() || url.hostname,
    redirectUris: doc.data.redirect_uris,
  };
  await upsertClient(db, client, raw);
  return client;
}

/** The client a request names, or a named refusal. Never redirects anywhere. */
export async function resolveClient(db: Db, clientId: string | null, fetchDoc: FetchDocument): Promise<OAuthClient> {
  if (!clientId) throw new OAuthError('invalid_request', 'client_id_missing', 'client_id is required.');
  if (isMetadataDocumentId(clientId)) return resolveMetadataClient(db, clientId, fetchDoc);

  const { data, error } = await db
    .from('oauth_clients')
    .select('client_id, registration, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw new OAuthError('server_error', 'client_lookup_failed', error.message, 500);
  if (!data || data.registration !== 'dynamic') {
    throw new OAuthError('invalid_client', 'client_unknown',
      `${clientId} is not a registered client. Register at the registration endpoint, or use a metadata-document client_id.`);
  }
  return {
    clientId: data.client_id,
    registration: 'dynamic',
    clientName: data.client_name,
    redirectUris: data.redirect_uris,
  };
}

/** RFC 7591 registration. Returns the response body. */
export async function registerClient(db: Db, body: unknown) {
  const parsed = Registration.safeParse(body);
  if (!parsed.success) {
    throw new OAuthError('invalid_client_metadata', 'registration_malformed',
      'redirect_uris (a non-empty array of strings) is required.');
  }
  const r = parsed.data;
  refuseRedirects(r.redirect_uris);
  if (r.grant_types && r.grant_types.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new OAuthError('invalid_client_metadata', 'grant_type_not_supported',
      `Only authorization_code and refresh_token are supported; asked for ${r.grant_types.join(', ')}.`);
  }
  if (r.response_types && r.response_types.some((t) => t !== 'code')) {
    throw new OAuthError('invalid_client_metadata', 'response_type_not_supported', 'Only response_type code is supported.');
  }

  const client: OAuthClient = {
    clientId: `kiln_dcr_${randomBytes(18).toString('base64url')}`,
    registration: 'dynamic',
    clientName: r.client_name?.trim() || 'Unnamed client',
    redirectUris: r.redirect_uris,
  };
  await upsertClient(db, client, r);

  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Overrides whatever was asked for (RFC 7591 §3.2.1 lets the server do so): no secret
    // exists, so there is nothing to authenticate with.
    token_endpoint_auth_method: 'none',
  };
}
