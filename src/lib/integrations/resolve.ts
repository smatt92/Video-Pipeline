import { primaryForKind } from '../drivers/catalog';
import type { Db } from '../db/server';
import { resolveCredentials } from './credentials';

/**
 * The driver for a capability, with its secrets and its concurrency ceiling.
 *
 * ── Why this exists rather than four lines in each task ──────────────────────
 *
 * Stage 5 and stage 6 each opened with the same shape: pick the primary integration for a
 * capability, throw if there is none, fetch each secret field, throw if one is missing, then
 * read the concurrency limit off the row. Written twice, and — more to the point — written
 * **inside a Trigger task**, where no harness can reach it. Every refusal in that sequence
 * was unreachable rather than merely unexercised.
 *
 * The rule that follows from that: a task's job is to *resolve* configuration and hand it
 * down; deciding whether the configuration is sufficient belongs in a library function a
 * harness can drive. This is that function. The tasks keep one `throw`, which is a rethrow
 * of a named refusal and contains no decision of its own.
 *
 * ── By capability, never by name ─────────────────────────────────────────────
 *
 * `kind` is 'video' or 'audio', not a vendor. Swapping vendors is a catalogue row, and rule
 * 1 means this file could not name one even if it wanted to.
 *
 * ── Refusals, not exceptions ─────────────────────────────────────────────────
 *
 * Each returns a code and a sentence naming what to do. A missing credential and an absent
 * catalogue entry send a person to two different screens, and a single "configuration error"
 * makes them do the diagnosis themselves.
 */

export type ResolvedDriver =
  | {
      ok: true;
      slug: string;
      /** In the catalogue's field order, so a caller can destructure positionally. */
      secrets: string[];
      /** Null when the integration row does not exist; callers apply their own floor. */
      concurrencyLimit: number | null;
      concurrencySource: string | null;
    }
  | { ok: false; code: string; detail: string };

/**
 * `needed` is a count of leading `secretFields`, not a list of names, and that is deliberate:
 * the field keys carry the vendor's name, so a caller outside the driver layer cannot say
 * them without `pnpm check:vendors` refusing it. The catalogue's field order is the contract.
 *
 * It exists because requiring *every* field was wrong in a way the harness caught. The video
 * integration has three — key, secret, and the webhook shared secret — and the third is
 * resolved through the driver layer and refused by `submitShots` with a message about a
 * generation whose completion has nowhere to arrive. Demanding it here would have thrown
 * first, with a worse message, and left that refusal a branch production could never enter:
 * a guard made vacuous by a stricter guard upstream of it.
 */
export async function resolveDriver(
  db: Db,
  kind: 'video' | 'audio',
  needed?: number,
): Promise<ResolvedDriver> {
  const descriptor = primaryForKind(kind);

  if (!descriptor) {
    return {
      ok: false,
      code: 'no_primary_integration',
      detail:
        `No integration in the catalogue is marked primary for ${kind}, so there is nothing `
        + 'to call. This is a catalogue defect rather than a configuration one — the '
        + 'migrations create these rows, so a missing one means they have not fully applied.',
    };
  }

  const resolved = await resolveCredentials(db, descriptor.slug);
  const secrets: string[] = [];

  const fields = descriptor.secretFields.slice(0, needed ?? descriptor.secretFields.length);

  for (const field of fields) {
    const value = resolved.values[field.key];
    if (!value) {
      return {
        ok: false,
        code: 'no_credential',
        detail:
          `No credential for ${field.key} on the "${descriptor.slug}" integration. `
          + 'Credentials live in Vault through the onboarding wizard, with the environment '
          + 'as a local-development fallback; neither has it. Settings → Integrations.',
      };
    }
    secrets.push(value);
  }

  // Read, never assumed. `concurrency_source` records whether the number is a reading or a
  // fallback, so a screen can say which — and null here means the row is absent rather than
  // that the ceiling is zero.
  const { data: row } = await db
    .from('integrations')
    .select('concurrency_limit, concurrency_source')
    .eq('slug', descriptor.slug)
    .maybeSingle();

  return {
    ok: true,
    slug: descriptor.slug,
    secrets,
    concurrencyLimit: row?.concurrency_limit ?? null,
    concurrencySource: row?.concurrency_source ?? null,
  };
}
