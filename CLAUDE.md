# CLAUDE.md — Kiln

AI video content pipeline. Trend → concept → script → shots → generate → assemble → review → publish → measure.
Read `docs/ARCHITECTURE.md` before proposing anything structural. `docs/SCHEMA.sql` is the source of truth for data shape.

## Stack

Next.js 15 (App Router) on Vercel · Supabase Postgres · **Supabase Storage** (S3 protocol) ·
**Trigger.dev v4** · Remotion + ffmpeg · **`@remotion/renderer`** for the final render ·
**Remotion Player** (`@remotion/player`) / Vidstack /
**wavesurfer.js** on the review screen · Higgsfield (**`@higgsfield/client`**) · ElevenLabs · Anthropic SDK ·
TypeScript strict · pnpm

The three Remotion packages must sit on the **identical** version, not on compatible ranges.
`pnpm check:remotion` enforces it from the installed tree rather than from the declared
ranges, because a lockfile can satisfy every range and still disagree with itself — which is
what happened the minute `@remotion/renderer` was added with no version and resolved one
patch ahead of the other two. A mismatch typechecks, builds, and passes every other guard
here, then fails when a render is attempted: on a worker, after the clips being assembled
have been generated and paid for.

Reconciled against the addenda and the decision records on 2026-08-03. Four entries here had
drifted, and one of them fired the vendor rule against correct code: `wavesurfer.js` is named
in Addendum 02 §5 and was absent from this list, so adding it read as an unapproved
dependency. **A stale stack list does not just misinform — it makes a correct rule reject
correct work.** The changes, each with its record:

| Was | Is | Why |
|---|---|---|
| Cloudflare R2 | Supabase Storage over the S3 protocol | 0007 — one vendor instead of two, same interface |
| Trigger.dev v3 | v4 | 0001 — v3 is frozen at 3.3.17; v4 is the current major |
| `higgsfield-js` | `@higgsfield/client` | 0004 — the package that name actually publishes |
| *(absent)* | Remotion Player, Vidstack, wavesurfer.js | Addendum 02 §5 named them; this list never did |

## Non-negotiable rules

1. **No vendor name outside `src/lib/drivers/`, `src/lib/publish/` or `src/lib/storage/`.** `pnpm check:vendors` enforces it — see `scripts/check-vendor-isolation.sh` for the exact grep, which is case-insensitive and covers comments. CI has enforced it for real since `17e22cd`; before that the workflow never got past dependency install (0008 §0). If a task seems to need a vendor call elsewhere, the driver interface is wrong — fix the interface. It has caught six violations and been right every time, including once against a comment that named a vendor while explaining why not to.
2. **No media bytes through a Vercel route.** 4.5MB hard limit, not configurable. Browser↔bucket by presigned URL; worker↔bucket direct. Vercel handles IDs and URLs only. `StorageDriver` hands out URLs and never bytes, which is what keeps this structural rather than remembered — byte-moving helpers live in the driver module and are imported only by `src/trigger/`.
3. **No ffmpeg, Remotion, or generation polling on Vercel.** No GPU, 800s cap. All of it lives in `src/trigger/`.
4. **Webhooks over polling** for every external async job. Polling burns undocumented rate limits.
5. **Every external call that costs money writes a `cost_ledger` row at submit time**, before the result comes back. Reconcile on completion. No exceptions — cost-per-video is the project's headline metric and it cannot be backfilled.
6. **Every generation carries an `idempotency_key`.** Retries must not double-charge.
7. **Publishing is gated by the `enforce_review_pass` DB trigger.** Do not add an application-level bypass, a `force` flag, or an admin override. This gate is a compliance control, not a workflow convenience — see §0.2 of ARCHITECTURE.md.
8. **A feature is done when it's visible and triggered in a real run against real APIs.** Passing tests with a mocked driver is not done.

## Conventions

