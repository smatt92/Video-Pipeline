import 'server-only';

import { descriptorFor, type IntegrationDescriptor } from '../drivers/catalog';
import { probeIntegration, type CheckResult } from '../drivers/probes';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { createSupabaseStorageDriver } from '../storage/supabase';
import { resolveCredentials } from './credentials';

/**
 * "Run check" — a real vendor call, and everything it writes.
 *
 * ── The three states, and why two booleans would not do ──────────────────────
 *
 *   never run   `last_checked_at` null.        Nothing has been attempted.
 *   failed      checked, not verified since.   Attempted and refused.
 *   verified    `last_verified_at` >= checked. Attempted and accepted.
 *
 * The first two are different instructions to the person reading them — "set this up" and
 * "this is wrong, look at it" — and a single `is_verified` boolean collapses them into a
 * grey tick that means either. Migration 0007 added `last_checked_at` precisely because
 * `last_verified_at` alone could not distinguish "never tried" from "tried and failed".
 *
 * ── What a run writes ────────────────────────────────────────────────────────
 *
 *   integrations         last_checked_at always; last_verified_at and last_error on the
 *                        outcome; config merged with whatever the probe learned.
 *   integration_checks   one row per named check, upserted — the *current* answer, so the
 *                        UI can render a tick without replaying history.
 *   integration_events   one row per run, append-only. Cheap now, essential the day a key
 *                        leaks and the question is "when did this change?".
 *
 * All three are written even when the check fails. A failure that leaves no trace is the
 * swallowed exception this project forbids, wearing a different hat.
 */

export interface VerifyOutcome {
  ok: boolean;
  slug: string;
  checks: CheckResult[];
  latencyMs: number;
  /** One line for the UI. Never contains credential material. */
  summary: string;
}

/** A probe that could not even be attempted still has to produce a written outcome. */
function unconfigured(missing: string[]): CheckResult[] {
  return [
    {
      name: 'credentials',
      passed: false,
      required: true,
      detail:
        `Not configured: ${missing.join(', ')}. Nothing was called — there was nothing ` +
        'to call with.',
    },
  ];
}

async function runProbe(
  db: Db,
  descriptor: IntegrationDescriptor,
): Promise<{ checks: CheckResult[]; latencyMs: number }> {
  const resolved = await resolveCredentials(db, descriptor.slug);

  if (resolved.missing.length > 0) {
    return { checks: unconfigured(resolved.missing), latencyMs: 0 };
  }

  const v = resolved.values;

  // Storage first, and by *kind* rather than by slug. Its probe is a property of the
  // StorageDriver interface — write, read back, compare bytes, delete, confirm gone — and
  // re-implementing that behind a vendor name would be a second copy to drift.
  //
  // The driver is built from the credentials just resolved rather than from the
  // environment. That is the whole reason the constructor takes them: the wizard has to
  // test a key that, by definition, is not in process.env yet.
  if (descriptor.kind === 'storage') {
    const started = Date.now();
    try {
      const driver = createSupabaseStorageDriver({
        accessKeyId: v.SUPABASE_S3_ACCESS_KEY_ID,
        secretAccessKey: v.SUPABASE_S3_SECRET_ACCESS_KEY,
      });
      const result = await driver.probe();
      return {
        latencyMs: result.latencyMs,
        checks: [
          {
            name: 'credentials',
            passed: result.steps.write,
            required: true,
            detail: result.steps.write
              ? 'Authenticated and accepted a write.'
              : `Could not write. ${result.detail}`,
          },
          { name: 'round_trip', passed: result.ok, required: true, detail: result.detail },
        ],
      };
    } catch (err) {
      return {
        latencyMs: Date.now() - started,
        checks: [
          {
            name: 'credentials',
            passed: false,
            required: true,
            detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
          },
        ],
      };
    }
  }

  // Everything else routes through the driver layer, which is the only place allowed to
  // know which vendor is behind which slug.
  const result = await probeIntegration(descriptor, v);
  if (result) return result;

  return {
    latencyMs: 0,
    checks: [
      {
        name: 'credentials',
        passed: false,
        required: true,
        detail: `No probe is implemented for the ${descriptor.label} integration yet.`,
      },
    ],
  };
}

