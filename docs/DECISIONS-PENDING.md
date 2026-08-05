# Decisions pending

Queued rather than asked, per the standing orders for unattended work. Each has the options
and a recommendation. Nothing here is blocking — the queue moved on past all of them.

---

## 4b. Which build extension Remotion's Chromium wants — ANSWERED, and it is none of them

**The open half of entry 4, now established rather than guessed.** Having actually launched
a browser for `verify:render`, the question is answerable:

**`puppeteer()` does not work.** Reading the extension's own source, it runs
`apt-get install google-chrome-stable` and sets `PUPPETEER_EXECUTABLE_PATH`. That is
new-headless-only Chrome, and Remotion drives *old* headless mode — the exact binary that
fails with "Old Headless mode has been removed". An extension that installs a browser
Remotion refuses is worse than no extension: the image gets bigger, the deploy succeeds, and
the first render fails after clips have been paid for.

`playwright()` and `lightpanda()` are the other two and neither is a Remotion story.

**So the worker needs `chrome-headless-shell`, which no shipped extension installs.** Three
routes:

| | |
|---|---|
| A. Bake it into the image | An `aptGet`/custom step installing `chrome-headless-shell`, plus `REMOTION_BROWSER_EXECUTABLE` pointing at it. Deterministic, no runtime download, and the same mechanism CI now uses — which means one thing to get right rather than two. |
| B. Let Remotion `ensureBrowser()` at runtime | No image work. Downloads from `remotion.media` on a cold worker, which needs egress to a host the network policy must allow, and pays the download on every cold start unless the layer caches. |
| C. `aptGet(['chromium'])` | Debian's build. Whether that version still supports old headless is a question I cannot answer without a deploy, and "probably" is how the ffmpeg problem happened. |

**Recommendation: A**, matching CI. It is the only one where the thing that works locally,
the thing that works in CI, and the thing on the worker are the same binary resolved the same
way.

**One consequence to remember when it lands:** `REMOTION_BROWSER_EXECUTABLE` becomes a worker
environment variable and belongs in `src/lib/trigger/worker-env.ts`. It is deliberately **not
there yet** — `check:trigger-env` derives requirements from what the import graph reaches, and
nothing reads that variable until the assemble task passes it through. Adding it now would be
a declared-but-unreachable entry, which is the failure that check exists to catch.

---

## 9. ~~`verify:render` exempt from CI~~ — **DECIDED: install the shell. DONE.**

> Install the headless shell in CI. verify:render proves the only artifact the product
> exists to make, and an exempt render path is ungated in the one project where ungated
> checks have cost the most.

Done: the workflow installs `chrome-headless-shell`, exports `REMOTION_BROWSER_EXECUTABLE`,
and runs `pnpm verify:render`. The `check:gates` exemption is retired. **The install step
itself is untested** — this container's egress allowlist refuses the download host, so CI is
what proves it. Original entry below.

**Status:** built, green locally, 14 assertions including a real MP4 measured against its
plan.

Remotion drives Chromium in **old headless mode**, which recent Chrome removed. The dev
container has `chromium_headless_shell` — the standalone implementation of exactly that —
and GitHub's ubuntu image ships Chrome, which refuses with *"Old Headless mode has been
removed"*. Wiring the harness to CI as-is turns it red on a browser question rather than a
code one.

The harness **fails rather than skips** when no suitable browser is found, so it cannot
quietly pass on a machine that never rendered anything.

**Options**

| | |
|---|---|
| A. Install `chrome-headless-shell` in CI | One step, and the render becomes a gate on every push — which is where a guard against "a file that plays and is wrong" belongs. Adds ~40s and a download to every run. |
| B. Leave it a local gate | Zero CI cost. The render is then proven only on a machine somebody remembered to run it on, which is the category this project keeps finding problems in. |
| C. Investigate Remotion's `chromeMode` | It can fetch its own Chrome-for-Testing. Downloads a browser at render time, which is worse in CI than installing one deliberately. |

**Recommendation: A.** The whole argument for the render measuring itself is that this path
has shipped three duration bugs, and a guard that runs only when remembered is the weaker
half of that argument. Not done unattended because it adds a download step to every CI run,
which is your call on the build's cost.