- Server Components by default; `"use client"` only where interaction demands it.
- Zod schema at every boundary: driver responses, webhook bodies, LLM JSON output. Never `as` a parsed external payload.
- DB types generated from Supabase (`pnpm db:types`), never hand-written.
- Trigger tasks are numbered by pipeline stage (`01-trends.ts` … `11-measure.ts`) and are individually replayable from any prior stage's output. The number is the stage, **not the running order**: stage 6 (voice) runs before stage 5 (video), because word timings set shot durations — Addendum 02 §1. `05b-ingest` carries a letter for the same reason: it is part of stage 5, not a stage of its own.
- Migrations in `supabase/migrations/`, forward-only.
- LLM prompts live in `src/lib/prompts/` as versioned files, not inline template literals.

## Working with Higgsfield

Three surfaces, different jobs — do not confuse them:

| Surface | Use for | Never use for |
|---|---|---|
| Hosted MCP `https://mcp.higgsfield.ai/mcp` | Interactive exploration in this Claude Code session: trying models, motions, seeds, character refs; finding shot recipes | Production runs, cron jobs, anything needing retries or cost attribution |
| `@higgsfield/client` SDK (REST + webhook) | Everything in `src/trigger/` | Interactive back-and-forth |
| **Kiln's own MCP server** at `/api/mcp` | The Studio lane. Opus 5 reaches the drivers through tools that write every row | Exploration — it refuses anything the workspace is not set up to do, which is correct and not what you want at 1am with a seed to try |

When an MCP experiment produces a shot recipe that works, persist it to the `prompts` table with `discovered_in='claude-code-mcp'` and the exact params. Production reads the library; it never improvises.

Known Higgsfield behaviour: undocumented rate limits (fail silently), credits expire ~90 days, sparse docs, API gated to higher-tier plans. Treat every call as unreliable — timeout, retry with backoff, circuit-break after N consecutive failures, and surface credit balance in the dashboard.

## Definition of done for a pipeline stage

- Trigger task exists, is replayable, and has a concurrency limit set
- Writes its rows; failure states are rows too, not swallowed exceptions
- Cost rows written where money moved
- UI surface exists for inspecting and, where relevant, overriding it
- Ran end-to-end once against real APIs with a real output you watched

## Verification

`docs/decisions/0008-what-is-unverified.md` is the live register of what has and has not
executed. Read it before claiming anything works. Rule 8 is not satisfied by a passing
typecheck, and this project has now twice found a defect that only a real run could reveal —
a CHECK constraint rejecting a plausible value, and a schema that made an addendum's own
mechanism uncomputable.

`pnpm check:gates` is the guard on the guards: it fails when a `check:*`, `test:*` or
`verify:*` script is reachable from neither `pnpm check` nor CI, and when an exemption
outlives its reason. It runs first in both. Two guards had already gone unwired before it
existed — see 0008 §0a.

**When two measurements of the same thing disagree, find out which instrument can observe
it before believing either.** Not "average them", not "trust the alarming one" — establish
which one is even capable of seeing the thing, and discard the other's evidence entirely.

The case that produced this rule: a headless screenshot of the tour showed no 3D backdrop,
while a `readPixels` probe on the same canvas in the same frame reported it drawn and gave
its bounding box. The screenshot was wrong — headless Chromium does not composite the WebGL
layer into `captureScreenshot` — and it won anyway, for an hour, because a picture is more
convincing than an array of numbers. An already-correct scene got retuned twice on its
evidence, and the second retune made the scene invisible for real.

The tell is that a picture *feels* like ground truth and a probe feels like a proxy, when
here it was the exact reverse: `readPixels` reads the actual framebuffer, and the screenshot
is a composite of layers one of which was missing. Feeling authoritative is not a property
of instruments. Ask what each one physically reads, and prefer the one closer to the thing —
then make the winner an assertion so the next disagreement resolves itself.

This is a third failure mode alongside the two above. A guard that runs nowhere claims
coverage it does not have; a guard that cannot tell drift from an empty schema reports a
real number about nothing; and a guard that can see is overruled by one that cannot.

