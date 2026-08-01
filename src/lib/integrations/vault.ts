import 'server-only';

import type { Db } from '../db/server';

/**
 * The Vault write path.
 *
 * Deferred since 1a because Vault was unreachable from the build environment. The shape of
 * it was never in doubt — what was in doubt was whether the extension existed, whether the
 * round trip preserved the plaintext, and whether PostgREST could reach the RPCs at all.
 * Those are still the open questions; see 0008.
 *
 * ── Write-only, and what that actually means ─────────────────────────────────
 *
 * Nothing in this module returns a secret to a caller that could forward it to a browser.
 * `store()` returns `last_4`. `describe()` returns `last_4` and timestamps. The only
 * function that yields plaintext is `resolveCredentials()` in `credentials.ts`, it is
 * `server-only`, and the RPC underneath it is granted to `service_role` alone.
 *
 * Four characters is the whole budget. It answers "is this the key I think it is?" for
 * someone who has the key in front of them, and it answers nothing at all for someone who
 * does not. A `last_8` would start to be a hint.
 */

export interface SecretDescriptor {
  fieldKey: string;
  last4: string;
  configuredAt: string;
  rotatedAt: string | null;
}

/** Everything the browser is allowed to know about what is configured. */
export async function describeSecrets(
  db: Db,
  integrationId: string,
): Promise<SecretDescriptor[]> {
  const { data, error } = await db
    .from('integration_secrets')
    .select('field_key, last_4, configured_at, rotated_at')
    .eq('integration_id', integrationId)
    .order('field_key');

  if (error) throw new Error(`Reading configured secrets failed: ${error.message}`);

  return (data ?? []).map((row) => ({
    fieldKey: row.field_key,
    last4: row.last_4,
    configuredAt: row.configured_at,
    rotatedAt: row.rotated_at,
  }));
}

export type VaultWriteResult =
  | { ok: true; last4: string }
  | { ok: false; reason: 'vault_unavailable' | 'rejected'; detail: string };

/**
 * Store or rotate one credential field.
 *
 * `vault_unavailable` is separated from `rejected` because they are different
 * instructions. The first means the `supabase_vault` extension is not enabled on the
 * project and no amount of retyping the key will help; the second means the value itself
 * was refused. Collapsing them into "something went wrong" sends someone to check their
 * API key for twenty minutes over a missing extension.
 */
export async function storeSecret(
  db: Db,
  params: { integrationId: string; fieldKey: string; value: string },
): Promise<VaultWriteResult> {
  const value = params.value.trim();
  if (!value) {
    return { ok: false, reason: 'rejected', detail: 'Refusing to store an empty value.' };
  }

  const { data, error } = await db.rpc('integration_secret_put', {
    p_integration_id: params.integrationId,
    p_field_key: params.fieldKey,
    p_secret: value,
  });

  if (error) {
    const unavailable = /vault is not installed|schema "vault"|does not exist/i.test(
      error.message,
    );
    return {
      ok: false,
      reason: unavailable ? 'vault_unavailable' : 'rejected',
      // The RPC's own message is preserved. It is written for this exact moment and says
      // what to do; replacing it with a generic string throws that away.
      detail: error.message,
    };
  }

  return { ok: true, last4: data ?? value.slice(-4) };
}

/** Rotation's other half. Removes the pointer and the Vault row together. */
export async function deleteSecret(
  db: Db,
  params: { integrationId: string; fieldKey: string },
): Promise<boolean> {
  const { data, error } = await db.rpc('integration_secret_delete', {
    p_integration_id: params.integrationId,
    p_field_key: params.fieldKey,
  });

  if (error) throw new Error(`Deleting ${params.fieldKey} failed: ${error.message}`);
  return data ?? false;
}