---

## 1. ~~`v_entry_state` — keep, delete, or wire~~ — **TAKEN 2026-08-04, option B**

Mine to take, so I took it: **keep, and record why**, exactly as recommended. No code change.

The recorded reason, so it is not re-derived: the view exists to make it hard to read two
independent booleans as one value, and one of the two — `setup_complete` — has no reader
anywhere in `src/`. A guard for a mistake nobody is currently positioned to make. Deleting
it now is the `v_shot_readiness` error in reverse, where removing a near-twin on suspicion
took the wrong copy; keeping it costs nothing but a line here.

**The condition for revisiting is written down rather than left to memory:** delete it the
day `setup_complete` acquires a reader (the view is then redundant with a real call site) or
the day the column is dropped (the view is then describing nothing). Either event, not the
passage of time.

The original entry is kept below.

---

## 1a. The original entry: `v_entry_state` — keep, delete, or wire

**Status:** unread since it was created. Verified independently before writing this, twice:

- `middleware.ts:244` and `(splash)/page.tsx:50` both select `profiles.onboarding_seen_at`
  directly. Neither touches `setup_complete`.
- The deferral banner reads `v_deferred_steps`, a different view, which is read.
- `grep -rn setup_complete src/` outside generated types: **nothing**.

The view's own comment says it exists because *"two independent booleans … reading them as
one value is the mistake this view exists to make hard."* No caller reads both, and one of
the two is read by nothing at all — so the mistake it prevents cannot currently be made.
That is the same shape as the fourth workspace gate that was dropped in §10a: a guard for a
state no write path produces.

**Options**

| | |
|---|---|
| A. Delete it | Honest today. Costs the next person the analysis above if the second boolean ever gets a reader. |
| B. Keep, and record why | No code changes. Leaves a view nobody reads, which is the thing being swept for. |
| C. Wire middleware to it | Puts a wider read on a hot path that needs one column, to prevent a mistake nobody is positioned to make. |

**Recommendation: B, then A when `setup_complete` gets a reader or is dropped.** Not A now,
because the project's own lesson from `v_shot_readiness` was that deleting a near-twin on
suspicion is how the wrong copy goes — and unlike that case this one is not a duplicate of
anything, so there is no second implementation to converge on. C is the vacuous-precondition
failure built deliberately.

---

## 2. ~~`v_referral_attribution` — needs a surface~~ — **TAKEN 2026-08-04, option A, built**

Option A was recommended precisely because it needs no framing judgement, so it was mine to
take. `src/components/settings/referral-panel.tsx`, below the integration cards.

What it does and does not do, since that is the whole of the decision:

- **Two counts, no derived rate.** "3 connected · 2 verified", and a per-vendor table. A
  percentage would be a number to quote at a vendor, and how you frame a number you quote at
  somebody is yours. Two counts side by side cannot overstate; a rate can, and the way it
  overstates is by dividing by the wrong denominator — the exact mistake the view exists to
  make hard.
- **No rows says "nothing to report", not "0".** No integration has ever been connected
  through a referral link, which is a different fact from none of them converting.
- **A failed read says so** rather than collapsing into the empty state, because "could not
  ask" and "nothing to report" are different facts too.

Converting this into B later is a copy change, not a build — which was the argument for A.

The original entry is kept below.

---

## 2a. The original entry: `v_referral_attribution` — needs a surface, and the surface needs copy

**Status:** unread. Genuinely distinct from `v_partner_rollup`, which *is* read —
`v_partner_rollup` is volume and cost by month and driver; this is **signups attributable to
Kiln**, by vendor and by where in the product the click came from.

Its own comment carries the load-bearing part: *"accounts_verified is the honest denominator
for any conversion claim: a connected integration that never verified is a form somebody
filled in, not a win."*

The natural home is Settings → Integrations, beside the referral link that mints the code.
What stops it being built unattended is that it is a **conversion-reporting surface** — the
framing decides whether it reads as an internal diagnostic or as a number to quote at a
vendor, and that is a copy and positioning judgement rather than a technical one.

**Options**