**An option whose default IS the behaviour you are avoiding must be passed explicitly.**
Never omitted under a comment saying what you intend. `client.generate()` reads
`options?.withPolling ?? true`, so leaving it out — which is what "we don't poll" looks like
in the source — polls. The driver omitted it under a comment stating the opposite, and the
comment was the exact inverse of the behaviour: in production it would have held a Trigger
worker open for the length of a whole video generation while hammering an undocumented rate
limit that fails silently. Omission is not a position. Read the default before you rely on
it, pass it, and where the cost is this asymmetric, assert it — `verify:submit` counts the
requests one submit makes, because a comment cannot hold this and a count can.

**A chain can be complete, reachable and green at every stage and still be provably inert
end to end.** This is a third failure mode and per-stage harnesses cannot see it, because
every stage is correct. Stage 5 refuses any shot whose duration is still an estimate; only
stage 6 sets `derived_from_vo`; stage 6 needs a voice id, and the host voice was a constant
in a fixtures file rather than a column. So 03 → 04 → 05 submitted zero shots, every time,
for ever — with fifteen harnesses green and nothing to see in any of them.

**When the failure mode is silence, build the thing that reads silence back.**
`v_pipeline_blockers` is the pattern: for every script, the *first* reason it cannot reach a
generation, ordered by how early the stage sits, or null when nothing blocks it. Not an
alert and not a log line — a row you can select. Reading silence back from four tables is
how it goes unnoticed for a week, and "no error anywhere" is exactly what an inert chain
looks like.

The test for whether you have this problem is not "does each stage work". It is: **can I
name, in one query, why nothing came out?** If the answer needs four joins and a hypothesis,
build the view before building the next stage.

**An assertion is evidence only when its two sides arrive by independent routes.** One
root, three surfaces so far, and the general form is what makes the fourth one findable:

| Surface | Instance | What independence means there |
|---|---|---|
| A view checked against a model of itself | `verify:submit` §9 — the assertion expected null because it was built from the same understanding of the world the view was built from; both were wrong together | The consumer: stage 5 actually submitting is the only evidence that null meant generatable |
| A harness asserting a row it seeded | `seedScript` wrote `compiled_params`; the assertion read it back and would have passed whatever `compileShot` did | Drive the code under test and assert its return value |
| An identity over one source's own numbers | `verify:concepts` §7 divided the view's `batch_inr` by the view's `concepts_landed` and compared to the view's `inr_per_concept` — a ÷ b = c holds however wrong a and b are | Fetch the denominator from the `concepts` table, which the view does not control |

The mechanical test for all three, and for the fourth when it arrives: **trace each side of
the comparison back to the line that produced it. If the traces meet before they reach the
code under test, the assertion is a tautology** — it can fail only on a typo, and green
means a source agrees with itself.

**A check can measure exactly the right thing and still be vacuous, because the state it
measures was unreachable.** This is a third failure mode for guards, distinct from the two
above: not a guard that runs nowhere, and not a guard measuring the wrong quantity — a guard
measuring the right quantity in a world where the precondition could not occur.

`verify:submit` §9 asserted `blocker === null` for a script it called ready, and passed for
days. The view returned null, the assertion expected null, and both were wrong about the
world: the workspace had no verified video integration, so stage 5 would have refused that
script every time. Nothing was miswired. The check simply never entered the state it was
describing, and green meant only that.

The tell is the first surface of the independent-routes rule above. **So
close the loop with the consumer, in both directions:** when the producer says blocked, the
consumer must refuse for the same reason; when the consumer succeeds, the producer must have
said clear. The second half is the one worth adding first — it is what catches an assertion
that has never run in the state it claims to test. Adding it here found a real defect in one
run: stage 5 submitted, and paid for, a shot on a script the view called blocked.

