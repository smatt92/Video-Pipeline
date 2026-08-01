import { z } from 'zod';

import { driverEnvSchema } from './drivers/env';

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

const coreEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── Application ───────────────────────────────────────────────────────────
  /**
   * Public origin of this deployment. Vendors POST their webhooks here, so it has to be
   * reachable from the internet — not localhost. In development use a tunnel and put
   * the tunnel's URL here; a webhook aimed at localhost is silently never delivered,
   * and you will spend an afternoon on it.
   */
  APP_URL: z.url({ error: 'APP_URL must be an absolute URL, e.g. https://kiln.vercel.app' }),

  // ── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: nonEmpty('SUPABASE_ANON_KEY'),
  /**
   * Bypasses row-level security. Server and worker only. If this ever appears in a
   * client component or a NEXT_PUBLIC_ variable, treat it as leaked and rotate it.
   */
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty('SUPABASE_SERVICE_ROLE_KEY'),

  // ── Cloudflare R2 ─────────────────────────────────────────────────────────
  R2_ACCOUNT_ID: nonEmpty('R2_ACCOUNT_ID'),
  R2_ACCESS_KEY_ID: nonEmpty('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: nonEmpty('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET: nonEmpty('R2_BUCKET'),
  /**
   * Public base URL for objects that must be reachable without a signature — an R2
   * custom domain or r2.dev subdomain. Lands in `assets.public_url`.
   */
  R2_PUBLIC_BASE_URL: z.url().optional(),
  R2_ENDPOINT: z.url().optional(),

  // ── Trigger.dev ───────────────────────────────────────────────────────────
  TRIGGER_PROJECT_REF: nonEmpty('TRIGGER_PROJECT_REF'),
  TRIGGER_SECRET_KEY: nonEmpty('TRIGGER_SECRET_KEY'),

  // ── Anthropic ─────────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY: nonEmpty('ANTHROPIC_API_KEY'),

  // ── Driver selection ──────────────────────────────────────────────────────
  /**
   * Which registered driver generates video. Deliberately has no default: the whole
   * point of the driver interface is that this is a config value, and a default here
   * would quietly reinstate a hardcoded vendor (ARCHITECTURE.md §0.1).
   */
  VIDEO_DRIVER: nonEmpty('VIDEO_DRIVER'),

  // ── Cost ──────────────────────────────────────────────────────────────────
  /**
   * USD→INR, snapshotted onto every ledger row so historical rupee figures stay
   * explainable. A live FX feed would make yesterday's cost-per-video change overnight,
   * which is worse than being slightly stale.
   */
  USD_INR_RATE: z.coerce
    .number({ error: 'USD_INR_RATE must be a number, e.g. 88.5' })
    .positive(),

  // ── Driver reliability envelope ───────────────────────────────────────────
  DRIVER_TIMEOUT_MS: positiveInt('DRIVER_TIMEOUT_MS').default(60_000),
  DRIVER_MAX_ATTEMPTS: positiveInt('DRIVER_MAX_ATTEMPTS').default(3),
  /** Consecutive failures before the breaker opens and submits stop being attempted. */
  CIRCUIT_BREAKER_THRESHOLD: positiveInt('CIRCUIT_BREAKER_THRESHOLD').default(5),
  /** How long the breaker stays open before one probe is allowed through. */
  CIRCUIT_BREAKER_COOLDOWN_MS: positiveInt('CIRCUIT_BREAKER_COOLDOWN_MS').default(60_000),
});

const envSchema = coreEnvSchema.extend(driverEnvSchema.shape);

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

  if (value.NODE_ENV === 'production') {
    const host = new URL(value.APP_URL).hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      throw new EnvironmentError(
        `APP_URL is ${value.APP_URL} in production. Vendor webhooks would be delivered ` +
          'to a host only this machine can see, and every generation would hang until it ' +
          'timed out. Set it to the public origin of the deployment.',
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