| | |
|---|---|
| A. A quiet diagnostic panel | "3 connected, 1 verified" beside the link. Honest, no framing risk. |
| B. A partner-facing figure | Same data, presented as a conversion rate. Wants the verified denominator prominent or it overstates. |
| C. Leave unread until there is a partner conversation to have | Zero work; the view keeps not being read. |

**Recommendation: A.** The `accounts_verified` denominator makes B safe only if the copy
carries it, and the copy is yours. A is useful immediately and cannot mislead — and it
converts B into a copy change later rather than a build.

---

## 3. ~~The reconcile delta~~ — **DECIDED 2026-08-04: never apportion. SPEC, NOT BUILT.**

> Do NOT distribute it across the generations in the window. That would be a derived
> per-call figure written into the column that means "measured", which is the thing we've
> spent two weeks removing.

Decision recorded in full so it can be built exactly. **Not implemented this session** — it
is a migration plus two views plus a surface, and I ran out of context to land it whole
rather than half. Nothing is blocked on anything but the work.

**The shape, in one sentence: the window is measured and the row is estimated, and neither
pretends to be the other.**

1. **`credit_readings`** — a balance observation with a timestamp, entered by the operator.
   Same discipline as the rate card: a human writes down what they saw, and it is evidence
   rather than inference. Columns at minimum `(driver, observed_at, balance, currency,
   note)`. Forward-only; readings are never edited, because a corrected reading is a new
   observation.

2. **Between two consecutive readings**, a view reports for that window: **measured total
   spend** (the balance delta), **estimated total** (the sum of `cost_ledger` for the same
   window), and the **ratio** between them. Three numbers side by side, none derived into
   the others.

3. **That ratio is a rate-card calibration signal**, surfaced as *"your rate card is running
   N% under observed spend"* — and **never silently applied**. It tells you the rate card is
   wrong; correcting the rate card stays a deliberate act with its own record.

4. **Per-generation cost stays `cost_source: 'estimate'`** until a vendor response actually
   carries a credit figure. A window measurement does not promote the rows inside it.

**Why apportioning is the trap:** dividing a real delta across N generations produces a
number that is arithmetically defensible and epistemically false — it would sit in
`cost_ledger` looking exactly like a figure a vendor reported, and nothing downstream could
tell them apart. Every rule this project has accumulated about fabricated measurements says
the same thing, and this is the largest opportunity to break all of them at once.

The original entry, whose options are now superseded, is kept below.

---

## 3a. The original entry: the reconcile figure, when a credit-balance delta becomes observable

**Status:** already decided in principle — *never write a measurement you did not take* — and
implemented as `cost_source = 'rate_card'` with `/costs` labelling the average. This is the
follow-on question, recorded so it is not re-derived.

When a balance delta *is* observable, the reconcile can be written. The open question is
**what to do with the difference** when the measured figure disagrees with the estimate that
preceded it: the ledger will then hold two rows about one charge that do not agree.

**Options**

| | |
|---|---|
| A. Reconcile supersedes, estimate retained | Already the view's behaviour. The disagreement stays visible in the rows. |
| B. Write a third `adjustment` row for the delta | Every row multiplies out; the audit trail is explicit. More rows. |
| C. Reconcile supersedes silently | Simplest, and loses the evidence that our rate card is wrong — which is the most valuable thing the disagreement tells us. |

**Recommendation: A, with the delta surfaced on `/costs`.** C throws away the signal. B is
correct accounting but the ledger already keys `(generation_id, entry_kind)`, so A gets the
same visibility for no schema change. Not C under any circumstances.

---

## 4. ~~`@remotion/renderer`~~ — **APPROVED 2026-08-04, installed**

> Approved. It's the actual MP4 and stage 7 can't finish without it. Add it to CLAUDE.md's
> stack list at the same time.

Installed and in the stack list. Two things came out of doing it:

**Pinned to 4.0.504, not `latest`.** `pnpm add @remotion/renderer` with no version resolved
4.0.506, one patch ahead of the `remotion` and `@remotion/player` already installed.
Remotion requires its packages to be on the *identical* version, not on compatible ranges,
and a mismatch typechecks, builds, and passes every other guard — then fails when a render
is attempted, on a worker, after the clips have been paid for. `pnpm check:remotion` now
enforces lockstep from the **installed tree** rather than the declared ranges, because a
lockfile can satisfy every range and still disagree with itself. Proven to fail on drift by
exit code.

