import { z } from 'zod';

/**
 * Vendor credentials and vendor-specific tuning.
 *
 * This lives inside `src/lib/drivers/` for the same reason every other vendor detail
 * does (CLAUDE.md rule 1): the moment a vendor's name appears in `src/lib/env.ts`, the
 * core of the application knows which vendor it is talking to, and swapping drivers
 * stops being a config change. `src/lib/env.ts` composes this schema without naming
 * anything in it.
 */

const nonEmpty = (label: string) =>
  z.string().trim().min(1, `${label} is set but empty`);

/**
 * All optional, and that is the point.
 *
 * Migration 0003 moved credentials into the `integrations` table behind Vault: a driver is
 * built per-call from an integration record, not from module-level process.env. These stay
 * as a local-development and CI fallback so a developer can run a task without walking the
 * wizard first — `resolveCredential()` in src/lib/integrations/ prefers Vault and falls
 * back to here.
 *
 * They were required until a deployment with none of them set failed to boot and served
 * 500 on every route, including the onboarding wizard whose entire job is to fill them in.
 * A required credential that only the wizard can supply cannot also be a precondition for
 * reaching the wizard.
 */
export const driverEnvSchema = z.object({
  // ── Higgsfield ────────────────────────────────────────────────────────────
  // The v2 API authenticates with `Authorization: Key <KEY_ID>:<KEY_SECRET>`. The SDK
  // will also read HF_CREDENTIALS from the process env on its own; we deliberately do
  // not rely on that, so that a missing credential is caught by the startup check
  // rather than by a 401 in the middle of a fan-out.
  HIGGSFIELD_API_KEY: nonEmpty('HIGGSFIELD_API_KEY').optional(),
  HIGGSFIELD_API_SECRET: nonEmpty('HIGGSFIELD_API_SECRET').optional(),

  /**
   * Shared secret handed to Higgsfield with each submit and returned to us on the
   * webhook as an `X-Webhook-Secret-Key` header.
   *
   * Note what this is not: Higgsfield does not HMAC-sign webhook bodies. There is no
   * signature to verify — only a bearer secret to compare. Treat it as a password,
   * rotate it if it leaks, and never log it. Minimum length is ours, not theirs.
   */
  HIGGSFIELD_WEBHOOK_SECRET: nonEmpty('HIGGSFIELD_WEBHOOK_SECRET').min(
    32,
    'HIGGSFIELD_WEBHOOK_SECRET must be at least 32 chars — it is the only thing ' +
      'standing between the internet and a forged "your generation succeeded" callback',
  ).optional(),

  HIGGSFIELD_API_BASE_URL: z.url().default('https://platform.higgsfield.ai'),

  // ── ElevenLabs ────────────────────────────────────────────────────────────
  // Local-development fallback only, like the others. The authoritative source is the
  // integration record, whose credential lives in Vault.
  ELEVENLABS_API_KEY: nonEmpty('ELEVENLABS_API_KEY').optional(),

  // ── fal.ai ────────────────────────────────────────────────────────────────
  // The second driver. Its job is to keep the interface honest; it is not on the
  // critical path, so it may be absent in environments that only exercise the primary.
  FAL_KEY: nonEmpty('FAL_KEY').optional(),
});

export type DriverEnv = z.infer<typeof driverEnvSchema>;
