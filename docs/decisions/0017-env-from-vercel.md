# 0017 — Vercel is the single source of secrets; the worker's environment is synced from it

**Date:** 2026-10-06
**Status:** built and tested against stub fetches; **not executed** — the sync first runs on
the first `pnpm trigger:deploy` (0008 §17)

## Decision

Kiln is personal-use. Every secret lives in **Vercel → video-pipeline → Settings →
Environment Variables → Production**, entered once. Nothing is typed into the Trigger.dev
dashboard, and Vault (Settings → Integrations fields) is optional.

- **Web (Vercel)** reads them as it always has. Integration verify already falls back to
  `process.env` (`src/lib/integrations/credentials.ts`: Vault first, environment second), and
  on 06-Oct "Save and test" with empty fields verified supabase-storage, anthropic, runway and
  gemini from Vercel's env.
- **Worker (Trigger.dev)** gets a copy at deploy: `syncVercelEnvVars` from
  `@trigger.dev/build/extensions/core`, production only, wrapped by `vercelEnv()` in
  `src/lib/trigger/vercel-env.ts` and registered in `trigger.config.ts`.
- **Verified status still takes one click per integration.** A key in the environment is a
  key, not a verification: the stages refuse an integration that has never verified (the same
  predicate the Settings banner counts with — `src/lib/integrations/state.ts`).

## What the extension does — read from its source, not its name

`@trigger.dev/build` 4.5.9, `dist/esm/extensions/core/vercelSyncEnvVars.js` and
`syncEnvVars.js`, and the CLI that calls them (`trigger.dev` 4.5.9, `build/extensions.js`,
`commands/deploy.js`):

| Fact | Consequence |
|---|---|
| Lists `GET https://api.vercel.com/v8/projects/{projectId}/env?decrypt=true&teamId=…&target=production` with `Bearer VERCEL_ACCESS_TOKEN` | Needs a token with access to the team, the project id (or name — the endpoint takes either) and the team id |
| Token from the option, else `process.env.VERCEL_ACCESS_TOKEN`, else the Trigger.dev env's `VERCEL_ACCESS_TOKEN`, else `VERCEL_TOKEN` | We read the deploying shell only: putting the token in the Trigger.dev dashboard is the double entry this avoids |
| `if (!value) return false` on each variable | **Every variable whose value Vercel will not return is dropped, silently.** Vercel never returns a value for a *Sensitive* variable, and the Vercel CLI makes production variables Sensitive by default (`vercel env add … --no-sensitive` is the documented opt-out) |
| Its callback **throws** on a missing token or project id; `syncEnvVars` catches that into `logger.warn` and returns nothing | A missing token deploys with "No env vars detected" |
| The CLI's `notifyExtensionOnBuildComplete` wraps every extension's `onBuildComplete` in `try { … } catch { logger.error }` and carries on | A wrapper that throws *there* is swallowed too |
| `notifyExtensionOnBuildStart` has no try | A throw in `onBuildStart` fails the deploy — the one place a refusal holds |
| Strips `TRIGGER_*` names and a list of shell variables | `TRIGGER_SECRET_KEY` on Vercel does not overwrite the worker's own |
| `override: true` | Vercel's value wins over anything already in the Trigger.dev env |
| `environment` `prod` → Vercel `production`; `staging`/`preview` → `preview` | `vercelEnv()` syncs prod only and does nothing for the others |
| The synced variables are uploaded to Trigger.dev's environment store (`syncEnvVarsWithServer`) before the image deploys | They persist there (visible in the dashboard) — a copy, maintained by every deploy, never typed |

So, wrapped:

| Hook | Does | On failure |
|---|---|---|
| `onBuildStart` | Requires `VERCEL_ACCESS_TOKEN` in the shell; lists production **without `decrypt`** (names, types, targets — no value is read or printed); checks every required name is present, branch-independent and **not Sensitive** | Throws → the deploy fails, naming each problem and the fix (`vercel env rm X production` then `vercel env add X production --no-sensitive`) |
| `onBuildComplete` | Production only. Runs the real `syncVercelEnvVars`, watches the layer it adds, checks every required name arrived | `process.exit(1)` — the build precedes the deployment record, so nothing is half-created |

`--env` is read from argv in `onBuildStart` (the context has no environment there); the
manifest's `environment` in `onBuildComplete` is authoritative, and a disagreement exits.

## What is "required"

`requiredForWorker()`: the worker env manifest's required names (`requiredWorkerEnv()`, the
list `check:trigger-env` already keeps honest against the import graph) **plus** every field
of every integration filling a Bureau role (`workerCredentialFields()` in the catalogue:
storage, LLM, generation/voice, embeddings). The second half exists because
`resolveCredentials` reads `process.env[field.key]` by a computed name — invisible to the
import-graph walk — and with Vault empty those are exactly the reads the worker depends on.

## What has to be true in Vercel, once

1. Every required name set for **Production**, not only for a git branch.
2. **Not Sensitive.** A Sensitive variable cannot be read back by anything, including this
   sync. Trade-off accepted for personal use: a non-sensitive ("encrypted") variable's value is
   visible in the Vercel dashboard to members of the team — which is Sahil.
3. `VERCEL_ACCESS_TOKEN` itself is **not** a Vercel variable: it lives in the deploying shell.
   If it were in Vercel it would be synced into the worker.

## Checks

| Where | What |
|---|---|
| `pnpm check:trigger-env` with `VERCEL_ACCESS_TOKEN` | Same predicate as the deploy (`vercelEnvProblems`), names only. Without a token it prints `SKIP` with the reason — and a GitHub notice in CI — rather than passing |
| `pnpm test:trigger-env` (CI) | Drives the extension with stub fetches: every refusal, the real sync's layer, the exit when a name does not arrive, production only, no `decrypt` on the check's listing |
| The deploy | The refusal itself |

## Not chosen

- **Typing secrets into the Trigger.dev dashboard.** The thing Sahil asked not to do.
- **The worker reading Vault only.** Possible (the code does Vault first), but it makes Vault
  mandatory and the keys a second copy anyway.
- **Marking synced values `isSecret` in Trigger.dev.** The layer could be rewritten to
  `secretEnv`; not done, because that path is one more unexercised branch in the CLI and the
  account is Sahil's own. Revisit if anyone else ever gets dashboard access.
