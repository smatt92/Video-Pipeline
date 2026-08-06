# Handover — last updated 2026-08-05 (second session)

`HANDOVER.md` is the standing "what you do next". This file is narrower: what happened in
one unattended session, what was left mid-air, and what I would do first on waking.

---

## 0. The network policy has NOT taken — and it is the ENVIRONMENT, not the container

```
api.supabase.com · *.supabase.co · api.elevenlabs.io
platform.higgsfield.ai · api.trigger.dev · remotion.media    connect_rejected
positive control:  api.github.com 200 · pypi.org 200 · *.googleapis.com 200
negative control:  not-allowlisted.example.com  connect_rejected
```

Re-probed 2026-08-06 on a **fresh** container and unchanged. The decisive variable:

```
CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE=cloud_default
```

Sessions here run in the **Default** environment, whose network access is **Trusted** — and
the observed allowlist matches Trusted exactly. So an edited allowlist has no effect unless
the session is started with that environment *selected* in the picker at `claude.ai/code`
(the cloud icon above the message box; there is no settings page for it). A new container of
the same environment changes nothing, which is what kept happening.

**A correction, because the wrong version of this went into a handover and a reply.** I
wrote that `CCR_SPAWN_TIMESTAMP_MS` was byte-identical across sessions and concluded the
container was never replaced. The first half was true at that moment; the conclusion was
not. The variable tracks PID 1's start — checked against `/proc/1`, three seconds apart —
and it **does** change when a genuinely new container spawns. Two consecutive sessions
happened to share one. Check it against `/proc/1` rather than against memory.

**Three instrument traps, all hit in this repo:**

- **A stale proxy port.** `HTTPS_PROXY` changes when the container restarts. A probe loop
  with a hardcoded port returns 000 for every host and looks exactly like a total denial.
  Read `$HTTPS_PROXY` in the same command that probes.
- **`curl -w '%{http_code}'` reports the CONNECT status on a failed tunnel.**
  `api.elevenlabs.io` returned `403` and read as *allowed by policy, refused by the vendor*.
  It was the proxy's own refusal. `curl -i` says `CONNECT tunnel failed, response 403`, and
  `$HTTPS_PROXY/__agentproxy/status` lists the host under `recentRelayFailures`. **Believe
  the relay log.**
- **A spawn timestamp read once is a snapshot, not a lifecycle.** See the correction above.

`*.googleapis.com` IS reachable, which is why Addendum 04 could proceed.

---

## 0. Read this first — the container HAS a Postgres, and here is how to start it

```
./scripts/pg-scratch.sh up      # idempotent; run before any harness
./scripts/pg-scratch.sh init    # first time, or after the data dir is lost
export DATABASE_URL=postgresql://postgres@127.0.0.1:55432/kiln
```

**The earlier claim that this container had no database was wrong**, and it cost two days of
harnesses written and shipped unexecuted plus four red CI runs nobody read. `initdb` exits 1
as root — "cannot be run as root", with the fix in its own hint — and I read that refusal as
an absence. The server binary was at `/usr/lib/postgresql/16/bin/postgres` the whole time.

The cluster **dies without logging a shutdown** when the container reclaims memory. `up` is
idempotent for that reason; run it before a suite rather than diagnosing "connection
refused". `.env.local` is gitignored and will not survive a fresh container — recreate it
with the `DATABASE_URL` above plus the bootstrap values from `.env.example`.

**All twenty-one harnesses run here** — twenty plus the new `verify:measure`. That is the
state to preserve: do not write a harness you have not executed.

**And it is `pnpm db:doctor`, not `pnpm doctor`.** `doctor` is a pnpm builtin and a builtin
shadows a package script of the same name, silently, with exit 0 — so every "ran the doctor,
it passed" in this repo's history was a claim about pnpm's own diagnostic. `check:script-names`
now asks the installed pnpm from an empty directory, with a positive control, and runs in CI.
The colon is what makes a name safe permanently; no pnpm command contains one.