**A claim of exhaustiveness must be verified by enumeration, not by inspecting the case in
front of you.** "There is no other place this happens" is a statement about the whole
codebase, and reading one module cannot support it. I wrote that a fourth `ON CONFLICT`
against a partial index was impossible because the third had been folded into
`writeLlmCost` — from inside `writeLlmCost`, which covers LLM subjects priced in tokens. A
fourth writer had existed all along in `voice/run.ts`, because voice is priced in characters
and was never in scope of the module I was looking at. Before writing "the only", "there is
no other", or "this cannot happen again", grep for the *shape* across `src/` and paste the
result — and if the shape is hard to grep for, that is the finding, not an excuse.

**When two things in adjacent code share a name and mean different things, the collision is
itself the defect.** `submit.ts` builds a vendor payload with `stage: 'still'` — the vendor's
field for which half of the two-call chain is being submitted — twenty lines above the
`cost_ledger` insert, whose `stage` column means the pipeline stage. The ledger row set no
stage for months, and every reading of that code saw the word `stage` next to a value and
moved on. `v_cost_by_stage` filtered on `stage is not null` and could not see the most
expensive stage in the pipeline; the collision is what made the omission invisible. Rename
one side the moment you notice, even when both names are locally correct — *especially*
then, because a locally correct name is the one nobody flags in review.

**A number a screen withholds must be withheld by a probe, not by a constant.** The
difference between a documented limitation and a permanent one is whether the screen can
turn itself back on. `consumptionObserved` is computed from the rows — *has anything ever
written this column* — so the day a writer lands the balance appears with nobody
remembering to change it. A hardcoded `false` behind a comment saying the same thing looks
identical in review and stays false for ever. `src/lib/pipeline/observability.ts` is the
register; an entry there is only correct while the number is genuinely unknowable from the
rows we have, and the probe is what keeps that honest. Assert the flip, not just the
withholding — the withheld half passes on an empty database whatever you write.

**A guard that permits the outcome its own message names is a fourth failure mode, and the
refusing half tests green.** Not a guard for a state that cannot occur, and not one
measuring the wrong quantity — one whose *accepting* branch delivers exactly what the
refusal warns against, while reading as protection. Two instances, found one round apart and
identical: `submit.ts` and `compile.ts` both refused a shot when no recipe was marked
`accepts_character_ref`, warning that the alternatives "would generate a different-looking
person and bill for it", and both accepting branches passed no reference either — nothing in
`src/` reads the `characters` table.

The tell is that a guard's test only exercises the refusal. That half passes on an empty
database whatever the accept branch does, and it reads as coverage. **So for every refusal
whose message names a bad outcome, assert that the accepting branch prevents that outcome** —
by driving the accepting path, not by inspecting a fixture that was seeded past it. And when
two stages guard the same thing, share one predicate: they drifted into the same wrong shape
independently, and fixing one leaves the other claiming a protection it lacks, which reads
exactly like a whole fix.

**Never write a measurement you did not take.** When rule 5's reconcile cannot be obtained —
the vendor's response carries no figure — the fix is not to write a reconcile equal to the
estimate. That puts a fabricated number in the table everything derives from,
indistinguishable from a measured one, and the ledger's whole value is that its rows can be
checked. Record instead *how the figure was arrived at* (`cost_ledger.cost_source`), count
the estimate, and label every surface that shows it. A real measurement lands the same way a
verified rate does: by watching a balance move, not by reading a response body.

**Mark the load-bearing assertion where two look alike.** `verify:submit` §0 and the old §9
are the same three lines; §0 means something only because §4 submits to a vendor and then
asserts the view said null about it, and nothing in §0 says so. A future reader has no way
to tell them apart — and the vacuous one is the one that looks reassuring, because it makes
a clean claim with no messy dependency. So where a section contains an assertion the others
rest on, say `LOAD-BEARING` on it and name what makes it true. Two rules of thumb for which
one it is: it is usually the assertion about rows that do *not* exist, and it is usually the
one whose subject was produced by a different module than the one doing the asserting.

