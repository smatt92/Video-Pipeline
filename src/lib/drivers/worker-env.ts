import type { WorkerEnvVar } from '../trigger/worker-env';

/**
 * The vendor half of the worker's environment manifest.
 *
 * Here rather than in `src/lib/trigger/worker-env.ts` because CLAUDE.md rule 1 forbids a
 * vendor name outside this directory, and `pnpm check:vendors` is case-insensitive and
 * covers comments — it has already refused a comment that named a vendor while explaining
 * why not to. Composed in by the trigger manifest, exactly as `driverEnvSchema` is composed
 * into `src/lib/env.ts`.
 *
 * ── Why almost none of these are required ────────────────────────────────────
 *
 * Migration 0003 moved vendor credentials into the `integrations` table behind Vault, and
 * a driver is built per call from an integration record rather than from module-level
 * `process.env`. The environment keeps two jobs only: bootstrap and CI. So a deployed
 * worker with none of these set is the **normal** state, and setting them is what
 * reintroduces a stale local value in preference to the configured one.
 *
 * The webhook secret is the exception, and only for the receiving half — see below.
 */
export const driverWorkerEnv: readonly WorkerEnvVar[] = [
  {
    name: 'HIGGSFIELD_WEBHOOK_SECRET',
    required: false,
    refusedBy:
      'Stage 5 refuses to submit without a shared secret, but it resolves that from the '
      + 'integration record first and falls back to the environment. Set it here only if '
      + 'the integration record does not carry it — and if that is the case, the onboarding '
      + 'wizard was not finished, which is the thing to fix instead.',
  },
  {
    name: 'HIGGSFIELD_API_BASE_URL',
    required: false,
    refusedBy:
      'Nothing. It overrides the vendor default and exists so a harness can point the '
      + 'driver at a stub HTTP surface rather than at the real one.',
  },
];