**Still open: whether the worker image needs anything for Chromium.** `@remotion/renderer`
drives a headless Chromium it brings itself. `check:trigger-build` derives the image's
binary requirements by reading `src/`, so it sees what *our* code spawns and is structurally
blind to what a dependency spawns from inside `node_modules` — it will never mention this,
and it now says so in its own header rather than reading as though it covered everything.

`@trigger.dev/build/extensions` ships `puppeteer`, `playwright` and `lightpanda` extensions.
Which of those (if any) is right for Remotion's Chromium is a question a deploy answers, and
guessing at it would put a wrong extension in the config under a confident comment. **Left
unanswered on purpose** — it is the one remaining item between here and a working render.

The render task itself is not built. The composition *plan* (`src/lib/assemble/composition.ts`)
and the renderer package now both exist; nothing yet joins them.

---

## 4a. The original entry: `@remotion/renderer` — the dependency stage 7's final render needs

**Status:** blocking the second half of item 6. `remotion` and `@remotion/player` are
installed and named in CLAUDE.md's stack; `@remotion/renderer` — the package that actually
produces a file server-side — is **not installed**, and CLAUDE.md's rule is to ask before
adding a dependency it does not name.

What shipped without it: `src/lib/assemble/composition.ts`, the composition's input
contract — cues, hook window, per-format safe box, frame count — with `verify:assemble` §9
exercising it against synthetic timings. That is deliberately the half where the bugs live
(a caption outliving the file, a hook under the platform's chrome, a duration nobody
measured) and it needs no renderer.

What it cannot do without the dependency: produce an MP4.

**Options**

| | |
|---|---|
| A. Add `@remotion/renderer` | The intended path. It is a large install with a headless-Chromium dependency, and it runs in `src/trigger/` only — rule 3 forbids it on Vercel anyway. |
| B. Burn captions with ffmpeg `drawtext` instead | No new dependency; ffmpeg is already required. Loses everything Remotion is for — the hook typography, transitions, anything that is not a subtitle. |
| C. Leave the final render unbuilt | Rough cut only. Phase 1 publishes by hand, so a rough cut is arguably shippable. |

**Recommendation: A, when you are awake to approve it.** B is a real fallback and worth
knowing exists, but it makes the final render a different product from the one the
composition plan was designed for, and `composition.ts` would then be describing a layout
nothing implements — a plan with no consumer, which is the pattern this project keeps
deleting.

**One thing to check before A:** `@remotion/renderer` downloads a Chromium at install. The
Trigger.dev build extension already declares ffmpeg (`check:trigger-build` enforces that
every binary `src/` spawns is declared) — it will need the same treatment, and that check
is what will tell you so.

---

## 5. ~~`USD_INR_RATE` defaults to 88.5~~ — **DECIDED 2026-08-04, option A, implemented**

> Drop the default, require it at the ledger write, not at boot. A worker that never
> touches money shouldn't fail to start, and the rate matters at exactly one moment. Same
> reasoning as `unit_cost_snapshot`.

Done. `src/lib/cost/fx.ts` is the single accessor; the schema field is `.optional()` with no
default; six trigger tasks and three UI paths go through it. Two shapes, because refusing
and reporting are different jobs: `requireUsdInrRate` for anything that writes a ledger row,
`readUsdInrRate` for the pre-flight dialog and the Studio turn, which name the missing rate
as a blocker rather than throwing.

**Finding while implementing it, per standing order 7.** The comment justifying the default
said `profiles.usd_inr_rate` superseded it once onboarding ran. That was false — see entry 7
below, which is the part that is still yours.

The original entry is kept below for the reasoning.

---

## 5a. The original entry: `USD_INR_RATE` defaults to 88.5, and the default lands on money rows

**Status:** found while deriving the worker's environment manifest. Verified in the source
before writing this: `src/lib/env.ts:159` declares it `z.coerce.number().positive().default(88.5)`,
and six trigger tasks pass `usdInrRate: env.USD_INR_RATE` into the cost-ledger write.