**The second surface of the independent-routes rule, and the one most likely to repeat:
an assertion whose subject was written by the harness rather than by the code under test.** `seedScript` inserts
`compiled_params` itself, so asserting against the seeded `shots` rows would have passed
whatever `compileShot` did — including nothing. The fix was to call `compileShot` directly
and assert its return value.

The tell is mechanical and worth applying to every harness, because **every harness seeds**:
*if the harness produced the row you are asserting about, you are testing the harness.* Ask
of each assertion which line wrote the value being read. If the answer is a fixture helper
rather than a call into `src/`, the assertion is describing the setup.

Seeding is not the problem — a harness has to create a world. The problem is asserting
against the part of that world the harness wrote rather than against what the code did to
it. Seed the *inputs*, assert the *outputs*.

**The column name tells you nothing.** `shots.compiled_params` is written by production —
by stage 4, which is exactly what made the bad assertion look right — and in that harness it
was written by `seedScript`. Only the line that wrote it *in this run* decides. Sweeping the
other harnesses on that basis found them clean, and the reason is structural rather than
lucky: they read `shots.status` after `submitShots` set it, `renders.status` after
`assemble()` set it, `concepts.status` after `approveConcept` set it. `verify-review` had
already written the rule down in a comment — *"asserted against the database rather than
against an assumed baseline … hardcoding 1 here would have been an assertion about the
fixture"* — one harness before it was needed.

**Every `bigint` and `numeric` crosses the wire as a string, and a loose comparison hides
it.** Third instance now: `timesCompiled` arriving as `"3"`, `count(*)` as `"4"` in a
`===` against a number, and `concepts_landed > 0` passing because `"4" > 0` coerces true.

The two facts that make this worth a rule rather than three fixes. **Postgres sends `bigint`
and `numeric` as text on purpose** — both exceed what a double can hold exactly, and the
driver will not silently lose precision on your behalf. And **the detection and the fix are
the same change**: `>`, `<`, `==` and truthiness all coerce, so they work and hide it;
`===`, `Number.isInteger` and arithmetic against a literal do not. Writing the strict
comparison is how you find out.

**And `Number()` is a decision, not a conversion.** The stringiness is a correctness
guarantee rather than a transport quirk — Postgres will not silently lose precision on your
behalf, so wrapping in `Number()` is *accepting* precision loss because the range is known
safe. A row count, a token count and a rupee figure all are. A `bigint` id, an external
byte offset, or anything that could exceed 2^53 is not, and for those the string is the
value: compare and store it as text and never let it near a double. Write it so it reads as
a decision, because "just wrap it in `Number()`" is the lesson somebody takes away
otherwise, and it is the wrong one exactly where it matters most.

So: `Number()` at the boundary, in the mapper that turns a row into a domain object, never
at the point of use. A sweep of `src/` found the convention already held everywhere except
`concepts/run.ts`, where `velocity` and `volume` reached a typed `number | null` field
uncoerced — harmless today because the only consumer interpolates it into a prompt, and a
silent coercion the first time anyone writes `s.velocity > threshold`. The type would have
promised it could not happen. `verify-vault` had the inverse: `remaining === '0'`, correct
by hard-coding the transport's stringiness, which inverts the idiom every other harness uses
and fails for the wrong reason the day the driver returns a number.

**A sixth variant, and the hardest to see: an assertion phrased loosely enough to stay true
in a world it was not written for.** Not vacuous when written — genuinely testing something
— but survivable by the very change it should have caught. `verify:concepts` §5 exists
because "a failure path that drops the usage under-reports cost permanently", and asserted
`costInr > 0`. A truncated call recorded as 1 input token instead of 800 passes that. The
section's whole subject was 4,000 output tokens billed for nothing usable, and the
assertion could not see the number.

The test is not "is this assertion true" but **"what change would leave it true that should
not?"** Where the harness fixes the inputs — a stubbed usage, a seeded rate — the exact
answer is computable and there is no reason to assert a weaker one. `> 0`, `.length > n`,
`.test(/substring/)` and truthiness are all this shape: they describe a family of worlds,
and behaviour changes move you between members of it.