---

## 0a. Where the queue stands — TWO LARGE ITEMS NOT STARTED

| Item | State |
|---|---|
| Decisions 4b + the puppeteer rule | **DONE.** Worker image extension written; CLAUDE.md line added |
| 1. Inverse test remainder | **DONE**, and it found a third instance — see below |
| 0. The pnpm shadowing defect | **DONE.** `doctor` → `db:doctor`; `check:script-names` in `pnpm check` and CI |
| **2. Stage 11 — measure** | **DONE.** Migration 0034, `src/lib/measure/`, `/analytics`, `verify:measure` in CI. What it does NOT have, on purpose: a Trigger task — see below |
| **3. Stage 10 — publish (YouTube half)** | **DONE.** Migration 0035, `src/lib/publish/`, `/publish`, `10-publish` + `10b-token-health`, `verify:publish` in CI. Nothing uploaded — see below |
| **4. Addendum 04 outlier score** | **PART DONE.** Schema, arithmetic, guard and harness landed (0036). The poller and the concept-prompt rewrite are NOT done — see below |
| 5. The sweep | Ongoing; two threads pulled this round — `check:enums` and the `win_rate` collision |
| 6. STATE.md accuracy pass | **DONE.** §2 counts re-measured (473 across fifteen DB harnesses), §3.3 corrected on stages 7 and 11 |

**Start with the two halves of Addendum 04 that did not land.** Nothing in the queue is
blocked on code — only on credentials and on a container that has the new policy.

### Addendum 04 — what landed, and the two pieces left

Landed in 0036: `tracked_channels`, `competitor_videos`, `pacing_template`,
`v_outlier_leaders`, `v_tracked_channel_health`, `src/lib/trends/outlier.ts`,
`check:pacing-columns`, `verify:outlier`. All in CI.

**Not done, in the order I would do them:**

1. **The concept prompt rewrite.** `combinations()` exists and is tested — it pairs across
   the ranking (first×last, second×second-last) rather than adjacently, because ranking puts
   similar topics next to each other and adjacent pairs produce the near-duplicates the
   technique exists to avoid. What is missing is a new versioned prompt in
   `src/lib/prompts/` that takes those pairs and the change in `src/lib/concepts/run.ts` to
   feed it. `verify:concepts` will need its expectations restated rather than loosened.
2. **The poller.** A Trigger task that reads each active channel's uploads playlist, upserts
   `competitor_videos`, recomputes baselines and writes `trend_signals` rows with
   `source='outlier'`. Every call must go through `spend(db, 'youtube', 'playlistItems.list')`
   — the quota mechanism from stage 10 already knows both prices, and `search.list` is in
   that table at 100 units precisely so nobody reaches for it.

`pacing_template` has no writer at all and that is deliberate for now: extracting structure
from a competitor's video needs the video, and nothing fetches one. The guard is the thing
that had to exist first.

### What stage 10 landed, and the three things to know before extending it