So a Trigger.dev environment that never sets it does not fail, warn, or leave a null. It
**snapshots 88.5 onto every `cost_ledger` row**, and `/costs` then presents a rupee figure
this project invented as though it were the rate in force when the money moved. Nothing
downstream can tell that figure apart from a real one — which is the whole difficulty.

That is the "never write a measurement you did not take" rule, applied to the input of the
headline metric rather than to the metric itself. `observedUsdInr` in `src/lib/generate/pilot.ts`
already returns `null` rather than a default for exactly this reason; the schema predates
that decision and never caught up.

The manifest now declares it `required: true` with that reasoning, so `pnpm db:doctor` and
`pnpm check:trigger-env` both name it. **That is a checklist, not a guarantee** — nothing
stops a deploy without it.

**Options**

| | |
|---|---|
| A. Drop the default; make it required at the point of a ledger write | `requireEnv('USD_INR_RATE', 'writing a cost row')`. A worker without it refuses to spend money rather than mislabelling what it spent. Costs: an unset variable now breaks a pipeline that currently runs. |
| B. Keep the default, add `rate_source` to `cost_ledger` | `'configured'` vs `'fallback'`, and `/costs` says which. Honest, surfaces the problem instead of preventing it, and needs a migration. |
| C. Leave it | The rate is roughly right, so the figure is roughly right. Until the rupee moves, or until somebody quotes the number. |

**Recommendation: A.** It is the same shape as the `?? 0` on a duration — a plausible value
standing in for an absent one, in the one path where being quietly wrong is worst. B is
strictly more informative but it makes the fabricated rate a supported state with a column
to describe it, and the fabricated rate should not be a supported state. C is the current
behaviour and the reason this entry exists.

Not done unattended because it changes what a money row means, and because A makes an
absent variable stop a running pipeline — a real operational trade, and yours.

---

## 7. The wizard writes a USD→INR rate that nothing reads — which of the two is authoritative?

**Status:** found while implementing entry 5, and left alone because it changes what a money
row means. Verified before writing this, both directions:

- `src/lib/onboarding/actions.ts:187` writes `usd_inr_rate` to `profiles` from step 1 of the
  wizard. The operator sets it, sees it saved, and reasonably believes it is in force.
- `grep -rn usd_inr_rate src/` finds **no reader on the pricing path**. Every ledger row
  takes its rate from `env.USD_INR_RATE`, threaded through six tasks. The only other reader
  is `pilot.ts`, which reads the rate back off ledger rows to report what was observed.

So there are two configured rates. One is set in a form and does nothing; the other is set in
an environment variable and decides every rupee figure in the product. **The comment in
`src/lib/env.ts` asserted the opposite** — that the profile value superseded the environment
"the moment onboarding step 1 runs" — and that false claim was the entire justification for
the default entry 5 has now removed.

That is the third instance this week of a mechanism named by documentation and implemented
nowhere, and the most expensive of the three, because the other two were merely inert. This
one actively misled: the operator configuring a rate is doing something with no effect, and
believing otherwise.

**Options**

| | |
|---|---|
| A. `profiles.usd_inr_rate` wins where set; env is the fallback | Matches what the wizard already promises and what the comment claimed. Means the rate is per-workspace, which is right if there is ever more than one. Needs the read plumbed into `fx.ts` — but `fx.ts` is currently synchronous and this makes it a query, which touches every call site. |
| B. Env wins; drop the column and the wizard field | Honest and smallest. Loses the ability to change the rate without a redeploy, which is a real operational cost for a number that moves. |
| C. Env wins; the wizard field becomes a display of it | The operator sees the rate in force and cannot edit it there. No lying, no new query. |

**Recommendation: A**, but it is genuinely close, and it is yours because it decides which
number a historical ledger row was priced at — the one property the ledger exists to make
checkable. Whichever wins, **the losing one must stop existing**, because two configured
rates is how this happened.

One thing that is not optional whichever you pick: any row already written carries its own
`usd_inr_rate`, so no past row changes meaning. This decides future rows only.

---

## 8. ~~Two Server Actions with no button~~ — **PLACEMENT DECIDED 2026-08-04**

Decided against your four rules. One has a home; the other does not, and that is the finding.

### `runTrendsNowAction` — **no button. CORRECTED 2026-08-04: my reason was partly wrong.**