Two things fell out of tightening four of them. Simulating the exact bug §5 was written for
— halving the stubbed output tokens — now fails the harness, which it did not before. And
`concepts_landed > 0` was hiding a bigint-as-string boundary, because `"4" > 0` coerces
true while `"4" === 4` does not: a loose assertion can conceal a type confusion as easily as
a behaviour one.

The counter-example worth remembering is the one that behaved: `verify:submit` §4 asserted
`blocker === null` after a successful submit, and when the pilot gate landed it **failed**
rather than surviving. That is what a tight assertion does when the world changes — it
breaks, you look, and you restate it deliberately.

Before adding a gate or an assertion, ask what write path produces the state it guards. If
the answer is none, the guard is this failure mode being built on purpose. A fourth
workspace gate for "active recipes that carry no shot kind" was dropped for exactly that
reason: both write paths validate through `RecipeInputSchema`, so the state cannot occur.

**And when you build it, check it can see the blockers that belong to no row.**
`v_pipeline_blockers` checked four things and every one was a property of a row belonging to
the script. Stage 5 refuses on three more that belong to no script at all — no verified
video integration, an empty prompt library, no verified credit rate. So on a workspace with
an unverified integration, a script with a host voice, shots, compiled parameters and derived
durations returned `blocker = null`. Null means nothing is stopping it. The board rendered it
ready; stage 5 would have refused it every time, for ever. The instrument built to read
silence reported silence as readiness. A per-row view sees per-row problems; ask what the
consumer refuses on that is *not* about any row, and put those first — they block everything
at once, which makes them the earliest thing to fix.

**A mechanism built to surface a failure mode is itself subject to that failure mode.**
`v_pipeline_blockers` made silence readable, and nothing read it — the board derived state
from row counts, so a concept that would never move rendered as `shot_listed` for ever. The
instrument for finding invisible problems was invisible.

So whatever you build to make a problem visible needs its own answer to **"and what reads
this?"** — named, in the same change, before it counts as done. A view with no caller, an
alert nobody routes, a log line in a file nobody opens: each is the original problem wearing
the costume of its own solution, and each is *harder* to notice than what it replaced,
because its existence reads as coverage.

**An absence result is only evidence if the search term was verified to exist.**
`grep -rn "from('trends')" src/` returned nothing, and that nothing became a confident
architectural conclusion — that stage 1 wrote rows no code read, that it was "disconnected at
both ends" — which went into a commit message, a decisions file and a handover. The table is
`trend_signals`. `concepts/run.ts` reads it and always had.

A search that finds nothing has two explanations and they are indistinguishable from the
output: the thing is absent, or the term is wrong. Only one of them is a finding. So before
reporting an absence, **run a search that must succeed** — grep the identifier's definition,
list the tables, find one known caller — and paste it beside the empty result. A positive
control costs one command and is the difference between a measurement and a typo.

This is the same failure as a guard that runs nowhere and a probe that reads the wrong
surface: the instrument returned a clean answer about a question it was not asked.

**Every refusal that lives in a Trigger task is untested, because no harness imports a
task.** Fifteen harnesses drive `src/lib/` functions with a deps object; `grep -rn "trigger/0"
scripts/` returns nothing. So the seven `throw`s in `src/trigger/` have no coverage of any
kind — including the two in `05-generate.ts` whose own messages say that a submit without
them "runs, it bills, and nothing ever confirms it."

The gap is invisible because `verify:submit` is thorough and green. It drives `submitShots`
directly with `webhookBaseUrl` hardcoded in its deps object, so the task's `requireEnv` guard
above it is not merely unexercised — it is **unreachable from the harness**, and no amount of
adding assertions there would reach it.

Two rules follow. **Put a refusal in the lib function, not in the task**, wherever it can go
there: the task should resolve configuration and hand it down, and the function should decide.
And when a refusal genuinely belongs to the task — because it is about the environment the
task runs in — say so where it is written, because the alternative is a guard that reads as
protected and is not.

