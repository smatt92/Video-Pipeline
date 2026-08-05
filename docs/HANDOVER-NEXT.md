# Handover — last updated 2026-08-05

`HANDOVER.md` is the standing "what you do next". This file is narrower: what happened in
one unattended session, what was left mid-air, and what I would do first on waking.

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

**All twenty harnesses run here** — nineteen plus the new `verify:render`. That is the state
to preserve: do not write a harness you have not executed.

---

## 0a. Where the queue stands

| Item | State |
|---|---|
| 1. Stage 7 full composition | **DONE and rendering.** A real MP4, measured against its plan |
| 2. STATE.md accuracy pass | **DONE.** 486 assertions across twenty harnesses, all measured |
| 3. The sweep | Ongoing. Last round caught `requireEnv` regressing |
| 4. Screens that look identical after one video and a hundred | Not swept this round — `/trends` was built to that test, nothing else re-examined |
| 5. Pilot-shot path surface | Believed complete (`path-strip.tsx`, `verify:pilot` §0/§5 assert voice-before-videos and waiting-on-you ≠ blocked). **Not re-verified this round** |
| 6. Trigger.dev deploy readiness | Partly. Env manifest and binary check exist; the Remotion Chromium question is open — DECISIONS-PENDING 4 and 9 |

### Item 1 is done, and here is what it actually proves

`pnpm verify:render` — 14 assertions, green locally, **exempt from CI on a browser question**
(DECISIONS-PENDING 9). It bundles Remotion, drives a real headless Chromium, renders two
synthetic clips with captions and a hook, and re-measures the output with ffprobe.

Three things worth not rediscovering:

- **Measure video-stream packets, not `format=duration`.** The first version failed a
  *correct* render — 4.053s against a planned 4.000s — because the container's duration spans
  the audio stream and AAC frames do not align with video frames. The video stream was
  exactly 120 packets. Loosening the tolerance would have made a wrong measurement pass;
  counting frames makes the assertion exact and removes the tolerance entirely.
- **Clips must be http(s).** A bare path 404s against Remotion's own bundle server; a
  `file://` URL is rejected by its asset downloader. Both fail inside `node_modules` with a
  message naming neither cause. `render.ts` refuses both up front now.
- **Remotion needs old-headless Chromium.** `chromium_headless_shell` in this container;
  recent Chrome refuses. That is the whole of why the harness is not in CI.

### Item 4 is the one I did not get to and would take next

The inverse test — *would this screen look identical after one video and after a hundred?* —
has found more than any other in this project. `/trends` was built against it and `/costs`
was retrofitted to it. **Nothing else has been re-examined**: the board, `/publish`,
`/analytics`, `/concepts`, the Studio session list. That is a cheap, high-yield sweep.

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

`pnpm check:trigger-env` prints the list to paste into the dashboard. `pnpm doctor` asks the
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
