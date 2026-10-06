import { createHash, randomBytes } from 'node:crypto';

import type { Db } from '../db/server';

/**
 * Bearer tokens for the Bureau control plane on `/api/mcp`.
 *
 * Two scopes. `approver` is Sahil: it can approve and reject briefs and cuts, mark bundles
 * scheduled, set caps and flip the kill switch. `agent` is everything scheduled — Routines
 * and Claude tasks: it can read, draft briefs, queue dubs and ask for a shot regeneration,
 * and nothing that decides. The scope is a property of the token row, never of a tool
 * argument, so a model holding an agent token cannot talk its way into a decision.
 *
 * Only the SHA-256 is stored (`mcp_tokens.token_hash`). The plaintext is shown once, when
 * minted, and cannot be recovered — rotate by minting a new one and revoking the old.
 *
 * Two kinds since 0045. A `static` token (minted on Settings, `kb_a_…` / `kb_g_…`) does not
 * expire (decision 0012 #2) — Routines and Claude Code send it as a fixed header. An `oauth`
 * token (`kb_oa_…` / `kb_og_…`) is the current access token of one consented Claude
 * connector connection (decision 0016): it expires after an hour and is replaced on refresh.
 * Both are the same row shape with the same scope, and revocation is `revoked_at` for both,
 * checked on every request and again inside every decision function in the database.
 */

export type BureauScope = 'approver' | 'agent';

export interface BureauToken {
  id: string;
  scope: BureauScope;
  channelId: string;
  profileId: string | null;
  name: string;
}

const PREFIX = 'kb_';

export function isBureauToken(bearer: string): boolean {
  return bearer.startsWith(PREFIX);
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** `kb_a_…` for approver, `kb_g_…` for agent — readable in a connector list at a glance. */
export function newTokenPlaintext(scope: BureauScope): string {
  return `${PREFIX}${scope === 'approver' ? 'a' : 'g'}_${randomBytes(32).toString('base64url')}`;
}

export async function mintBureauToken(
  db: Db,
  input: { name: string; scope: BureauScope; channelId: string; profileId: string | null },
): Promise<{ plaintext: string; id: string; prefix: string }> {
  if (input.scope === 'approver' && !input.profileId) {
    // The database refuses this too (mcp_tokens check). Said here with the reason: an
    // approval records a reviewer, and a reviewer is a person.
    throw new Error('An approver token must name the person whose decisions it records.');
  }
  const plaintext = newTokenPlaintext(input.scope);
  const prefix = plaintext.slice(0, 10);
  const { data, error } = await db
    .from('mcp_tokens')
    .insert({
      name: input.name,
      scope: input.scope,
      token_hash: hashToken(plaintext),
      token_prefix: prefix,
      channel_id: input.channelId,
      profile_id: input.profileId,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Minting the token failed: ${error?.message ?? 'no row'}`);
  return { plaintext, id: data.id, prefix };
}

export type ResolveResult =
  | { ok: true; token: BureauToken }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'lookup_failed'; detail?: string };

export async function resolveBureauToken(db: Db, plaintext: string): Promise<ResolveResult> {
  const { data, error } = await db
    .from('mcp_tokens')
    // `*`, not a column list naming expires_at: until 0045 is pasted into the hosted project
    // that column does not exist, and naming it would turn every static-token request into a
    // 503 the moment this code deploys. With `*` a missing column reads as undefined — no
    // expiry — which is exactly what every pre-0045 row means.
    .select('*')
    .eq('token_hash', hashToken(plaintext))
    .maybeSingle();

  if (error) return { ok: false, reason: 'lookup_failed', detail: error.message };
  if (!data) return { ok: false, reason: 'unknown' };
  if (data.revoked_at) return { ok: false, reason: 'revoked' };
  // An OAuth access token past its hour. The connector answers a 401 by refreshing.
  const expiresAt = (data as { expires_at?: string | null }).expires_at;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // Best effort: a failed timestamp write must not fail the request it describes.
  await db.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);

  return {
    ok: true,
    token: {
      id: data.id,
      name: data.name,
      scope: data.scope as BureauScope,
      channelId: data.channel_id,
      profileId: data.profile_id,
    },
  };
}

export async function revokeBureauToken(db: Db, id: string): Promise<void> {
  const { error } = await db.from('mcp_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`Revoking token ${id} failed: ${error.message}`);
}