**The correction first.** I wrote that "nothing in `src/` reads the trends table" and that
stage 1 was "disconnected at both ends". That was produced by `grep -rn "from('trends')"`,
and **the table is `trend_signals`**. `concepts/run.ts:132` reads it. Stage 1 feeds stage 2;
the chain was never broken, and the claim was overstated in a commit message, this file, and
the handover.

A grep on a guessed table name is not a survey. The lesson is the same one that produced the
independent-routes rule: I checked one spelling and reported an absence.

**What is true, and still justifies the work:** no *screen* has ever shown it. Intake ran and
the only evidence was that stage 2 later produced concepts — which conflates *never captured*,
*captured nothing lately*, and *this source has gone quiet*, three states that send a person
to three different places.

So the reader was built (`/trends`, `src/lib/trends/read.ts`) and the button still is not.
Stage 1 hits somebody else's public feed, and how often to do that is a decision nobody has
made — §4 of ARCHITECTURE says cron four times daily. A button would make the unmade decision
look made, and the screen now answers the question the button was going to be pressed to
answer.

### `requestMetadata` — **the review detail screen, `/review/[renderId]`**

That is where a render is rendered, and metadata acts on a render. No other screen shows one.
`src/components/review/screen.tsx` is the file; beside the pass/fail decision, since passing
is the precondition the task itself enforces.

**But rule 4 collides with something true, and I did not fabricate my way past it.** You said
anything that spends shows the estimate before it fires. `src/lib/cost/llm.ts` documents why
that is not obtainable here: *"A Messages call is synchronous and priced on tokens that do not
exist until it returns: there is no honest estimate to write beforehand. The input token count
is not knowable without a separate billed count_tokens call, and the output count is not
knowable at all."*

So a pre-flight rupee figure for this button would be a number I invented — the exact thing
the last three decisions have been removing. What is honestly showable is a **measured prior**:
what the last metadata draft actually cost, from `cost_ledger`, labelled as the last one rather
than as this one. That satisfies the intent of the rule (the operator sees the consequence
before pressing) without asserting a measurement nobody took.

Rule 4's other half is unconditional and easy: it refuses on an unverified rate, which
`readUsdInrRate` now returns as a named blocker.

**Not built this session** — I ran low on context and a half-landed button on the publish-gate
screen is not something to leave. The decision is made and the file is named; the build is
mechanical. Copy for your review when it lands.

---

## 8a. The original entry: two Server Actions with no button

**Status:** found by the sweep, and the code is corrected to stop lying about it. What is
left is placement and copy, which is why it is here rather than done.

`runTrendsNowAction` (stage 1) and `requestMetadata` (stage 9) are both complete, both
enqueue their task correctly, and **neither is called by anything**. The two Trigger tasks
each carry a header paragraph claiming the opposite — see CLAUDE.md's new entry on a caller
that is itself uncalled; the comments have been corrected to say what is true.

Nothing about the mechanism is in question. What I did not want to decide unattended:

| | `runTrendsNowAction` | `requestMetadata` |
|---|---|---|
| Where | `/trends`? the board? Settings? | The review screen, presumably beside the pass decision |
| When enabled | Always, or only when the last run is older than something? | Only after a passing review — the task refuses otherwise, so a button that is always live means a button that usually errors |
| Copy | "Run now" vs "Check for trends" — the second is honest about it hitting somebody else's feed | "Request metadata" vs "Draft title and description" |
| The real question | §4 of ARCHITECTURE says stage 1 is cron four times daily. A manual button may be a stopgap or may be the actual Phase 1 answer | Whether this is a button at all, or whether passing a review should just enqueue it |

**Recommendation: build both as buttons, and make `requestMetadata` automatic on a passing
review as well.** The metadata task refuses without a passing review anyway, so the review
passing *is* the trigger condition — a button that can only be pressed at exactly one moment
is a worse version of doing it at that moment. Keep the button too, for re-drafting.

For trends, a manual button first and the cron after the schedule decision, which is a
decision about how often to hit a public feed and is yours.

---

## 6. ~~Safe-area insets~~ — **DEFERRED 2026-08-04, blocked on you, registered as such**

Your framing adopted exactly: conservative published margins as a starting constant, marked
unverified in the same register as everything else, with the exact verification named.

