import { defineConfig } from '@trigger.dev/sdk';

/**
 * Trigger.dev v4.
 *
 * The spec says v3 (CLAUDE.md, ARCHITECTURE.md §1). v4 is the current major; v3 is
 * frozen at 3.3.17. Deviation recorded in docs/decisions/0001-trigger-dev-v4.md.
 *
 * This is where the pipeline actually runs. Everything Vercel cannot do lives here:
 * long-running orchestration, ffmpeg, Remotion, and the `wait.forToken()` parking that
 * lets a task sleep until a vendor webhook wakes it (ARCHITECTURE.md §2).
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  runtime: 'node',
  logLevel: 'info',

  /**
   * Retries here cover infrastructure faults — a container dying, a network partition.
   * They are not the driver's retry policy: a driver call that fails is recorded as a
   * row and retried under the circuit breaker, because a blind task-level retry of a
   * submit spends money twice. That is what the idempotency key defends against, and
   * defence in depth is not a reason to lean on it.
   */
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },

  /**
   * A generation can sit queued at the vendor for a long time and the task parks on a
   * wait token for all of it. One hour is a ceiling, not an expectation — a run that
   * actually reaches it means the webhook never arrived, and it should fail as a row
   * rather than hang forever.
   */
  maxDuration: 3_600,

  dirs: ['./src/trigger'],
});
