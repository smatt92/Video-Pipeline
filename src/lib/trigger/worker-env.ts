import type { Env } from '../env';
import { driverWorkerEnv } from '../drivers/worker-env';
import { storageWorkerEnv } from '../storage/worker-env';

/**
 * What must be set in the Trigger.dev environment before a deploy is worth doing.
 *
 * ── Why this is not the same list as Vercel's ────────────────────────────────
 *
 * The worker is a second deployment target with its own environment, configured in a
 * different dashboard, and nothing has ever said which variables belong in it. The failure
 * that produces is the ffmpeg one exactly: the deploy succeeds, the first run starts, and
 * something the image was never given surfaces as an error naming a variable rather than
 * the configuration step that omitted it — **after** a generation has been paid for.
 *
 * `check:trigger-env` derives what the worker's import graph actually reaches and fails
 * when it reaches something this list does not carry. So the list cannot go stale by
 * omission, which is the way a list like this always goes stale.
 *
 * ── The non-obvious half ─────────────────────────────────────────────────────
 *
 * Five of the entries below are things **no task reads**. They are here because `env` is a
 * Proxy whose every access calls `assertEnv()`, and `assertEnv()` runs
 * `envSchema.safeParse(process.env)` over the *whole* schema. So one `env.USD_INR_RATE` in
 * a task drags in every non-optional field, and a worker with no `ALLOWED_EMAIL` — a
 * variable about signing in to a website the worker is not — throws on the first task that
 * touches configuration at all.
 *
 * That is worth stating rather than fixing: validating the whole schema at once is what
 * gives a boot failure a complete list instead of one variable at a time, and the cost is
 * that the worker inherits requirements it has no use for. A grep for `env.X` under
 * `src/trigger/` therefore *understates* what the environment needs, which is exactly the
 * kind of thing somebody reconstructs wrongly at 1am.
 *
 * ── Vendor variables are composed in, not named here ─────────────────────────
 *
 * CLAUDE.md rule 1: no vendor name outside `src/lib/drivers/`, `src/lib/publish/` or
 * `src/lib/storage/`. `pnpm check:vendors` covers comments too and would refuse this file
 * for naming one. So the vendor and storage halves are declared in their own modules and
 * spread in below — the same shape `src/lib/env.ts` already uses for `driverEnvSchema` and
 * `storageEnvSchema`, for the same reason.
 */

/**
 * The schema's variables, plus the ones a module reads straight from `process.env`.
 *
 * Every one is a deliberate bypass with a reason — the Edge runtime cannot see through a
 * Proxy, or the value belongs to a driver that must work before the schema is asserted —
 * and each still reaches the worker, so the manifest must be able to name it.
 *
 * Enumerated rather than typed as `string`, so the compile error that produced this list
 * keeps happening: `name: keyof Env` rejected `KILN_LOCAL_STORAGE_ROOT` the moment it was
 * declared, which is the type system correctly reporting that the schema does not know
 * about it. Widening to `string` would have silenced that and lost the check on every
 * other entry — a typo'd schema variable would then be a manifest line for a variable that
 * does not exist.
 */
export type WorkerEnvName = keyof Env | 'KILN_LOCAL_STORAGE_ROOT';

export interface WorkerEnvVar {
  readonly name: WorkerEnvName;
  /**
   * True when the Trigger.dev environment must carry it. False means the worker reaches it
   * but functions without it — and the entry exists so that "functions without it" is a
   * recorded claim rather than an assumption.
   */
  readonly required: boolean;
  /** What refuses, or what quietly goes wrong, when it is absent. */
  readonly refusedBy: string;
}

const coreWorkerEnv: readonly WorkerEnvVar[] = [
  // ── Required by the schema, not by any task ─────────────────────────────────
  {
    name: 'APP_URL',
    required: true,
    refusedBy:
      'Nothing on the worker reads it. It is non-optional in the schema, and the schema is '
      + 'validated whole on the first env access, so its absence throws in a task that has '
      + 'no interest in it.',
  },
  {
    name: 'ALLOWED_EMAIL',
    required: true,
    refusedBy:
      'Same: a sign-in allowlist for a website, required by a worker that serves no '
      + 'requests. Set it to the same value as the web deployment so the two cannot drift '
      + 'into disagreeing about who the operator is.',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    required: true,
    refusedBy:
      'Schema-required and unread by the worker, which uses the service-role key. The '
      + 'prefix is a publication decision rather than a hint about who needs it.',
  },

  // ── Read by the worker ──────────────────────────────────────────────────────
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    required: true,
    refusedBy:
      'Every task. It is how the worker finds the database at all, so without it nothing '
      + 'runs and the failure is at least immediate.',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    required: true,
    refusedBy:
      'Every task. The worker has no signed-in user, so row-level security has no subject '
      + 'to apply and the service role is the only way in. Production values only — this '
      + 'must never appear in a Development environment on either target.',
  },
  {
    name: 'WEBHOOK_CALLBACK_BASE_URL',
    required: true,
    refusedBy:
      'Stage 5 refuses to submit without it, because a generation whose completion has '
      + 'nowhere to arrive is one that runs, bills, and is never confirmed. Optional at '
      + 'boot on purpose; not optional here.',
  },
  {
    name: 'VIDEO_DRIVER',
    required: true,
    refusedBy:
      'Stage 4 compiles parameters against the selected driver. It has no default in code '
      + 'on purpose — a default would quietly reinstate a hardcoded vendor, which is the '
      + 'thing the driver interface exists to prevent.',
  },
  {
    name: 'USD_INR_RATE',
    required: true,
    refusedBy:
      'Every path that writes a cost_ledger row, by name, through `requireUsdInrRate` in '
      + 'src/lib/cost/fx.ts. It used to carry `.default(88.5)` and refuse nothing, so a '
      + 'worker without it snapshotted a rate nobody chose onto every money row — this '
      + 'entry was the checklist standing in for a guard. The guard now exists; the entry '
      + 'stays because a checklist is still how it gets set before the first run.',
  },
  {
    name: 'DRIVER_TIMEOUT_MS',
    required: false,
    refusedBy:
      'Defaults to 60s. A default is honest for a timeout — it is a policy this project '
      + 'chose, not a measurement of the world, which is what separates it from the rate '
      + 'above.',
  },

  ...storageWorkerEnv,
  ...driverWorkerEnv,
];

export const WORKER_ENV: readonly WorkerEnvVar[] = coreWorkerEnv;

/** The names that must be present, for a caller that only wants the checklist. */
export function requiredWorkerEnv(): string[] {
  return WORKER_ENV.filter((v) => v.required).map((v) => v.name);
}