This compounds with the rule below: scaffolding that guarantees a value exists means the
refusal branch never runs even where a harness could reach it. `verify:submit` sets
`WEBHOOK_CALLBACK_BASE_URL ??=` at the top and no harness anywhere deletes an environment
variable to exercise a refusal.

**A harness setting a value with `??=` can silently restore the world a change was meant to
remove.** Four did. Removing `USD_INR_RATE` from the schema should have broken every harness
that depended on it; instead `process.env.USD_INR_RATE ??= '88.5'` at the top of four of them
put the deleted default back, in the one process where the deletion was supposed to be
observable. They passed, and proved that the code works when the thing you just removed is
still there.

This is the same family as an assertion whose subject the harness wrote, but the mechanism is
different and worth naming separately: not *seeding a row you then assert about* but
**scaffolding restoring a deleted default**. The tell is different too. Seeding is visible at
the assertion; this is fifty lines away in a setup block nobody reads, and `??=` in particular
reads as defensive politeness — "only if it isn't already set" — when what it does is
guarantee the value exists no matter what the code under test now believes.

So: when you delete a default, a variable, or a fallback, **grep the harnesses for it before
you believe they pass**. A harness that still names a thing you removed is either restoring it
or asserting against it, and both are worse than a red build. And prefer a literal in the
harness to an environment write: `const usdInrRate = 88.5` fixes the input where the test can
see it, and cannot leak into a code path that was supposed to have stopped reading it.

**A caller that is itself uncalled is not a caller.** "Does this have a caller?" is the
question this project asks to avoid building the complete-and-unreachable module, and it is
not safe to ask one link deep. Reachability is transitive and terminates only at something
outside the code: a route, a page, a component a page renders, a Trigger task, a cron, a
harness, or a framework convention like `middleware`. Anything else is an island, however
many arrows point into it.

Three instances, found in one sweep, and two of them **say in their own header that they
avoided this**:

| Module | The comment | The fact |
|---|---|---|
| `01-trends.ts` | *"Its caller is a button, not a cron. `runTrendsNowAction` invokes this … what mattered immediately is that this task had no caller at all, which is the category three other modules were just pulled out of"* | `runTrendsNowAction` has no caller. There is no button. The chain got one link longer and still ends in nothing |
| `09-metadata.ts` | *"It has a caller from the day it exists … written this way deliberately: a sweep three rounds ago found four complete-and-unreachable modules, and the cheapest moment to avoid being the fifth is now"* | `requestMetadata` has no caller. It is the fifth |
| `verify.ts` | `onboarding/actions.ts`: *"`isUsable()` still returns false and every pipeline task still refuses"* | `isUsable` had no callers; `usability` is what the tasks call. A second name for one concept, alive only in prose |

The tell is that **the prose was the evidence**. Each was written by someone who had just
been burned by an unreachable module, checked for a caller, found one, and stopped — which
is one step further than not checking at all and lands in the same place. Add a link and the
question feels answered.

So: when you write "this has a caller", name the *entry point*, not the intermediate — "the
Review screen's Request metadata button calls this" is checkable and "`requestMetadata`
calls this" is not. And when you read such a comment, follow it to the end before believing
it. The two above are worse than silence: they are a claim of coverage that reads as having
been verified.

**"Absent" and "zero" are different facts and must never share a representation.** Five
instances now, which makes it a rule rather than five local judgements:

| Absent | Zero |
|---|---|
| no verified rate — the call refuses | the call is free |
| never run | ran and failed |
| step deferred | step done |
| recipe never compiled | compiled and never shipped |
| ffprobe could not read the duration | the file is 0 seconds long |
| no video has finished, so cost per video is undefined | videos cost nothing |

