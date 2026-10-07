import { additionalFiles, aptGet, ffmpeg } from '@trigger.dev/build/extensions/core';

import { headlessShell } from './src/lib/trigger/headless-shell';
import { vercelEnv } from './src/lib/trigger/vercel-env';
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
  /**
   * Node 22, not the default. `runtime: 'node'` runs the worker on Node 21, which has no global
   * WebSocket; supabase-js constructs its realtime client on createClient and throws
   * "Node.js detected but native WebSocket not found" — every task that touches the database
   * failed on its first line (first real run, 06-Oct, 20-episode: three attempts in 13 s).
   * CI already runs on 22, so this makes the worker match what is tested.
   */
  runtime: 'node-22',
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

  /**
   * ffmpeg on the worker image.
   *
   * `05b-ingest` and `07-assemble` shell out to `ffmpeg` and `ffprobe`, and Trigger's
   * default image carries neither. Without this the first ingest fails with
   * `spawn ffmpeg ENOENT` — **after** the generation has been paid for, which is the
   * whole reason it is declared now rather than discovered then.
   *
   * ** UNVERIFIED. ** This extension has never been executed: exercising it means running
   * a deploy, and the deploy needs an account this environment does not have. A config
   * error surfaces at build time and costs a minute; a runtime error surfaces after money
   * moved. Declaring it is the cheaper failure of the two. See 0008 §7.
   */
  /**
   * ffmpeg, and a browser Remotion can actually drive.
   *
   * `headlessShell()` is ours because no shipped extension installs the right browser —
   * `puppeteer()` installs Chrome-stable, which supports only *new* headless mode and which
   * Remotion refuses. See that file for why the wrong browser is worse than none.
   */
  /**
   * espeak-ng: the reference voice for forced alignment (src/lib/voice/align.ts). The voice
   * vendor returns no word timings (decision 0013), and shot durations are derived from
   * them. `aptGet` was read before adding it: its whole effect is an image layer running
   * `apt-get install` on the named packages, in deploy builds only. UNVERIFIED like the
   * rest of this block until a deploy runs (0008).
   */
  /**
   * The worker's environment, from Vercel production (decision 0017). `syncVercelEnvVars`,
   * wrapped: its source showed it reporting success having copied nothing in three different
   * ways, and `vercelEnv()` turns each into a refused deploy. Needs VERCEL_ACCESS_TOKEN in the
   * deploying shell and nothing in the Trigger.dev dashboard. UNVERIFIED until the first
   * deploy runs it (0008 §17).
   */
  /**
   * Remotion, kept out of esbuild. The bundler (rspack + webpack internals) breaks when
   * esbuild bundles it — S001's first render failed with "Assignment to constant variable."
   * (07-Oct), reproduced locally the same way and fixed the same way. The renderer ships
   * platform binaries (the compositor), which an external installs for the image's platform.
   * The site itself is prebuilt in CI (`pnpm remotion:bundle`) and copied in, so the worker
   * never bundles at render time.
   */
  build: {
    external: ['@remotion/bundler', '@remotion/renderer'],
    extensions: [ffmpeg(), aptGet({ packages: ['espeak-ng'] }), headlessShell(), vercelEnv(), additionalFiles({ files: ['remotion-bundle/**'] })],
  },

  dirs: ['./src/trigger'],
});
