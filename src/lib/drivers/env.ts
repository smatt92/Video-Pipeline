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
  // ── Higgsfield — dormant failover since 0015, optional ────────────────────
  // Routed to by the Bureau only with GENERATION_FAILOVER=on; still the vendor of the
  // legacy concept → script lane (05-generate), which refuses without these by name.
  // The v2 API authenticates with `Authorization: Key <KEY_ID>:<KEY_SECRET>`. The SDK
  // will also read HF_CREDENTIALS from the process env on its own; we deliberately do
  // not rely on that, so that a missing credential is caught by the startup check
  // rather than by a 401 in the middle of a fan-out.
  // Canonical names. The two below them are the previous names, still accepted as an env
  // fallback by resolveCredentials (catalogue `envAliases`).
  HIGGSFIELD_API_KEY_ID: nonEmpty('HIGGSFIELD_API_KEY_ID').optional(),
  HIGGSFIELD_API_KEY_SECRET: nonEmpty('HIGGSFIELD_API_KEY_SECRET').optional(),
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

  // ── ElevenLabs (direct) ───────────────────────────────────────────────────
  // Optional since plan v2.2: only a character whose bible entry sets
  // voice.provider = "elevenlabs" reaches the direct vendor. Local-development fallback
  // only, like the others; the authoritative source is the integration record (Vault).
  ELEVENLABS_API_KEY: nonEmpty('ELEVENLABS_API_KEY').optional(),

  // ── fal.ai ────────────────────────────────────────────────────────────────
  // Dormant failover since 0015, routed to only with GENERATION_FAILOVER=on. Optional, and
  // its absence blocks nothing.
  FAL_KEY: nonEmpty('FAL_KEY').optional(),

  // ── The two keys the Bureau needs (decision 0015) ─────────────────────────
  // REQUIRED to run the pipeline — onboarding steps 4/5 (generation + voice) and 11
  // (embeddings) do not complete without them, and every stage that needs one refuses by
  // name without it. Optional in THIS schema for the reason at the top of the file: it is
  // validated at boot on Vercel, and a credential only the wizard can supply cannot also be
  // a precondition for reaching the wizard (the 500-on-every-route incident).
  //
  // Embeddings only, free tier. Without it variation_check refuses every brief, by name.
  GEMINI_API_KEY: nonEmpty('GEMINI_API_KEY').optional(),
  // All generation: character beats, money shots, reference frames, voice, dubs, SFX,
  // Act-Two. Runway API credits, a separate pool from Runway app credits.
  RUNWAY_API_KEY: nonEmpty('RUNWAY_API_KEY').optional(),
  // "off" (default) or "on". Off: every generated route goes to the generation vendor only.
  // On: the dormant vendors above follow it as failover. Read by `failoverEnabled()` in
  // jobs.ts, which parses this same enum.
  GENERATION_FAILOVER: z.enum(['off', 'on']).default('off'),
  // Notifications (briefs pending, cuts ready, cap at 80%, policy and QC alerts).
  SLACK_WEBHOOK_URL: z.url().optional(),
  // Reels mirror; publishing stays disabled by channel_policy until app review clears.
  META_IG_USER_ID: nonEmpty('META_IG_USER_ID').optional(),
  META_ACCESS_TOKEN: nonEmpty('META_ACCESS_TOKEN').optional(),
});

export type DriverEnv = z.infer<typeof driverEnvSchema>;
