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

export const driverEnvSchema = z.object({
  // ── Higgsfield ────────────────────────────────────────────────────────────
  // The v2 API authenticates with `Authorization: Key <KEY_ID>:<KEY_SECRET>`. The SDK
  // will also read HF_CREDENTIALS from the process env on its own; we deliberately do
  // not rely on that, so that a missing credential is caught by the startup check
  // rather than by a 401 in the middle of a fan-out.
  HIGGSFIELD_API_KEY: nonEmpty('HIGGSFIELD_API_KEY'),
  HIGGSFIELD_API_SECRET: nonEmpty('HIGGSFIELD_API_SECRET'),

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
  ),

  HIGGSFIELD_API_BASE_URL: z.url().default('https://platform.higgsfield.ai'),

  // ── fal.ai ────────────────────────────────────────────────────────────────
  // The second driver. Its job is to keep the interface honest; it is not on the
  // critical path, so it may be absent in environments that only exercise the primary.
  FAL_KEY: nonEmpty('FAL_KEY').optional(),
});

export type DriverEnv = z.infer<typeof driverEnvSchema>;
