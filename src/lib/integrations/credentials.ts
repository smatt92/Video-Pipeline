import 'server-only';

import { INTEGRATION_CATALOG } from '../drivers/catalog';
import type { Db } from '../db/server';

/**
 * Where a vendor credential actually comes from.
 *
 * Migration 0003 is explicit: *"a driver is built per-call from an integration record,
 * never from module-level process.env. Environment keeps two jobs only — bootstrap and
 * CI."* This module is that sentence, implemented. It had never been implemented, which is
 * why `src/lib/env.ts` still required every vendor key and why a deployment with none of
 * them set could not boot far enough to run the wizard that supplies them.
 *
 * Order: Vault first, environment second. Not the other way round. A stale local key
 * silently winning over the one someone just configured in the UI is a debugging session
 * nobody enjoys, and the symptom is "I changed the key and nothing happened".
 *
 * ── Why the field keys are environment variable names ────────────────────────
 *
 * `SecretFieldDescriptor.key` in the catalogue is the credential's environment-variable
 * name — `<VENDOR>_API_KEY` — rather than a tidy `apiKey`. That looks like a leaked
 * implementation detail and is load-bearing: one credential has one name whichever door it
 * came through, so the fallback below is a lookup rather than a mapping table that can
 * drift out of sync with the thing it maps.
 */

export type CredentialSource = 'vault' | 'env';

export interface ResolvedCredentials {
  integrationId: string | null;
  /** Field key → value. Only fields that resolved appear. */
  values: Record<string, string>;
  /** Where each field came from. Surfaced in the UI so "which key is it using?" is
   *  answerable without guessing. */
  sources: Record<string, CredentialSource>;
  /** Declared by the catalogue and resolved by neither door. */
  missing: string[];
}

/** Read `process.env` by name. Server-only module, so no Edge inlining concern here. */
function fromEnv(key: string): string | null {
  const v = process.env[key]?.trim();
  return v ? v : null;
}

/**
 * Every credential field the named integration declares.
 *
 * Requires a service-role client. `integration_secrets_read` is granted to `service_role`
 * and nothing else (0007), because Phase 1 has no RLS and a grant to `anon` would put every
 * vendor credential one fetch away from anyone who loaded the page.
 */
export async function resolveCredentials(
  db: Db,
  slug: string,
): Promise<ResolvedCredentials> {
  const descriptor = INTEGRATION_CATALOG.find((i) => i.slug === slug);
  if (!descriptor) {
    throw new Error(`No integration descriptor for "${slug}". Add it to the catalogue.`);
  }

  const declared = descriptor.secretFields.map((f) => f.key);

  const { data: integration } = await db
    .from('integrations')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  const values: Record<string, string> = {};
  const sources: Record<string, CredentialSource> = {};

  if (integration) {
    const { data: secrets, error } = await db.rpc('integration_secrets_read', {
      p_integration_id: integration.id,
    });

    // A Vault read that errors is not the same as one that returns nothing, and the
    // difference matters: the first means the extension is missing or the grant is wrong,
    // and falling through to the environment would mask it. Surfaced rather than swallowed.
    if (error && !/does not exist|not installed/i.test(error.message)) {
      throw new Error(`Reading credentials for "${slug}" from Vault failed: ${error.message}`);
    }

    for (const row of secrets ?? []) {
      if (row.secret) {
        values[row.field_key] = row.secret;
        sources[row.field_key] = 'vault';
      }
    }
  }

  for (const key of declared) {
    if (values[key]) continue;
    const fallback = fromEnv(key);
    if (fallback) {
      values[key] = fallback;
      sources[key] = 'env';
    }
  }

  return {
    integrationId: integration?.id ?? null,
    values,
    sources,
    missing: declared.filter((k) => !values[k]),
  };
}

/**
 * One credential, or a legible failure.
 *
 * The message names the integration and the step that configures it, because the person
 * who hits this is usually one wizard step away from fixing it and the default phrasing —
 * "undefined is not a valid API key" — tells them nothing about which of five vendors is
 * unconfigured.
 */
export async function requireCredential(
  db: Db,
  slug: string,
  fieldKey: string,
): Promise<string> {
  const resolved = await resolveCredentials(db, slug);
  const value = resolved.values[fieldKey];

  if (!value) {
    throw new Error(
      `No credential for ${fieldKey} on the "${slug}" integration.\n\n` +
        'Credentials are stored in Vault through the onboarding wizard, with the ' +
        'environment as a local-development fallback. Neither has it. Configure the ' +
        'integration, or set ' +
        fieldKey +
        ' in the environment.',
    );
  }

  return value;
}
