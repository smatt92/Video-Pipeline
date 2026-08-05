import { z } from 'zod';

import { driverEnvSchema } from './drivers/env';
import { storageEnvSchema } from './storage/env';

/**
 * The single place process.env is read.
 *
 * Two properties matter here. First, nothing in this file names a vendor — vendor
 * credentials are declared in `src/lib/drivers/env.ts` and composed in below, so that
 * CLAUDE.md rule 1 holds for the application's own configuration and not just its call
 * sites. Second, a missing or malformed variable is a startup failure with a complete
 * list of what is wrong, not a `undefined` that surfaces four layers down as a 401 in
 * the middle of a fan-out.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is set but empty`);

const positiveInt = (label: string) =>
  z.coerce.number({ error: `${label} must be a number` }).int().positive();

/**
 * ── Bootstrap versus everything else ─────────────────────────────────────────
 *
 * This schema used to require every vendor credential, and that was correct when it was
 * written and is wrong now. Migration 0003 moved credentials into the `integrations` table
 * behind Vault, and says so plainly: *"a driver is built per-call from an integration
 * record, never from module-level process.env. Environment keeps two jobs only — bootstrap
 * and CI."* The schema never followed.
 *
 * The consequence was not theoretical. `instrumentation.ts` asserts this schema at server
 * boot, so a deployment missing a video-vendor key — which is the *normal* state before
 * anyone has walked the onboarding wizard, since the wizard is what puts it in Vault —
 * failed to boot and returned 500 on every route, including the wizard that would have
 * fixed it. A chicken-and-egg deadlock produced entirely by a schema that had not caught
 * up with its own storage decision.
 *
 * So: `BOOTSTRAP` is what the process genuinely cannot start without. Everything else is
 * optional here and resolved from the integration record at the point of use, with the
 * environment as a local-development fallback. A caller that genuinely cannot proceed
 * without one refuses where it is used — `submitShots` and `src/lib/cost/fx.ts` are the two
 * that do, each with a message naming the operation rather than the variable alone.
 */
const coreEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── Application ───────────────────────────────────────────────────────────
  /**
   * Origin of *this* deployment. On a preview build this is the preview URL, and that is
   * fine — it is used for links and redirects, not for callbacks.
   */
  APP_URL: z.url({ error: 'APP_URL must be an absolute URL, e.g. https://kiln.vercel.app' }),

  /**
   * Stable public origin that vendors POST webhooks to. Deliberately separate from
   * APP_URL and deliberately not derived from VERCEL_URL.
   *
   * Preview deployments get a new hostname on every commit, so a webhook registered
   * against one dies on the next push — and it dies silently, because the vendor gets a
   * DNS failure and we get nothing at all. Point this at the production domain, or at a
   * tunnel in local development. A callback aimed at localhost is never delivered and
   * every generation hangs until it times out.
   *
   * Optional at boot, required at the moment a generation is submitted — `submitShots`
   * refuses on it by name, where a harness can drive the refusal. A deployment that never
   * submits a generation (a preview being used to walk the onboarding wizard, for instance)
   * has no use for it, and refusing to boot without it means the wizard that configures
   * everything else cannot run.
   */
  WEBHOOK_CALLBACK_BASE_URL: z
    .url({ error: 'WEBHOOK_CALLBACK_BASE_URL must be an absolute, publicly reachable URL' })
    .optional(),

  /**
   * The addresses permitted to sign in — a comma-separated list.
   *
   * Settings is the highest-value target in the app; it holds every vendor credential. "Is
   * authenticated" is not a sufficient gate when anyone can sign themselves up against a
   * public Supabase project.
   *
   * This was `z.email()`, a single address, and that was a real hazard rather than merely
   * a limitation. `assertEnv()` validates the *whole* schema and throws if any field fails,
   * so one comma in this variable made `serverClient()` throw — taking down every Server
   * Action and every settings page, for a value the gate itself reads through a different
   * path and would have handled. A field whose malformation breaks unrelated subsystems is
   * validated at the wrong altitude.
   *
   * Validated loosely here, strictly in `src/lib/auth/config.ts`, which parses the list,
   * drops malformed entries individually and names them. The gate is the place that cares.
   */
  ALLOWED_EMAIL: nonEmpty('ALLOWED_EMAIL').refine(
    (v) => v.split(',').some((e) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e.trim())),
    'ALLOWED_EMAIL must contain at least one email address (comma-separated for several)',
  ),

  // ── Supabase ──────────────────────────────────────────────────────────────
  // These two are the only variables in the entire schema allowed a NEXT_PUBLIC_ prefix.
  // Next inlines anything so prefixed into the client bundle at build time, which makes
  // the prefix a publication decision, not a naming convention. `pnpm check:public-env`
  // fails the build if a third one ever appears.
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  /**
   * Bypasses row-level security entirely. Server and worker only, and Production only —
   * it must never be set in a Development environment on either deploy target. If it ever
   * acquires a NEXT_PUBLIC_ prefix or appears in a client bundle, treat it as leaked and
   * rotate it immediately.
   */
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty('SUPABASE_SERVICE_ROLE_KEY'),

  // ── Object storage ────────────────────────────────────────────────────────
  // Vendor-specific storage configuration is declared in `src/lib/storage/env.ts` and
  // composed in below, for the same reason driver credentials are: nothing in the core
  // of the application should know which object store is behind the interface.

  // ── Trigger.dev ───────────────────────────────────────────────────────────
  // Optional at boot: the Next app enqueues but does not run tasks, and a preview being
  // used to walk the onboarding wizard enqueues nothing. Nothing guards the enqueue: the
  // Trigger SDK fails on its own if the key is absent, which is legible enough and is the
  // honest description rather than naming a mechanism that does not exist.
  TRIGGER_PROJECT_REF: nonEmpty('TRIGGER_PROJECT_REF').optional(),
  TRIGGER_SECRET_KEY: nonEmpty('TRIGGER_SECRET_KEY').optional(),

  // ── Anthropic ─────────────────────────────────────────────────────────────
  // Local-development fallback only. The authoritative source is the `anthropic`
  // integration record, whose credential lives in Vault — see resolveCredential().
  ANTHROPIC_API_KEY: nonEmpty('ANTHROPIC_API_KEY').optional(),

  /**
   * Signing key for the bearer token the Studio lane mints per session.
   *
   * `/api/mcp` is publicly reachable by necessity — the Messages API's MCP connector
   * fetches it from Anthropic's infrastructure, so it cannot sit behind the sign-in
   * middleware. Its authentication is therefore this token and nothing else, and the token
   * is scoped to one session so that a leaked one grants that session rather than every
   * tool in the workspace.
   *
   * Optional at boot for the same reason the rest of this section is: a deployment that
   * never opens a Studio session does not need it. `studio/actions.ts` checks it at the
   * moment a session tries to start and returns a message rather than throwing, and the route refuses every request while it is unset —
   * accepting unauthenticated tool calls because the key is missing would make the
   * deployment's security depend on nobody finding the URL.
   */
  STUDIO_MCP_TOKEN_SECRET: nonEmpty('STUDIO_MCP_TOKEN_SECRET').optional(),

  // ── Driver selection ──────────────────────────────────────────────────────
  /**
   * Which registered driver generates video. Deliberately has no default: the whole
   * point of the driver interface is that this is a config value, and a default here
   * would quietly reinstate a hardcoded vendor (ARCHITECTURE.md §0.1).
   */
  VIDEO_DRIVER: nonEmpty('VIDEO_DRIVER').optional(),

  // ── Cost ──────────────────────────────────────────────────────────────────
  //
  // Nothing. `USD_INR_RATE` used to live here and is gone — not deprecated, removed.
  // The rate is `profiles.usd_inr_rate`, an operational value the operator sets and
  // changes without a redeploy, which is what the wizard's own copy always described and
  // what migration 0005's column comment said from the day the column existed. Two
  // configured rates is how one of them ended up doing nothing while the operator believed
  // otherwise, so the loser does not get to survive as a fallback. See src/lib/cost/fx.ts.
  /**
   * USD→INR, snapshotted onto every ledger row so historical rupee figures stay
   * explainable. A live FX feed would make yesterday's cost-per-video change overnight,
   * which is worse than being slightly stale.
   */
  // ── Driver reliability envelope ───────────────────────────────────────────
  DRIVER_TIMEOUT_MS: positiveInt('DRIVER_TIMEOUT_MS').default(60_000),
  DRIVER_MAX_ATTEMPTS: positiveInt('DRIVER_MAX_ATTEMPTS').default(3),
  /** Consecutive failures before the breaker opens and submits stop being attempted. */
  CIRCUIT_BREAKER_THRESHOLD: positiveInt('CIRCUIT_BREAKER_THRESHOLD').default(5),
  /** How long the breaker stays open before one probe is allowed through. */
  CIRCUIT_BREAKER_COOLDOWN_MS: positiveInt('CIRCUIT_BREAKER_COOLDOWN_MS').default(60_000),
});