- **`api_quota_usage` is the counting mechanism and it is generic.** One row per call, with
  the vendor's own endpoint name and its unit cost, written *before* the call. The outlier
  score's `playlistItems.list` calls must write rows the same way — `spend(db, 'youtube',
  'playlistItems.list')` already exists and already knows the price. `search.list` is in the
  price table at 100 units and is deliberately unused; naming it with its cost is what stops
  it being reached for.
- **`QUOTA_UNITS` in `src/lib/publish/youtube.ts` is the price list**, and it is NOT from the
  discovery document — Google publishes prices in a separate calculator. That is why
  `integrations.quota_source` says `documented`. The discovery doc IS reachable from the
  container (`*.googleapis.com` is on the Trusted allowlist), so field names and scopes
  should be read from it rather than recalled — that is how `containsSyntheticMedia` was
  established.
- **Stage 11's Trigger task is now writable and still needs a different API.** YouTube
  *Analytics* (`youtubeAnalytics.reports.query`) is not Data API v3; it has its own scopes
  and its own quota. `v_measurement_due` is already the list such a task should iterate, and
  a fetcher must write `metric_source = 'vendor_api'` and multiply `audienceWatchRatio` by
  100 for the 0–100 column.

**Nothing has been uploaded and no credential exists.** Everything past `resolveCredentials`
is unverified — 0008 §13.

Items 3 and 4 are each a migration plus a task plus a surface plus a harness, and standing
order 2 says a half-landed item is worse than a clean stop. **The specs below are the
operator's own, kept verbatim in substance so nothing is lost between sessions.**

### What stage 11 landed, and the one thing it deliberately did not

Every bullet of the spec below is built. Three notes for whoever picks up stage 10, because
they constrain it:

- **There is no `src/trigger/11-measure.ts` and that is deliberate.** Phase 1 publishes by
  hand, so there is no analytics credential; a task would enumerate `v_measurement_due` and
  then have nothing to call. That is the complete-and-unreachable module this project has
  removed five times. **Stage 10 is what unblocks it**: the moment a YouTube credential is
  verified, the task becomes writable, and `v_measurement_due` is already the list it should
  iterate. See 0008 §12.
- **`metric_source` already distinguishes a typed number from a fetched one.** A task must
  write `vendor_api`; nothing else may.
- **`retention_3s_pct` is 0–100 with a CHECK, and the API's `audienceWatchRatio` is 0–1.**
  A fetcher must multiply. The harness records that a 0–1 ratio typed into the field is *in
  range* and therefore accepted — a known limit the schema cannot close, and the most likely
  thing to get wrong on the first real run.

Two smaller things fell out of it and are worth knowing about:

- `v_recipe_performance.win_rate` is now `ship_rate`, with `median_retention_3s_pct` beside
  it. Anything reading `win_rate` is reading a column that no longer exists.
- `check:enums` fanned a multi-column CHECK out to one "enum" per column it mentioned and
  demanded a TypeScript enum for `metrics_snapshots.views`. Now filtered to single-column
  constraints of the `= ANY (ARRAY[…])` shape.

### Item 2 — stage 11, measure. The loop ARCHITECTURE §0.1 calls the moat

- `metrics_snapshots` ingest at 6h / 24h / 7d / 30d
- **`retention_3s_pct` is the hook metric — everything else is secondary**
- **Score hooks, not videos.** Roll up to prompt recipes and hook patterns
- Backfill `prompts.win_rate` from real outcomes, replacing the derived-from-compiles
  placeholder
- `v_cost_per_1k_views` finally gets a reader
- **Inverse test up front: the denominator is published videos.** A metrics screen that looks
  the same after one video and a hundred is the trap, and this project has now found that
  shape four times — the costs page, the trends list, the review queue, the Studio list — plus
  three silent `.limit()` caps. Assume it is present until proven otherwise
- Buildable against fixtures; no vendor needed

### Item 3 — stage 10, publish, YouTube only (Meta deferred)

- Data API v3 **resumable upload from the worker**, never a Vercel route (rule 2)
- `altered_content_disclosed` set on **every** upload
- Quota accounting: 10,000 units/day, 1,600 per upload. **Declare it as data.** This is the
  one windowed quota the codebase could actually observe, so the limits card can carry a real
  countdown instead of the current fiction
- `enforce_review_pass` is the gate. **No bypass** (rule 7)
- Token refresh cron with expiry alerting

### Item 4 — Addendum 04's outlier score

- `tracked_channels` + `competitor_videos`
- `outlier_score = video_views / median(that channel's last 20)`
- Pull uploads via the **uploads playlist (1 quota unit)**, never `search` (100)
- `trend_signals` gains `source='outlier'` — free, the column has no CHECK
- Rewrite the concept prompt to generate **combinations** from top outliers rather than
  freeform ideas. Also anti-template: every combination produces a different argumentative
  shape, which is what `structure_hash` wants to see
- **Do NOT build `pacing_template` with any text column.** Structure is not copyrightable,
  sentences are, and a text column crosses that line silently. **Add a CI check that fails if
  one is ever added** — this is a guard to write *before* the table exists, which is the one
  time a guard for a state no write path produces is correct, because the whole point is that
  no write path should ever produce it

### What item 1 found: the silent cap is a shape

Three readers capped a list and rendered `rows.length` — review queue, Studio list, and the
board, which also summed the capped rows into a rupee total. None wrong in isolation. All
now report `truncated`.

**Two left, deliberately not done to avoid a half-swept change:** `path.ts:115` (`.limit(50)`)
and `studio/read.ts:135` (`.limit(40)`). Both are display-adjacent. The window-shaped ones in
`concepts/run.ts`, `metadata/run.ts` and `voice/` are deliberate and feed prompts, not counts.

---

## 0b. The Trigger layer's test reach — CLOSED

Seven `throw`s lived in `src/trigger/`, unreachable because no harness imports a task. The
answer was **move the guards down**, not build a harness that reaches into tasks — and the
classification is why:

| Refusal | Where it went |
|---|---|
| webhook secret, callback base URL | `submitShots`, as named refusals. `verify:submit` §14 drives both by passing an empty string and asserts **no vendor request was made** |
| presigned-PUT status ×2 | `src/lib/storage/put.ts` — one implementation instead of two that had already drifted. `verify:ingest` drives both branches against a stub that 403s and one that accepts |
| no primary integration ×2, with credential resolution | `src/lib/integrations/resolve.ts`. `verify:submit` §15 drives the happy path and the missing-credential refusal |
| the two rethrows | Stayed. They contain no decision — they convert an already-tested lib refusal into a run failure |

**Four throws remain in `src/trigger/` and all four are that last shape.** That is the target
state: a task resolves configuration and hands it down; deciding whether it is sufficient
belongs where a harness can drive it.

Two things the moves taught, both worth keeping:

- **The harness caught a real error in `resolveDriver`.** My first version required every
  catalogue secret field; the video integration has three, not the two I assumed, and the
  third is the webhook secret that `submitShots` refuses on with a better message. Requiring
  it there would have made that refusal a branch production could never enter.
- **`no_primary_integration` is not covered.** `primaryForKind` reads a code catalogue, so
  the state cannot be produced from a harness without mocking the module. Said plainly rather
  than left as a gap that reads as coverage.

---

## 0d. Earlier decisions, and the work they left behind

**DECISIONS-PENDING 9 is open** (whether to install chrome-headless-shell in CI). Everything
below was closed earlier; two of the three left work behind and one is now built:

| | What to build | Where it is specified |
|---|---|---|
| **3** | `credit_readings` + the per-window view + the calibration surface | DECISIONS-PENDING 3, in full. Migration + two views + a surface — spec is implementable as written |
| **8** | The Request-metadata button on `/review/[renderId]` | DECISIONS-PENDING 8. `src/components/review/screen.tsx`, beside the pass decision |
| ~~8~~ | ~~A reader for stage 1~~ — **BUILT.** `/trends` | And the claim behind it was partly wrong: see DECISIONS-PENDING 8. The table is `trend_signals`, `concepts/run.ts` reads it, the chain was never broken. What was true is that no screen showed it |

**The trends finding was overstated and is corrected in DECISIONS-PENDING 8.** I grepped
`from('trends')`; the table is `trend_signals`, and `concepts/run.ts:132` reads it. Stage 1
was never disconnected from stage 2. What was true — no screen had ever shown it — is fixed:
`/trends` now exists.

One thing on the metadata button that will otherwise get re-derived: **there is no honest
pre-flight estimate for an LLM call** — `llm.ts` documents why — so it shows what the *last*
metadata draft cost, from `cost_ledger`, labelled as the last one. Do not compute an estimate
of this call; that is the fabricated-measurement trap in a new place.

---

## 0c. Second half of the session — your two decisions, and what they turned up

| Commit | What |
|---|---|
| `8570433` | `USD_INR_RATE`: default dropped, required at the ledger write via `src/lib/cost/fx.ts` |
| `0ce27e2` | `@remotion/renderer` installed and pinned; `check:remotion` guards version lockstep |
| `f67963a` | DECISIONS-PENDING 1 and 2 taken — `v_entry_state` kept-and-recorded, referral panel built |
| `138284f` | The sweep: a caller that is itself uncalled is not a caller |

**Two findings worth carrying, both from checking a claim before building on it.**

`USD_INR_RATE`'s default was justified by a comment saying `profiles.usd_inr_rate`
superseded it once onboarding ran. False — the wizard writes that column and nothing on the
pricing path reads it. So there are two configured rates, one of which does nothing, and the
operator setting it believes otherwise. **DECISIONS-PENDING 7**, left for you because which
rate is authoritative changes what a money row means. Whichever wins, the loser must stop
existing.

The sweep found three functions named by documentation and called by nothing — and two of
them say *in their own headers* that they were written to avoid exactly that. `isUsable` is
deleted; the two false headers are corrected; **DECISIONS-PENDING 8** holds the two Server
Actions that still want buttons.

---

## 1. What shipped in the first half

Four commits, each green in CI at the time of pushing (74 was still running for the third;
see §4).

| Commit | Item | What |
|---|---|---|
| `497634e` | 6 | Stage 7's final composition — `src/lib/assemble/composition.ts` + `verify:assemble` §9 |
| `678aa40` | 7 | Trigger.dev deploy readiness — the worker's env manifest and `check:trigger-env` |
| `0b0dc6c` | 8 | STATE.md accuracy pass |

Items 2 and 3 were verified already complete in `6f21a90` before this session's queue
began; items 4 and 5 landed as `d7d9d0b` and `698a3ef`.

### The one worth knowing about: `check:trigger-env`

Trigger.dev is a second deployment target with its own environment, set in a different
dashboard from Vercel's, and nothing in this repo said which variables belong in it. The
manifest now does, and the check derives the other side from the import graph across all
nine tasks and 61 modules.

**The finding that makes it non-obvious:** `env` is a Proxy whose every access calls
`assertEnv()`, which parses the *whole* schema. So one `env.USD_INR_RATE` in a task drags
in every non-optional field, and a worker with no `ALLOWED_EMAIL` — a sign-in allowlist for
a website the worker is not — throws on the first task that touches configuration. A grep
for `env.X` under `src/trigger/` understates the requirement by five variables. Today's
build demonstrated it out loud: one page touched one variable and the failure named all five.

`pnpm check:trigger-env` prints the list to paste into the dashboard. `pnpm db:doctor` asks the
same list of whatever environment it can see.

---

## 2. What is queued for your judgement

`docs/DECISIONS-PENDING.md`, six entries. Two are new this session:

- **4. `@remotion/renderer`** — not installed, and CLAUDE.md says ask before adding a
  dependency it does not name. The composition *plan* shipped without it; the MP4 cannot.
  Recommendation: add it, when you are awake to approve the Chromium install. Note that
  `check:trigger-build` will then demand it be declared as a build extension, which is that
  check working.
- **5. `USD_INR_RATE` defaults to 88.5** — and six tasks pass it straight into the cost
  ledger. A worker without the variable snapshots a rate nobody set onto every money row,
  and `/costs` presents it as measured. Same shape as `?? 0` on a duration, in the input to
  the headline metric. Recommendation: drop the default, require it at the ledger write.
  **This is the highest-value item in the file** — it is the only one where the current
  behaviour is actively writing something untrue.

---

## 3. What I would do first, and why

1. **Restore `.env.local`.** Lower priority than it looked when this file was first written:
   CI run 74 covers `678aa40` and its step 31 — *"Stage 5 refuses before it spends, and
   submits exactly once"*, which is `verify:submit` — passed. That is the one production
   change this session made, the `requireEnv` swap in stage 5, and it is proven. Restoring
   the file is for the *next* change, not for validating this one.

   Worth noticing how that correction happened: the sentence originally here said the
   harness "has not re-run since", which was true of this container and false of the world.
   A statement about what has been verified is scoped to an instrument, and dropping the
   instrument from the sentence turns a true observation into a false claim.

2. **Decide DECISIONS-PENDING 5** (the FX rate). Every day it stays open is more ledger rows
   carrying a number nobody set.

2b. **DECISIONS-PENDING 8** — build the two buttons. Smallest real item on the list, and it
   is the only thing between stages 1 and 9 and being reachable by a person at all.

3. **Back to the sweep** — queue item 1. Both threads below have now been pulled; the
   uncalled-caller one is written up as a CLAUDE.md rule and produced three fixes. The
   sweep method that worked was the **narrow intersection**: uncalled *and* named in prose,
   which gave four candidates instead of seventy-eight. Two broader passes were too noisy to
   trust — the first could not see `.mjs` harnesses as callers, the second could not see
   framework conventions like `middleware`. Do not re-run the broad version expecting signal.

   The original two threads, kept for the record:

   - **`requireEnv` had no callers at all**, while five comments in `src/lib/env.ts` and one
     line in `HANDOVER.md` named it as the mechanism that catches a missing variable at the
     point of use. Stage 5 did that check by hand instead. Fixed — but the *shape* is worth
     sweeping for: **a mechanism whose contract is asserted by documentation and implemented
     nowhere.** It is the "and what reads this?" failure inverted — not a thing nobody reads,
     but a thing everybody cites and nobody calls. Grep for exported helpers with zero call
     sites and see which ones the comments promise.

   - **`check:trigger-env` caught two defects in its own deriver on the first change made
     after it was written.** A comment saying ``a hand-rolled `if (!env.X) throw` ``
     registered `X` as a requirement, and `requireEnv('WEBHOOK_CALLBACK_BASE_URL')` was
     invisible to a deriver that only knew member access. The second is the
     silent-under-report failure and it failed safe **only by luck**: the manifest still
     declared the variable, so the check reported a disagreement rather than losing one. Any
     other derived-from-source check in this repo has the same exposure — one syntax known
     for a thing that has several. Worth a sweep of its own.

4. **Trigger.dev deploy itself** is now the only part of item 7 not done. Everything short of
   it is: binaries declared, variables declared and checked, concurrency limits set on all
   nine tasks (verified — every one has a `queue.concurrencyLimit`). `pnpm trigger:deploy:dry`
   builds locally and uploads nothing; it needs an account this environment does not have.

---

## 4. CI, by step list

| Run | Commit | Result |
|---|---|---|
| 70 | `6f21a90` | 45/45 success |
| 71 | `d7d9d0b` | success |
| 72 | `698a3ef` | success |
| 73 | `497634e` | success |
| 74 | `678aa40` | steps 1–38 success, including step 9 (the new `Worker env manifest matches what tasks reach`) and step 31 (`verify:submit`, covering the `requireEnv` swap). Build and the two browser harnesses still running when this was written |
| 75 | `0b0dc6c` | queued behind 74 — docs only |
| 76 | this commit | docs only |

**Read these by step list, not by summary.** `pnpm check` chains fourteen tools and only
some of them print a failure marker this project's greps recognise; `$?` is the only signal
all of them agree on. Six commits were once pushed claiming green CI that had been red the
whole time, on exactly that mistake.

---

## 5. Nothing was left half-landed

The tree at `0b0dc6c` is `pnpm check` = 0 and `pnpm build` = 0. There is no work in progress
on disk, no partial migration, and nothing uncommitted. The next session can start from
item 1 of the queue with a clean tree.
