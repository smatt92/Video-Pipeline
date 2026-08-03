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

Trigger.dev's CLI authenticates against your account, so none of steps 1–4 can be run from
here. Step 0 can, and does, on every push.

```bash
# 0. Pre-deploy, no account needed — runs in CI already
pnpm check:trigger-build

# 1. Once, interactively — opens a browser
pnpm dlx trigger.dev@4.5.9 login

# 2. Build the image WITHOUT deploying. This is the step that exercises the ffmpeg
#    build extension for real. If it is going to fail, it fails here, for free.
TRIGGER_PROJECT_REF=proj_… pnpm trigger:deploy:dry

# 3. A local worker against the dev environment. Trigger a task from the dashboard and
#    watch it run on your machine, with real logs.
TRIGGER_PROJECT_REF=proj_… pnpm trigger:dev

# 4. Deploy
TRIGGER_PROJECT_REF=proj_… pnpm trigger:deploy
```

**Do step 2 before step 4, every time.** `--dry-run` builds the deployment image locally
and uploads nothing, which is the only way to find out whether the ffmpeg extension
produces a working image without spending a deploy to learn it. It is the difference
between a build error and `spawn ffmpeg ENOENT` on a run that has already been billed.

### Step 0, and why it is separate

`pnpm check:trigger-build` needs no account and no network. It scans `src/` for code that
spawns a bare binary, confirms `@trigger.dev/build` still exports `ffmpeg` from
`extensions/core`, calls it, and confirms `trigger.config.ts` declares it. That covers the
class of breakage that would otherwise ship silently — a renamed export, a moved subpath, a
dependency dropped from `package.json`, or somebody deleting the line while tidying.

It does not build an image, so it cannot tell you the extension *works*. Step 2 is that.
Two checks because they catch different things and the cheap one runs on every push.

> Written before it caught anything, and then it caught itself. Its first version matched
> `execFile('ffmpeg', …)` literally, and both files that spawn ffmpeg here do
> `const run = promisify(execFile)` followed by `run('ffprobe', …)` — so it found nothing,
> printed "no binary dependencies found" and passed. A green check asserting the opposite of
> the truth, which is the failure it exists to prevent, one level up.

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
image carries neither, so the config declares the build extension:

```ts
import { ffmpeg } from '@trigger.dev/build/extensions/core';
// inside defineConfig:
build: { extensions: [ffmpeg()] },
```

**This is now in the config**, and `@trigger.dev/build` is installed. The earlier version of
this document argued for adding it only alongside a first deploy attempt, on the grounds
that an unexercised dependency is an unverified one. That reasoning was inverted: a config
error surfaces at build time and costs a minute, and a missing binary surfaces at runtime
after money has moved. Declaring it is the cheaper of the two failures even though neither
has been observed.

**The symptom if it is wrong or absent:** `05b-ingest` fails with `spawn ffmpeg ENOENT` on
its first run, after the generation was paid for. The generation row records it, so nothing
is lost beyond the wait and the credits.

## The local-fs guard

`STORAGE_DRIVER=local-fs` selects a filesystem driver that exists so the ingest and
assembly paths could be executed at all in an environment with no object store. It refuses
to construct without `KILN_LOCAL_STORAGE_ROOT`, which is unset everywhere except the
harnesses — so a production worker that somehow selected it fails at startup rather than
writing media into a container filesystem that vanishes on the next deploy.

`07-assemble` used to throw for any driver other than `local-fs`, because assembling from an
object store needs each asset downloaded to the container first and that download had never
run. It no longer does: the bucket path downloads every clip through `presignGet` and a
plain `fetch`, and that whole leg is exercised against **s3rver** — a real S3-compatible
server, through the real driver with only the endpoint changed — in `pnpm verify:assemble`,
in CI, on every push. See 0008 §5d.

## What has been executed, and what has not

**Executed here, against real ffmpeg and a real Postgres:**

```bash
pnpm check:trigger-build                # the image would carry ffmpeg and ffprobe
pnpm verify:ingest   "$DATABASE_URL"    # 3 shapes → canonical, corrupt → error row, unconfirmed → refused
pnpm verify:assemble "$DATABASE_URL"    # 6 clips → one MP4 over a real S3 endpoint, wrong duration → failed render
```

All three run in CI on every push.

**Never executed:** the deploy itself, the ffmpeg build extension *as a built image*, and
every task's behaviour under Trigger's own runtime. The task bodies are thin wrappers over
functions the harnesses drive directly — which is deliberate, because it is the part that
can be tested — but "the wrapper is thin" is a reason to expect it to work, not evidence
that it does.

`pnpm trigger:deploy:dry` closes the middle one, and it is the first thing to run when you
have the account.