const envSchema = coreEnvSchema.extend(driverEnvSchema.shape).extend(storageEnvSchema.shape);

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

function format(issues: z.core.$ZodIssue[]): string {
  const lines = issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    const missing = issue.code === 'invalid_type' && !(key in process.env);
    return `  ${key}: ${missing ? 'missing' : issue.message}`;
  });

  return [
    `Environment validation failed — ${issues.length} problem${issues.length === 1 ? '' : 's'}:`,
    '',
    ...lines,
    '',
    'Every variable is documented in .env.example. Copy it to .env.local and fill it in.',
    'Nothing starts until this is clean: a half-configured pipeline spends real money',
    'before it discovers what is missing.',
  ].join('\n');
}

/**
 * Validate the environment and return it. Throws with the complete list of problems —
 * all of them, not just the first — so one run of the process tells you everything you
 * need to fix.
 */
export function assertEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new EnvironmentError(format(parsed.error.issues));
  }

  const value = parsed.data;

  // Only when it is set. Absent is legitimate now — nothing has submitted a generation
  // yet, and `submitShots` refuses at the point that does. Set-and-pointed-at-localhost
  // is still worth refusing at boot, because that one looks configured.
  if (value.NODE_ENV === 'production' && value.WEBHOOK_CALLBACK_BASE_URL) {
    const callbackHost = new URL(value.WEBHOOK_CALLBACK_BASE_URL).hostname;
    if (callbackHost === 'localhost' || callbackHost === '127.0.0.1') {
      throw new EnvironmentError(
        `WEBHOOK_CALLBACK_BASE_URL is ${value.WEBHOOK_CALLBACK_BASE_URL} in production. ` +
          'Vendor webhooks would be delivered to a host only this machine can see, every ' +
          'generation would hang until it timed out, and nothing would say why. Set it to ' +
          'the production domain.',
      );
    }
  }

  cached = value;
  return value;
}

/**
 * Lazily-validated environment. Reading any property triggers validation, so importing
 * this module during a build that has no secrets does not explode; the first actual read
 * at runtime does.
 */
export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return assertEnv()[prop as keyof Env];
  },
  has(_target, prop: string) {
    return prop in assertEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(assertEnv());
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    return Object.getOwnPropertyDescriptor(assertEnv(), prop);
  },
});

/** Reset memoisation. Tests only. */
export function resetEnvCache(): void {
  cached = null;
}