**The canonical example is the last row, because it is the rule applied to the one number
rule 5 calls the headline metric.** `/costs` today has four ledger rows, ₹6.07, and zero
renders. Cost per video is therefore *undefined* — there is no video to divide by — and the
screen says so in those words. "₹0.00 per video" would be a claim that this pipeline
produces videos for free, made by a page reporting that it has never produced one. That is
clearer than any of the display cases above: it is not a missing measurement rendered
wrongly, it is a **division by an empty set rendered as a result**. Whenever an average, a
rate, or a per-unit figure has no denominator, the answer is undefined and the screen must
say undefined.

The ffprobe row is the sharpest of the display cases. `probe()` returned `width ?? 0, height ?? 0, durationS ?? 0`,
so an unreadable file became 0×0×0s — `isCanonical` compared 0 against 1080, said no, and
the pipeline **re-encoded a file whose properties were unknown** instead of reporting that
it could not read it. The duration went to the assembler as a measurement, in the one path
where a wrong duration has already produced three bugs that made a file which plays and is
wrong.

In the database use `null` and let a CHECK or a view keep it honest; in TypeScript use
`null` and make the type carry it; on screen use an em dash and never `0`. `?? 0` on a
value that means a measurement is the smell — grep for it. The cost is asymmetric: a
missing thing rendered as zero is silently believed, summed, and acted on, while a zero
rendered as missing is merely annoying.

**Two modules for one concept is worse than none.** `src/lib/generate/normalise.ts` and
`src/lib/ingest/normalise.ts` both existed; one defined `TARGET`/`conforms`, the other
`CANONICAL`/`isCanonical`, they disagreed about the canonical intermediate, and only one was
live. Nothing was broken and no test could show it — both compiled, the live one passed its
harness, and the dead one passed by not running. The cost is that the next person to tune
the encoder had a coin-flip's chance of editing the file that does nothing, then debugging
why their change had no effect. When you find the second module, delete one; do not
document the difference. A superseded file is not history — git is history.

**When CI is the only instrument, reading it is part of the item, not the report.** This was
learned the expensive way: four consecutive runs went red while three more commits landed on
top of them, each commit saying "CI is the check" and none of them reading it. A red run
halts the queue — the next item does not start until the step list for the previous commit
has been read.

The reading is specific, not a glance at the badge. Get the failing **step name** and the
**annotation**, because "all jobs have failed" names nothing and the postgres service log is
full of errors from harnesses deliberately provoking refusals. On the run that produced this
rule, the most alarming line in the log — a `scripts_pilot_decided_once` violation — was
inside a step that *passed*.

And prefer restoring the ability to verify over working around its absence. A local scratch
cluster is three commands (`initdb` as a non-root user, `pg_ctl -o '-p 55432'`, `db:push`)
and turns every harness back on. Writing tests you cannot execute, in a session where you
are also not reading CI, is how a green report and a red branch coexist for four runs.

```bash
pnpm doctor                          # which failure is this? — run this first, always
pnpm verify:ingest   "$DATABASE_URL" # 3 shapes → canonical, corrupt → error row
pnpm verify:assemble "$DATABASE_URL" # 6 clips → one MP4, over a real S3 endpoint
pnpm verify:studio   "$DATABASE_URL" # MCP server over real HTTP; generate_shot refuses
pnpm verify:review   "$DATABASE_URL" # a trim drifts every later shot; the publish gate holds
```

**Check the exit code. Never grep the output for a failure marker.** `pnpm check` chains
eight tools; five are this project's harnesses, which print `FAIL`, and three are eslint,
tsc and shell scripts, which do not. Verifying the chain with `grep -cE '✗|FAIL'` reported
zero failures on a run that exited 1 — eslint prints `✖` (U+2716), not `✗` (U+2717), and
the word "error". Six commits were pushed claiming CI was green while it had been red or
hanging the whole time.

The general form: **a summary written in one tool's vocabulary cannot see the others.**
`$?` is the only signal every one of them agrees on. If a command's result matters, branch
on its exit code; if you want the detail too, capture the output *and* the code, and let
the code decide.

## Current phase

Phase 1 — see `docs/ROADMAP.md`. Publishing is manual (download + copy metadata). Do not build auto-publish until Meta app review clears.
