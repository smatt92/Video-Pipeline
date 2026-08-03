# 0010 — Deploying the pipeline to Trigger.dev

**Date:** 2026-08-03
**Status:** written, **not executed** — deploying needs the account, which is yours

## What is registered

`trigger.config.ts` sets `dirs: ['./src/trigger']`, so every task in that directory is
picked up by file position rather than by an import list. Adding a task is adding a file;
there is no registry to forget to update.

| Task id | File | Runs where | Concurrency | Why that number |
|---|---|---|---|---|
| `03-script` | `03-script.ts` | Trigger | 1 | LLM call, and the account's rate limit is the real ceiling |
| `04-prompt-compile` | `04-prompt-compile.ts` | Trigger | 1 | Same |
| `05b-ingest` | `05b-ingest.ts` | Trigger | **4** | ffmpeg encode + whole clip on disk. CPU and disk are the ceiling, not a vendor |
| `06-voice` | `06-voice.ts` | Trigger | 1 run, N requests | The **run** limit is 1; the parallel-request ceiling inside a run is read from `integrations.concurrency_limit` at run time |
| `07-assemble` | `07-assemble.ts` | Trigger | **2** | Stream copy, but every clip is read off disk at once |

The distinction in the voice row is the one worth keeping straight. Trigger's
`queue.concurrencyLimit` bounds how many *runs* execute; the vendor's limit bounds how many
*requests* are in flight. Setting only the first would let two runs each open the vendor's
full allowance and produce a steady failure rate that reads as vendor flakiness. `06-voice`
reads its number from the integration record and logs when that number is a fallback rather
than a reading — `concurrency_source` exists so a screen never presents a default as a fact.

The two new tasks take static limits instead, and that is not an oversight: neither is
bounded by a vendor. They are bounded by the machine, which does not have a row.

## What you run

Trigger.dev's CLI authenticates against your account, so these cannot be run from here.

```bash
# once, interactively — opens a browser
pnpm dlx trigger.dev@4.5.9 login

# from the repo root, with TRIGGER_PROJECT_REF set
pnpm trigger:dev          # local worker against the dev environment
pnpm trigger:deploy       # build and deploy to production
```

`pnpm trigger:deploy` is `trigger.dev deploy`, already in `package.json`.

### Environment variables the worker needs

Trigger.dev does **not** share Vercel's environment. Every variable is set separately, in
the Trigger dashboard under Environment Variables, and a variable set on Vercel and
forgotten here produces a control plane that works and a pipeline that fails on its first
real run. The list is in `README.md` under "Trigger.dev — the pipeline"; the ones the two
new tasks need specifically:

| Variable | Why |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Both tasks write rows |
| `STORAGE_DRIVER` | Selects the driver. **Must not be `local-fs` in production** — see below |
| `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_S3_REGION` | The object store |

### ffmpeg on the worker

`05b-ingest` and `07-assemble` shell out to `ffmpeg` and `ffprobe`. Trigger.dev's default
image does not carry them. Add a build extension to `trigger.config.ts` before the first
deploy:

```ts
import { ffmpeg } from '@trigger.dev/build/extensions/core';
// inside defineConfig:
build: { extensions: [ffmpeg()] },
```

This is **not in the config yet**, deliberately: `@trigger.dev/build` is a dependency this
repo does not have, and adding one that cannot be exercised here — the deploy is what
exercises it — would be adding an unverified dependency to satisfy a checklist. Add it in
the same commit as your first deploy attempt, where the failure is one command away from
the fix.

**The symptom if you forget:** `05b-ingest` fails with `spawn ffmpeg ENOENT` on its first
run, after the generation was paid for. The generation row records it, so nothing is lost
beyond the wait.

## The local-fs guard

`STORAGE_DRIVER=local-fs` selects a filesystem driver that exists so the ingest and
assembly paths could be executed at all in an environment with no object store. It refuses
to construct without `KILN_LOCAL_STORAGE_ROOT`, which is unset everywhere except the
harnesses — so a production worker that somehow selected it fails at startup rather than
writing media into a container filesystem that vanishes on the next deploy.

`07-assemble` additionally throws for any driver other than `local-fs`, with a message
saying exactly what is missing: ffmpeg reads files, so assembling from an object store
needs each asset downloaded to the container first, and that download has never run against
a real bucket. That throw is the honest state of it — see 0008 §7.

## What has been executed, and what has not

**Executed here, against real ffmpeg and a real Postgres:**

```bash
pnpm verify:ingest   "$DATABASE_URL"    # 3 shapes → canonical, corrupt → error row, unconfirmed → refused
pnpm verify:assemble "$DATABASE_URL"    # 6 clips → one MP4, mismatched set refused, renders row written
```

**Never executed:** the deploy itself, the ffmpeg build extension, the object-store
download inside `07-assemble`, and every task's behaviour under Trigger's own runtime. The
task bodies are thin wrappers over the functions the two harnesses drive directly — which
is deliberate, because it is the part that can be tested — but "the wrapper is thin" is a
reason to expect it to work, not evidence that it does.