export async function verifyIntegration(db: Db, slug: string): Promise<VerifyOutcome> {
  const descriptor = descriptorFor(slug);
  if (!descriptor) throw new Error(`Unknown integration "${slug}".`);

  const { data: integration, error: lookupError } = await db
    .from('integrations')
    .select('id, config, concurrency_source')
    .eq('slug', slug)
    .maybeSingle();

  if (lookupError || !integration) {
    throw new Error(
      `No integrations row for "${slug}". The seed creates one per catalogue entry; ` +
        `this database has not been seeded, or the slug drifted.`,
    );
  }

  const { checks, latencyMs } = await runProbe(db, descriptor);

  // Only the required ones decide. The credit-balance read is informational and failing
  // it must not make an otherwise working credential unusable.
  const required = checks.filter((c) => c.required);
  const ok = required.length > 0 && required.every((c) => c.passed);

  const now = new Date().toISOString();
  const failed = checks.filter((c) => c.required && !c.passed);
  const summary = ok
    ? checks
        .filter((c) => c.passed)
        .map((c) => c.detail)
        .join(' ')
    : failed.map((c) => c.detail).join(' ');

  // Non-secret facts the probe learned — model lists, plan tier, motion counts. Merged
  // rather than replaced: a probe that reads fewer facts than a previous run should not
  // erase what the earlier one established.
  // Round-tripped through JSON rather than cast. `integrations.config` is a jsonb column
  // and a probe returning something unserialisable — a Date, an Error — would be stored as
  // `{}` or throw at the driver. This is the same rule as everywhere else: never assert a
  // shape onto a value that crossed a boundary, make it satisfy the shape.
  const learnedRaw: Record<string, unknown> = Object.assign(
    {},
    ...checks.map((c) => c.config ?? {}),
  );

  const learned: Json = JSON.parse(JSON.stringify(learnedRaw));

  const existingConfig: Json =
    integration.config && typeof integration.config === 'object' && !Array.isArray(integration.config)
      ? integration.config
      : {};

  // Concurrency is promoted out of `config` onto its own columns (0008). The queue reads
  // it at run time and must not have to dig through a jsonb blob for the one number that
  // decides how hard it hits a vendor — and `concurrency_source` is what stops a screen
  // presenting a fallback as a reading.
  const concurrencyLimit =
    typeof learnedRaw.concurrency_limit === 'number' ? learnedRaw.concurrency_limit : null;
  const concurrencySource =
    learnedRaw.concurrency_source === 'tier' || learnedRaw.concurrency_source === 'default'
      ? learnedRaw.concurrency_source
      : null;

  const { error: updateError } = await db
    .from('integrations')
    .update({
      last_checked_at: now,
      // A manual override is never overwritten by a probe. Someone who typed a real limit
      // read off an invoice knows more than a fallback does, and a check re-run should not
      // quietly undo them.
      ...(concurrencyLimit !== null && integration.concurrency_source !== 'manual'
        ? { concurrency_limit: concurrencyLimit, concurrency_source: concurrencySource ?? 'default' }
        : {}),
      // Left untouched on failure. Overwriting it with null would erase the record that
      // this integration *did* work at some point, which is the first thing anyone wants
      // to know when it stops.
      ...(ok ? { last_verified_at: now } : {}),
      last_error: ok ? null : summary.slice(0, 1000),
      config: { ...(existingConfig as object), ...(learned as object) } as Json,
    })
    .eq('id', integration.id);

  if (updateError) throw new Error(`Recording the check result failed: ${updateError.message}`);

  // Current answer per named check. Upserted on (integration_id, check_name) so the UI
  // renders state rather than a log.
  if (checks.length > 0) {
    const { error: checksError } = await db.from('integration_checks').upsert(
      checks.map((c) => ({
        integration_id: integration.id,
        check_name: c.name,
        passed: c.passed,
        detail: c.detail.slice(0, 1000),
        checked_at: now,
      })),
      { onConflict: 'integration_id,check_name' },
    );
    if (checksError) throw new Error(`Recording check details failed: ${checksError.message}`);
  }

  // Append-only. The `verified` / `failed` values come from the CHECK constraint 0003 put
  // on this column so the trail stays groupable.
  await db.from('integration_events').insert({
    integration_id: integration.id,
    event: ok ? 'verified' : 'failed',
    detail: summary.slice(0, 1000),
  });

  return { ok, slug, checks, latencyMs, summary };
}

/**
 * Whether a pipeline task may select this integration.
 *
 * The rule from Addendum 01, unchanged: *an unverified integration cannot be selected by
 * any pipeline task.* Enabled is not sufficient and never was — enabling is a statement of
 * intent, verifying is a statement of fact.
 */
export async function isUsable(db: Db, slug: string): Promise<boolean> {
  const { data } = await db
    .from('integrations')
    .select('is_enabled, last_verified_at')
    .eq('slug', slug)
    .maybeSingle();

  return Boolean(data?.is_enabled && data.last_verified_at);
}
