import type { BuildContext, BuildExtension, BuildLayer } from '@trigger.dev/build/extensions';
import { syncVercelEnvVars } from '@trigger.dev/build/extensions/core';

import { workerCredentialFields } from '../drivers/catalog';
import {
  VERCEL_PROJECT,
  VERCEL_TEAM_ID,
  listVercelEnv,
  vercelEnvProblems,
  type RequiredName,
} from './vercel-env-check';
import { requiredWorkerEnv } from './worker-env';

/**
 * The worker's environment, copied from Vercel production at deploy (decision 0017).
 *
 * Sahil keeps every secret in Vercel's production environment and does not want to enter
 * them a second time in the Trigger.dev dashboard. `syncVercelEnvVars` does the copy. This
 * wraps it, because reading its source (`@trigger.dev/build` 4.5.9) showed three ways it
 * reports success having copied nothing:
 *
 *   1. Its callback **throws** on a missing token or project id, and `syncEnvVars` catches
 *      that into `logger.warn` and returns nothing — "No env vars detected", deploy continues.
 *   2. Anything thrown from an extension's `onBuildComplete` is caught again by the CLI
 *      (`notifyExtensionOnBuildComplete`: `logger.error`, carry on). So a wrapper that throws
 *      *there* is no better.
 *   3. It drops, silently, every variable whose value it cannot read — and Vercel never
 *      returns a value for a `sensitive` variable. See `vercel-env-check.ts`.
 *
 * The deploy that results looks green and its first run dies naming a variable, after the
 * generated clips it was assembling were paid for. So:
 *
 *   onBuildStart     — not wrapped in a try by the CLI: a throw here fails the deploy. Refuses
 *                      without VERCEL_ACCESS_TOKEN, and refuses when Vercel production lacks a
 *                      required name or holds it as Sensitive. Names only, no values.
 *   onBuildComplete  — production only. Runs the real extension, watches the layer it adds,
 *                      and if a required name did not arrive, exits the process: the build
 *                      precedes the deployment record, so nothing is half-created.
 *
 * ── What the deploy needs, and from where ────────────────────────────────────
 *
 *   VERCEL_ACCESS_TOKEN  in the shell running the deploy (the only thing Sahil sets). A
 *                        Vercel token scoped to the sahilmatt-6245s-projects team. What the
 *                        sync uploads to Trigger.dev is the Vercel listing (minus `TRIGGER_*`
 *                        names, which it strips), so the token goes nowhere unless it is
 *                        itself a Vercel variable — keep it out of Vercel.
 *   project, team        constants in vercel-env-check.ts; VERCEL_PROJECT_ID / VERCEL_TEAM_ID
 *                        override them if ever set.
 *   TRIGGER_PROJECT_REF  as before (trigger.config.ts reads it), plus `trigger.dev login`.
 *
 * Production only, as asked. The extension maps staging and preview to Vercel's preview
 * target; this does not sync those at all.
 */

const SYNC_LAYER_ID = 'sync-env-vars';

/** The CLI's `--env` / `-e`, default `prod` — the only place onBuildStart can learn it. */
export function deployEnvironmentFromArgv(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--env' || a === '-e') return argv[i + 1] ?? 'prod';
    if (a.startsWith('--env=')) return a.slice('--env='.length);
  }
  return 'prod';
}

/** The manifest's required names and the Bureau credentials, deduplicated. */
export function requiredForWorker(): RequiredName[] {
  const out = new Map<string, RequiredName>();
  for (const name of requiredWorkerEnv()) {
    out.set(name, { name, why: 'required by the worker env manifest' });
  }
  for (const f of workerCredentialFields()) {
    if (!out.has(f.key)) {
      out.set(f.key, { name: f.key, aliases: f.aliases, why: `the ${f.slug} credential, resolved from the environment when Vault does not hold it` });
    }
  }
  return [...out.values()];
}

function refuse(lines: string[]): never {
  throw new Error(['Refusing to deploy: the worker environment would not come from Vercel.', '', ...lines].join('\n'));
}

export function vercelEnv(): BuildExtension {
  const required = requiredForWorker();
  let preflighted = false;

  const projectId = () => process.env.VERCEL_PROJECT_ID?.trim() || VERCEL_PROJECT;
  const teamId = () => process.env.VERCEL_TEAM_ID?.trim() || VERCEL_TEAM_ID;

  return {
    name: 'kiln-vercel-env',

    async onBuildStart(context: BuildContext) {
      if (context.target === 'dev') return;
      const environment = deployEnvironmentFromArgv(process.argv);
      if (environment !== 'prod') {
        context.logger.log(`Vercel env sync: skipped for --env ${environment} (production only).`);
        return;
      }

      const token = process.env.VERCEL_ACCESS_TOKEN?.trim();
      if (!token) {
        refuse([
          'VERCEL_ACCESS_TOKEN is not set in this shell.',
          'Create one at vercel.com/account/settings/tokens, scoped to the sahilmatt-6245s-projects',
          'team, and run:  VERCEL_ACCESS_TOKEN=… pnpm trigger:deploy',
        ]);
      }

      const listing = await listVercelEnv({ token, projectId: projectId(), teamId: teamId() });
      if (!listing.ok) {
        refuse([
          `Listing ${projectId()}'s production variables failed (HTTP ${listing.status ?? 'none'}).`,
          listing.detail,
          'A 403 naming a scope means the token was created for a different team.',
        ]);
      }

      const problems = vercelEnvProblems(listing.entries, required);
      if (problems.length > 0) refuse(problems.map((p) => `✗ ${p.detail}`));

      preflighted = true;
      context.logger.log(`Vercel env sync: all ${required.length} required names present in production and readable.`);
    },

    async onBuildComplete(context, manifest) {
      if (context.target === 'dev') return;
      if (manifest.environment !== 'prod') {
        context.logger.log(`Vercel env sync: not syncing to ${manifest.environment} (production only).`);
        return;
      }
      // Errors from here on are caught and logged by the CLI, and the deploy carries on. So
      // a failure ends the process instead: the build runs before the deployment record is
      // created, and nothing is left half-made.
      const fail = (msg: string): never => {
        console.error(`\n✗ Vercel env sync: ${msg}\n  Deploy stopped before anything was created.\n`);
        process.exit(1);
      };
      if (!preflighted) {
        fail('the build is for production but the pre-build check did not run — --env was read differently from the manifest.');
      }

      let layer: BuildLayer | null = null;
      const watching: BuildContext = {
        ...context,
        addLayer(l: BuildLayer) {
          if (l.id === SYNC_LAYER_ID) layer = l;
          context.addLayer(l);
        },
      };
      await syncVercelEnvVars({
        projectId: projectId(),
        vercelTeamId: teamId(),
        vercelAccessToken: process.env.VERCEL_ACCESS_TOKEN?.trim(),
      }).onBuildComplete?.(watching, manifest);

      const synced = new Set(Object.keys((layer as BuildLayer | null)?.deploy?.env ?? {}));
      const missing = required.filter((r) => ![r.name, ...(r.aliases ?? [])].some((n) => synced.has(n)));
      if (missing.length > 0) {
        fail(`${missing.length} required name(s) did not arrive from Vercel: ${missing.map((m) => m.name).join(', ')}.`);
      }
      context.logger.log(`Vercel env sync: ${synced.size} variables from Vercel production, every required one among them.`);
    },
  };
}