State today, unchanged and correct:

- `SAFE_AREAS` in `src/lib/assemble/composition.ts` carries `verified: false` on all three
  formats, and every plan reports that as a problem.
- `planComposition` **refuses** on `no_safe_area` rather than defaulting. Kept, as instructed.

What this entry adds is the last clause: **blocked-on-you, not blocked-on-work.** There is no
task queued behind this and nothing to build. The verification is named and it is fifteen
seconds of your time:

> Post one video. Screenshot it with the platform's own UI overlaid. Measure where the title,
> handle and action rail actually land. Set the fractions and flip `verified`.

Recorded here rather than left implicit because "deferred" and "nobody has got to it" look
identical in a backlog, and only one of them is waiting on a person who knows it.

---

## 6a. The original entry: safe-area insets have never been checked against a real post

`SAFE_AREAS` in `composition.ts` carries `verified: false` on every entry and every plan it
produces reports that as a problem. The numbers are conservative guesses at where each
platform's own chrome sits.

Fifteen seconds each, on a phone, once there is a video to post: play one, note where the
title, handle and action rail actually land, and set the fractions. Until then the flag says
the insets are unmeasured, which is the honest state — and captions under the follow button
look like a design choice rather than a bug, so nothing else would catch it.

No options and no recommendation. It needs eyes on a handset, which is yours.

---

## 9. The seven hook shapes are a guess made before any evidence existed

`scripts.hook_pattern` (migration 0034) is the key `v_hook_performance` groups on, and
therefore the key the whole learning loop reports against. It has seven values:

| Shape | What it means |
|---|---|
| `number_claim` | a figure carries the promise |
| `contradiction` | states the received view, then denies it |
| `warning` | a cost of not watching |
| `demonstration` | shows the outcome first, explains after |
| `story_open` | mid-scene, the resolution withheld |
| `question` | opens by asking; the viewer answers in their head |
| `direct_address` | names the viewer or their situation |

They are assigned by a deterministic classifier (`src/lib/measure/hook-pattern.ts`), not a
model call — reproducible, backfillable over the archive, and free, which are the three
properties a rollup's grouping key needs. The order above is the precedence: a hook can
satisfy several tests and the first match wins.

**What needs your judgement is the taxonomy, not the mechanism.** I wrote it from what these
shapes look like in general, with no data from this channel and no video published. Two
specific things I would expect to be wrong:

- **`question` and `direct_address` are the catch-alls.** Almost every short-form hook
  addresses the viewer, so `direct_address` will collect anything that fell through, and its
  bucket will be the largest and least meaningful. Whether that matters depends on whether
  the others fire often enough.
- **The precedence puts `number_claim` first.** "Why do 90% of these fail?" is a question
  and a number claim; I ranked the figure above the question mark on the grounds that a
  figure is what a viewer remembers and what a writer can deliberately reuse. That is
  arguable and it is one line to change.

**Recommendation: leave it and change it once there is data, not before.**
`hook_pattern_version` exists exactly for this — reclassify the archive, and the two versions
stay distinguishable so a rollup cannot silently mix groups that were drawn differently. The
cost of guessing wrong now is one backfill; the cost of waiting is that the first few videos
group under a taxonomy you would not have chosen, which the version column makes recoverable.

What would change my mind: if you already know from your own channel which three or four
shapes actually recur, seven is too many and the extra buckets will each hold one video.
Tell me the shapes and I will replace the list.

---

## 10. `7d` is the headline bucket, and nothing has tested that

`v_hook_performance`, `v_recipe_performance`'s outcome half, and the `/analytics` cost-per-1k
table all read the `7d` snapshot. `6h` and `24h` are still moving; `30d` measures how a video
was distributed rather than how its hook performed.

**Recommendation: keep `7d` and revisit after ten videos.** It is one constant
(`HEADLINE_BUCKET` in `src/lib/measure/read.ts`) and all four buckets are captured
regardless, so changing it re-reads history rather than losing it. The reason it is worth
flagging at all: if short-form on this channel does most of its distribution in the first
48 hours, `7d` is measuring the tail and `24h` is the hook signal — and that is a fact about
the platform and the niche, which is yours to know rather than mine.
