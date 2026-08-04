# What exists, and what it has actually done

**Written:** 2026-08-03 · **Method:** surveyed from the repository and the databases, not
transcribed from `0008`. Every count below is from a run performed while writing this.

`HANDOVER.md` is what you do next. `0008` is the running register of what is unproven and
why. **This is the standing inventory**: everything that exists, sorted by the strength of
the evidence behind it. Read it when you have lost track of which claims are proven and
which are merely wired — which is the reason it exists.

---

## The one-paragraph version

One vendor has ever been called from this codebase: **Anthropic**, twice, on 2026-08-01,
producing a script and a shotlist and four `cost_ledger` rows totalling **₹6.07**. Nothing
else has spoken to a vendor. Everything else that works, works against synthetic inputs in
a harness — which is a real and useful category, covering 319 assertions across fifteen
harnesses, all green as of today. Stage 5 is wired and proven up to the vendor, and the three
unbuilt stages are built. The pipeline now chains from an approved concept to a submitted
generation — see §8 for the one missing column that had been making that chain inert.

---

## 1. Run against a real vendor

| What | Evidence | When |
|---|---|---|
| Stage 3 — script draft, Anthropic Messages | `kiln_run`: 1 script, 7 shots, 4 reconciled `cost_ledger` rows, ₹6.07 | 2026-08-01 |
| Stage 3 — shotlist draft, same call chain | included in the above; two calls, 3 636 input / 1 855 output tokens | 2026-08-01 |

That is the complete list. The token counts are irregular (1 783/924, then 1 853/931),
which is how you can tell them from fixtures at a glance — every synthetic ledger row in
this project has round numbers.

**What that one run proved beyond "the SDK works":** the cost path end to end. An estimate
row written at submit time, reconciled on completion, at a rate read from the rate card
rather than hard-coded, converted at a recorded `usd_inr_rate`. Rule 5 has been exercised
against real money exactly once, and it held.

**What it did not prove:** anything about the four other vendors, the webhook transport, or
Vault. Those share no code path with it beyond the driver interface.

---

## 2. Run against synthetic inputs

Real code, real Postgres, real ffmpeg, real S3, real HTTP — and inputs this repository
manufactured. This is not a lesser category: three of the bugs that have cost the most time
were found here and were invisible to inspection. It is a different category, and the
difference is always the vendor.

| Harness | Assertions | What it drives | Where the synthesis is |
|---|---|---|---|
| `verify:review` | **51** | Timeline, trims, reorder, caption seams, structure novelty, the publish gate | Clips are ffmpeg test patterns; word timings are authored |
| `verify:studio` | **38** (+1 skip) | The MCP server over real HTTP: initialize, tools/list, auth, forged and cross-session tokens, batch, the spend cap | No model on the other end — §7 is the skip |
| `test:timings` | **16** | Character→word conversion, shot-duration derivation | Timings are constructed, not synthesised by a vendor |
| `test:tour` | **16** | Tour steps ↔ scene beats, and that the scene cannot draw text | Pure data; no browser needed |
| `test:entry` | **15** | All eight combinations of (signed in, seen on record, seen cookie) | None — it is a total function over a finite domain |
| `verify:assemble` | **12** | 6 clips → one MP4 over a real S3 endpoint, and a wrong duration failing the render | s3rver stands in for the bucket; clips are generated |
| `verify:scaling` | **11** | The compiled stylesheet in a real Chromium at seven widths, WCAG 1.4.4 / 1.4.10 / 1.4.12 / 2.5.8 | A probe page, not the app's own screens |
| `verify:tour` | **20** | `/onboarding` in a real Chromium: canvas, contrast under the actual text, reduced motion, context loss | SwiftShader, not a GPU |
| `verify:referral` | **9** | Attribution written once and not overwritten; the roll-up carries nothing identifying | Ledger rows are inserted, not earned |
| `verify:submit` | **42** | Stage 5: every refusal before the spend, one submit per shot, the vendor error taxonomy, the approval transition, the blocker view | A local server stands in for the vendor's HTTP surface |
| `verify:concepts` | **29** | Stage 2: the rubric arithmetic, the validations a decode constraint cannot express, drafts only, the batch charge dividing | A local server stands in for the Messages API |
| `verify:metadata` | **18** | Stage 9: refusal without a passing review, the DB publish gate in both directions, the title-shape check | Same |
| `verify:trends` | **12** | Stage 1: the velocity proxy, same-day dedup keeping the later reading, a source being down | A local server stands in for the feed |
| `verify:webhook` | **25** | The callback over real HTTP: secret gate, payload gate, delivery RPC, replay, the vendor overruling the body | A local server stands in for the status endpoint |
| `verify:ingest` | **5** | 3 source shapes → the canonical intermediate; a corrupt file → an error row | Sources are ffmpeg-generated |

**Total: 319 assertions. Every harness exits 0 locally as of this revision — verified by
exit code rather than by grepping output, see §4b — and all fifteen are wired into CI.** Four further
guards are exempt with reasons: `verify:vault` and `verify:storage` need a live Supabase
project, and the two `verify:script*` variants spend money on a billed model call.

### What the synthetic category has actually caught

Worth stating, because "synthetic" reads as "weak" and the record says otherwise:

- A trim that shortened the picture and not the voice, leaving every later shot 1.04s ahead
  of the words it was cut to — in a file that plays perfectly.
- `worstDriftS` reporting `0` for a cut 0.24s adrift at every boundary, because it counted
  only *flagged* shots. The threshold decides what gets flagged; it does not get to decide
  what the number is.
- A `unique (script_id, idx)` constraint that made reordering shots impossible by any
  single UPDATE — a specification error, found by trying it.
- A 3D backdrop drawn directly behind a paragraph, invisible to every check that existed
  until one measured contrast under the actual text.
- A shim that returned an array for every RPC, so a scalar-returning function's `true`
  arrived as `[{fn: true}]` and the caller concluded it had lost a race it had won. Found
  by the harness built to check that exact inference — and it was the harness that was
  wrong, not the code.

---

## 3. Never executed

Ordered by how much rests on it. Everything here typechecks, builds, and has never run.

### 3.1 Stage 5 — submit. **Now wired, and it cost three defects to find out.**

Resolved. `05-generate.ts` exists, the Studio's `generate_shot` calls through it, and
`pnpm verify:submit` covers 26 assertions in CI. See §7 for what wiring it revealed —
including that `submitShots` did not call a vendor at all.

### 3.2 The webhook transport — **closed, except the vendor's reply**

This was the entry that read "never executed" when this document was drafted a few hours
ago. `pnpm verify:webhook` now drives the callback over real HTTP against real Postgres:
25 checks, in CI. See §5b of `0008` for what it found on the way, which was a defect in the
harness infrastructure rather than in the code.

What remains unproven is one thing: whether the real status endpoint returns the shape the
driver's Zod schema accepts. That is Gate 4 and nothing local can settle it.

### 3.3 Stages with no Trigger task at all

`src/trigger/` contains five tasks: `03-script`, `04-prompt-compile`, `05b-ingest`,
`06-voice`, `07-assemble`. The pipeline has eleven stages.

| Stage | Task? | Note |
|---|---|---|
| 1 Trend intake | **no** | Nothing written |
| 2 Concept generation | **no** | Nothing written |
| 3 Script + shotlist | yes | Has run against Anthropic |
| 4 Prompt compile | yes | Never invoked — nothing calls it |
| 5 Generate | **no** | See 3.1 |
| 5b Ingest | yes | Harness-proven; the webhook that enqueues it is now harness-proven too |
| 6 Voice | yes | Never called ElevenLabs |
| 7 Assemble | yes | Harness-proven end to end |
| 8 QA gate | n/a | A screen, not a task; harness-proven |
| 9 Metadata | **no** | Nothing written |
| 10 Publish | **no** | Manual in Phase 1, by decision |
| 11 Measure | **no** | Nothing written |

`04-prompt-compile` is the quiet one: it exists, and no code path triggers it.

### 3.4 The rest

- **Supabase Vault** — `verify:vault` is exempt and has never run against a live project.
- **Hosted Supabase Storage** — the S3 driver is proven over s3rver, never over the real
  endpoint. `verify:storage` is exempt.
- **The Trigger worker image** — `check:trigger-build` proves the ffmpeg extension is
  *declared*. No image has been built. Without it the first ingest dies with
  `spawn ffmpeg ENOENT`, after the generation has been paid for.
- **The Studio's model leg** — `verify:studio` §7 skips without `ANTHROPIC_API_KEY`. The
  server, the tools, the auth and the spend cap are proven; Opus 5 reaching `/api/mcp` from
  Anthropic's infrastructure is not, and needs a public hostname.
- **The review screen in a browser** — Remotion Player, wavesurfer, and the pointer-drag
  reorder. The data and rules underneath are proven; the widgets are not.
- **`IntegrityAlert`** — its two `count: 'exact', head: true` queries have never executed.

---

## 4. Blocked on something only you can supply

| Blocked | On | Wall clock |
|---|---|---|
| Stage 5, the webhook, Gate 4 | A Higgsfield account with API access (higher-tier plan) **and** a publicly reachable callback URL | Account today; preview deploy today |
| Stage 6 | An ElevenLabs Creator plan | Immediate once bought |
| The prompt library | An hour of your judgement on shot recipes, after watching real clips | Needs Higgsfield first |
| Auto-publish | Meta app review | 2–4 weeks; start it now, in parallel |
| Studio §7 | `ANTHROPIC_API_KEY` in this environment | Whenever you paste it |
| The four migration chunks | You, running them against VidGen | In progress |

Note the ordering constraint that is easy to miss: the prompt library is blocked on
Higgsfield, and stage 5 refuses without a library entry. So Higgsfield unblocks two things
in sequence, not in parallel.

---

## 4a. What was gated, and what was only reported

Run 53 (`7c339f8`) is **green end to end** — 34 steps, every conclusion `success`, nothing
skipped, 7m38s. First full green since run 43. Read off the step list rather than the badge.

That run is also the honest re-verification: CI executes each command separately and fails
on a non-zero exit, which is a stricter check than any local loop and is not susceptible to
the grep mistake in §4b.

**Which claims were actually gated, by commit:**

| Run | Commit | What CI actually did | Ungated |
|---|---|---|---|
| 44 | `8055cf2` referral + fork | failed | step unknown |
| 45–49 | `bbe89c8` … `daff0d6` | **steps 1–33 ran and passed**; hung at 34 | `verify:tour` only |
| 50 | `9449c80` rate card | **failed at Lint, step 13** | steps 14–34 — every harness, the build, scaling, tour |
| 51 | `eb25981` recipe performance | **failed at Lint, step 13** | same |
| 53 | `7c339f8` | all 34 | none |

So the picture is not uniform, and "all in CI" was wrong in two different degrees. For the
five middle commits it was very nearly true — everything except one assertion had run. For
the rate card and the recipe-performance work it was badly wrong: CI stopped at lint, so
twenty-one steps including all fifteen harnesses never executed on those commits at all.

**What that does and does not undermine.** Run 53 contains every one of those changes
cumulatively, and it is green — so the *code* is now gated. What was not gated was the
claim at the time I made it, on the commit I made it about. Those are different things, and
I had been reporting the second as if it were the first.

---

## 4b. CI has not been green, and I said it was

**Correction, and it invalidates a claim in six commit messages.** Runs 44–51 on this
branch: `failure, cancelled, cancelled, cancelled, cancelled, failure, failure`. I reported
"all in CI" each round and let it read as "and CI passes". It did not.

Two separate faults, and neither is a CI configuration problem.

**Corrected once more, and the correction is the point.** I first blamed unbounded awaits
in `verify-tour` — the websocket open, the CDP round trips, rAF in a headless browser — and
said the harness passed locally with exit 0. It did not. `timeout 280 pnpm verify:tour`
exits **124**: it prints all 22 PASS lines, prints its closing summary, and then never
exits. `stop()` was registered on `process.on('exit')`, which never fires while a handle is
open, and the spawned `next start` child is one. The failure path called `process.exit(1)`
and worked, so **the defect only ever appeared when everything was fine** — which is run 49
exactly: 33 green steps and a 34th that started and never completed.

I read the log and called it green, one turn after writing the rule that says not to. The
bounded awaits stay — a browser that stops answering must not wait for ever either — but
they were not the cause. Fixed with an explicit `stop()` and `process.exit(0)`.

Sweeping the other harnesses for the same shape flags seven that spawn a server and never
exit explicitly; all seven measured exit 0, because they close their handles. The
pattern-match is not the signal. The exit code is.

**Runs 46–49 hung for exactly six hours** and were killed by GitHub's default job timeout.
Every step passed; `verify:tour` started and never returned. Three awaits in it could not
finish — the devtools websocket `open` event, each CDP round trip, and the in-page probe,
which waits on `requestAnimationFrame`. rAF does not necessarily fire in a headless browser
with no compositor, which is the likely root; the other two are why nothing pointed at it.
All three are now bounded and each names itself on expiry, and the job carries
`timeout-minutes: 20`. A hang is the one outcome that reports nothing, so a harness that
cannot finish must fail.

**Runs 50–51 failed at Lint**, on the `token-form-rule` violation Vercel later surfaced. CI
caught it. The rule is correct and the fix is a two-element split — the state on a label, the
accent on the control — because one element cannot be both.

**Why I did not notice** is the part worth keeping. I verified `pnpm check` with
`grep -cE '✗|FAIL'` and reported zero. `pnpm check` chains eight tools; five are this
project's harnesses, which print `FAIL`, and three are eslint, tsc and shell scripts, which
do not. eslint prints `✖` (U+2716); I grepped for `✗` (U+2717). The command exited 1 the
whole time and I never looked.

A summary written in one tool's vocabulary cannot see the others. `$?` is the only signal
all of them agree on. Now a rule in CLAUDE.md.

Vercel builds independently of CI, so a red CI never blocked it — but nothing was green to
block anything for six commits, which is the actual answer to "why did this reach Vercel".

---

## 5. A correction to what "wired" has meant

Found while writing this, and it changes how to read every earlier claim about CI.

`check:gates` — the guard on the guards — matched `pnpm <name>` **anywhere in the workflow
file, including comments**. One comment in `ci.yml` reads "…reachable from neither
`pnpm check` nor this workflow…", a sentence *about* the check, and that sentence was
counted as an invocation. Everything reachable from `pnpm check` was therefore reported as
CI-covered.

`test:tour` was reported `check + ci` and had no CI step at all.

It now reads only `run:` values. And a second rule came out of the fix: **membership in
`pnpm check` is not coverage**, because nothing runs `pnpm check` on a push — CI enumerates
its steps individually. A guard whose only home is `pnpm check` now fails.

Both faults were verified by reintroducing them deliberately and watching the check report
them.

This is the third time this project has found a guard that was not guarding, and the first
time the guard in question was the one whose entire job is to catch the other two.

---

---

## 4c. The highest-severity thing in this branch

Not the fifth instance of a rule — **the worst one**, and it deserves saying separately.

`probe()` in `src/lib/ingest/normalise.ts` returned `width ?? 0, height ?? 0,
durationS ?? 0`. A file ffprobe opened but could not fully describe became **0×0×0s**.

Two consequences, and the second is the one that matters:

- `isCanonical` compared 0 against 1080, said no, and the pipeline **re-encoded a file whose
  properties were unknown** — taking the repair path for an asset nobody had measured,
  rather than reporting that it could not be read.
- The duration went to the assembler **as a measurement**. This is the one path in the
  project where a wrong duration has already produced three separate bugs that made a file
  which plays and is wrong, and `verify:assemble` exists precisely because duration was the
  only signal that caught all three.

So an unreadable input silently acquired a plausible-looking number in the exact place the
codebase already knows plausible-looking numbers are most dangerous. It is now a throw
naming what could not be read, which `runIngest` turns into an error row.

Ranked against the other four instances — unpriced vs ₹0, never-run vs failed, deferred vs
done, unmeasured vs measured-at-zero — those are misleading displays. This one silently
changes what the pipeline *does* with a paid-for asset.

---

## 5a. Screens that cannot tell a working system from an empty one

A sibling of §5b, and the more productive sweep as of this round. §5b asks *what calls this
in production*. This asks the reverse: **what does this screen read, and would it look any
different if the answer were nothing?**

The trap is not a screen with obvious placeholder data — that announces itself. It is a
screen that renders identically against fixtures, against a real database, and against an
empty one. There is nothing to see, so nothing prompts anyone to look.

Two of the last three picks were this shape underneath:

| Screen | Read | Consequence |
|---|---|---|
| `board` | Row counts only, no blocker | A permanently stuck concept read as `shot_listed` for ever |
| `settings/voice` | `VOICE_SETTINGS.hostVoice`, a constant | The column existed and nothing could write it; the whole chain stayed inert |
| `settings/rate-card` | `RATE_CARD`, a constant | Every paid stage refuses and the screen that fixes it could not |
| `settings/guardrails` | `GUARDRAILS`, a fixture | Displayed 12 shots against a constraint enforcing 8 — see §9a. The last of them. |

### How to run this sweep

```bash
cd 'src/app/(app)'
for f in $(find . -name page.tsx | sort); do
  printf "%-34s fixtures=%s db=%s\n" "${f#./}" \
    "$(grep -c lib/fixtures "$f")" \
    "$(grep -cE 'serverClient|read[A-Z][a-zA-Z]*\(' "$f")"
done
```

`fixtures>0, db=0` is the signal. `db=0, fixtures=0` is usually a deliberately disabled
route — check it against `src/lib/nav.ts`, which lists every unbuilt screen with the reason.

Remaining as of this round: `settings/guardrails` reads a fixture and has no write path.
Unlike the rate card it gates nothing at runtime — the guardrails it displays are enforced
by DB constraints and driver code, not by that row — so it is a display that is *wrong*
rather than a control that is *absent*. Worth fixing; not worth fixing first.

---

## 5c. Screens that would look the same after one run and after a thousand

The inverse of §5a, and a better test — because these screens are *wired*. They read real
data, they render correctly, and nothing about them signals the gap. §5a's screens at least
had a fixture import to grep for; these have nothing.

The question: **what does this screen show that changes as the system is used, and is
anything actually writing it?**

The sweep is two greps — which accumulation columns exist, and which are written:

```bash
psql "$DATABASE_URL" -tAc "select table_name||'.'||column_name from information_schema.columns
  where column_name ~ '(count|times_|win_rate|last_|_total)' and table_schema='public'"

for c in win_rate times_compiled times_shipped; do
  echo "$c: $(grep -rl "$c" src/lib src/trigger --include=*.ts)"
done
```

A column with readers and no writers is the signal. Cross-check the aggregate views the same
way — `for v in $(grep -ho 'v_[a-z_]*' supabase/migrations/*.sql | sort -u)` against `src/`
finds views nobody reads, which is the §5b failure in view form.

Standing as of this round: `v_video_cost` and `v_referral_attribution` have no reader.
`v_video_cost` is the headline metric's own view and `/costs` is a disabled route — that is
the next one worth doing, and it is a screen to build rather than a defect to fix.

---

## 5b. Built, tested, unreachable

The category no register catches, because **everything about it is green**. The code
typechecks, its harness passes, CI is happy, and it cannot be reached from the running
product. `0008` cannot see it — 0008 tracks what has not been *proven*, and this code is
proven. §3 above cannot see it either, because §3 asks "has it executed", and a harness
executing it counts.

The distinguishing question is different from both: **what calls this in production?**

### What the sweep found

Every exported symbol in `src/lib` and `src/trigger`, cross-referenced against every
reference outside its own file. Most hits were noise — enum members used by a map in the
same file, schemas used inline. Four were real, in three distinct shapes:

| What | Shape | Now |
|---|---|---|
| `submitShots` | No caller, **and no vendor call** | Wired; see §7 |
| `04-prompt-compile` | Complete task, nothing triggered it | Called by stage 3 and by the Studio |
| `03-script` | Complete task, nothing triggered it | Called by `approveConcept` |
| `06-voice` | Complete task, nothing triggered it — **and its absence made four other stages inert** | Called by stage 4; see §8 |
| `src/lib/generate/normalise.ts` | **Superseded and left behind** | Deleted |

The last two are worth separating, because they are not the same problem.

**Superseded duplicates are the dangerous kind.** `src/lib/generate/normalise.ts` defined
`TARGET`, `conforms`, `ffmpegArgs` and `assertTargetEncodable`. The ingest path uses
`src/lib/ingest/normalise.ts`, which defines `CANONICAL` and `isCanonical`. Two modules for
one concept, disagreeing on what the canonical intermediate is, one of them live. Nothing
was broken; the next person to tune the encoder had a coin-flip's chance of editing the
file that does nothing. Deleted rather than documented.

**Unreachable-for-a-reason is the honest kind.** `03-script` has no caller because the
thing that should call it — approving a concept — *does not exist anywhere in this
codebase*. `grep` for an approval action finds nothing but the enum value. `06-voice` is the
same. Those are not wiring omissions; they are §6's missing stages, and giving them a caller
today would mean inventing a product surface to hang it on. They are listed there instead.

### How to run the sweep

```bash
for f in $(find src/lib src/trigger -name '*.ts' | grep -v db/types.ts); do
  grep -oE '^export (async )?function ([a-zA-Z0-9_]+)' "$f" | sed -E 's/^export (async )?function //' |
  while read -r sym; do
    n=$(grep -rlE "\b$sym\b" src scripts | grep -v "^$f$" | wc -l)
    [ "$n" -eq 0 ] && echo "UNREFERENCED $sym ($f)"
  done
done
```

Deliberately not a `check:*` script. It is 80% false positives on a codebase this size —
same-file references, re-exports, dynamic imports — and a guard that cries wolf is a guard
people learn to skip. It is a thing to *run and read*, quarterly or when a stage lands, and
the judgement is the point.

---

## 6. The stages with no Trigger task — three of seven now built

| # | Stage | State |
|---|---|---|
| **1** | Trend intake | **Built.** Reddit only; YouTube needs an API key and Google Trends has no supported endpoint. Both refuse explicitly rather than returning empty. |
| **2** | Concept generation | **Built.** The pipeline's real entry point. |
| **9** | Metadata | **Built.** Refuses without a passing review; writes a draft the DB gate stands in front of. |
| 11 | Measure | Blocked on a published video. |
| 10 | Publish | Meta app review, 2–4 weeks. A deliberate Phase 1 deferral. |

Stage 2 was built first on the reasoning in the previous revision of this section, and it
held: stage 1 is now useful because stage 2 exists to read it, and stage 2 never needed
stage 1 to work.

---

## 7. What wiring stage 5 revealed

Three defects, all fatal, all invisible to typecheck, lint and every existing harness.
Recording them because they are the argument for rule 8 in its sharpest form: **this code
had been reviewed, was internally consistent, and could not have worked.**

1. **`submitShots` never called a vendor.** It priced the work, wrote the estimate row,
   inserted a `generations` row with `status = 'queued'` and no `external_job_id`, and
   marked the shot `generating`. Wiring a caller to that unchanged would have been worse
   than leaving it unreachable: ledger rows for calls that never happened, shots stuck in
   `generating` for ever, and a webhook that could never match a delivery to a row.
   `src/lib/drivers/video-submit.ts` is the missing half.

2. **The estimate row had no subject, and the obvious fix was also wrong.**
   `cost_ledger_has_subject` requires one of five foreign keys; the code wrote all of them
   null. `script_id` looks right and collides — the unique index on
   `(script_id, stage, entry_kind, unit)` exists for once-per-script LLM charges, so shot
   two would have conflicted with shot one. The subject is the generation, which forced the
   ordering: generation row, then cost row, then vendor call. Rule 5 still holds exactly —
   "before the result comes back", not "before anything else".

3. **`ON CONFLICT` cannot infer a partial unique index.**
   `cost_ledger_generation_entry_key` carries `where generation_id is not null`, and
   Postgres refuses to infer it unless the statement repeats the predicate — which
   supabase-js cannot express. The upsert failed against a correctly migrated database with
   "no unique or exclusion constraint matching". Now an insert with a caught duplicate-key,
   which is the idiom the same file already used one block above.

And a fourth, from the harness rather than the schema:

4. **`withPolling` defaults to `true`.** The driver omitted it under a comment saying that
   avoided polling. `options?.withPolling ?? true` — the comment was the exact inverse of
   the behaviour, and in production it would have held a Trigger worker open for the length
   of a video generation while hammering an undocumented rate limit. The harness hung, which
   is how it was found. **An option whose default is the behaviour you are avoiding has to
   be passed, not omitted. Omission is not a position.**

A fifth, smaller: the SDK maps **403** to "not enough credits", not 401 — so a bare 403 must
not be read as an auth failure, or an operator re-checks a credential that is fine while the
account is empty. Both spellings are asserted, because they arrive by different routes.

---

## 8. The smallest gap I picked, and why

**The learning loop accumulated nothing** — migration 0025.

### What the sweep found

No screen reads any accumulation column. Not one. `win_rate`, `times_compiled`,
`times_shipped`, `last_compiled_at` — zero screens.

Then the second grep, which is the one that mattered: **no code writes them either.** Three
readers, zero writers. `win_rate` was set to `null` at insert and never touched again.

And `src/lib/shots/compile.ts` *weights recipe selection by `win_rate`*. So production has
been picking recipes using a permanently null number, and the tier ordering that file
documents at length cannot ever have had an effect.

### Why this was the pick

ARCHITECTURE §0.1 names this as the entire product thesis:

> The durable asset is the *loop* … Nobody can copy your accumulated hook-performance data.
> Everybody can copy your model choice.

The loop accumulated nothing. Videos get made, recipes get used, and the system never gets
better — because the evidence that would make it better was never written. Same inert-chain
shape as 0024, one level up: the *learning* loop rather than the production one.

And the library screen was wired the whole time. It reads real data and displays
`win rate unmeasured · compiled 0× · shipped 0×`, correctly, for ever. **No screen change
was needed** — the screen was never the bug, which is precisely what makes this class hard
to find.

### Derived, not counted

The obvious repair is to increment the counters. That trades a column nothing writes for a
column that drifts: stage 4 is replayable, a re-run would double-count, and a corrected
shotlist would leave the old recipe's tally permanently high. A counter wrong in a way
nobody can detect is worse than one obviously zero.

`v_recipe_performance` derives all four from rows. `shots.prompt_id` says which recipe
compiled a shot; the path to a passed review is a join. The columns are dropped rather than
kept beside it — two sources for one fact is the failure CLAUDE.md names.

**Shipped means "reached a render a human passed"**, not "the generation succeeded". A clip
that rendered cleanly and was cut for being wrong is not a win, and the whole value of the
number is that it reflects editorial judgement rather than the vendor's. Asserted in both
directions: a `pass` counts, a `reshoot` does not.

**`win_rate` is null on an unused recipe and 0 on one tried and never shipped.** Those look
alike and mean opposite things — absence of evidence versus evidence of failure — and
sorting them together would retire recipes nobody has judged. I wrote that assertion
backwards first; the view was right.

### A second instrument, found on the way

`v_recipe_coverage` (0011) measures templating concentration — what share of a shot kind's
compiles went to its busiest recipe, where 1.0 means one recipe is doing all the work. It
summed `times_compiled`, so it has reported **zero compiles for every shot kind since it was
written**. An alarm wired to a sensor nobody connected. Rebuilt on the derived view.

### And a bug in my own fix

`count(*)` is bigint, and both the pg driver and PostgREST return bigints as strings to
avoid silent precision loss past 2^53. `timesCompiled` was arriving as `"3"` — which renders
identically to `3` and compares and sorts as neither. Caught by the harness on its first
run, coerced at the boundary.

Six assertions in `verify:submit` §11.

---

## 9. This round — guardrails, cost per video, and stage 9's zero-second video

### 9a. The last fixture screen was not merely unwired. It was wrong.

`settings/guardrails` was the final screen reading `src/lib/fixtures/settings.ts`, and the
sweep that found it characterised it as *a display that is wrong rather than a control that
is absent*. That turned out to be exact, and worse than expected:

| Row | Displayed | Actually |
|---|---|---|
| Max shots per video | 12, "shotlist compile" | `ShotlistSchema` rejects anything over **8** |
| Spend cap — per day | ₹2,000, "submit path, summed from cost_ledger" | Nothing sums `cost_ledger` over any window |
| Spend cap — per month | ₹25,000, same | Same |
| Circuit breaker | 5 failures / 60,000ms, `driver_health` | `driver_health` has no reader and no writer; 0013's own comment says so |
| Max shot duration | 5s, "shot split" | No cap exists anywhere |
| Concurrency (×2) | `unknown` | Both **are** enforced, per run, from `integrations.concurrency_limit` |
| Spend cap — per Studio session | ₹500 | **True and live** — `startSessionAction` reads this row |

Eight rows rendered identically and one was real. A wrong guardrail display is worse than an
absent control: an absent control is visibly absent, and a wrong number is believed — and
the whole reason this screen exists is so "is this on?" does not need a grep.

`src/lib/settings/guardrails.ts` replaces it, and the two ways of lying are now structural
rather than corrected. A `kind: 'code'` row takes its value from the enforcing module's
exported constant (`MAX_SHOTS_PER_SHOTLIST`), so the displayed and enforced numbers are one
binding. A `kind: 'none'` row **has no `value` field on its branch** — the type will not
carry one — so "not enforced" cannot render as a figure or as zero. `kind: 'runtime'` is the
third state, because two were not enough: enforced-but-read-per-run is not the same fact as
not-enforced.

`check:guardrails` is what reads it. It rejects a numeric literal on a `code` row, and
asserts every `none` probe still finds nothing under `src/` — **an assertion of absence,
which fails at the moment somebody wires `driver_health` and leaves the row claiming nobody
did.** Both were negative-tested by breaking them deliberately.

The max-shot-duration cap stays absent on purpose, not pending: durations come from real
word timings in stage 6, and a ceiling applied after that truncates video against audio that
still runs.

### 9b. Cost per video, the headline metric, had no reader

Rule 5 calls cost-per-video the project's headline metric and it has been unanswerable for
the whole build. Not because `cost_ledger` is wrong — it is exact — but because turning it
into a per-video number takes four joins and a decision about three different ways of being
uncertain, which is the condition under which people stop asking and start assuming.

Migration 0026 adds `v_cost_attributed`, `v_video_cost` and `v_cost_unattributed`, and the
view refuses three things that each produce a plausible number: adding an estimate to a
reconcile (double-counts every completed generation), treating an unpriced row as free (an
unknown cost is not a smaller one — `settled_inr` goes null), and dropping spend that
belongs to no video (`v_cost_unattributed` is the complement, exhaustive with it).

`/costs` was designed against its own inverse test *before* it was written. A costs page's
obvious shape is a big number at the top, and that number looks identical after one video
and after a hundred — the board's row-count defect wearing different clothes. So the rows
are the artifact, the average is derived, the denominator is printed beside it, and every
excluded video is listed with its reason.

**What it renders today, and why the empty state says so:** four ledger rows, ₹6.07, from
drafting and shotlist compilation on one script. Zero renders, zero generations, zero
publications. Cost per video is therefore **undefined, not ₹0** — rendering ₹0.00 would be
the absent-versus-zero violation on the one number rule 5 names. Three outcomes, never two:
rows, empty, or broken, and the broken case names migration 0026 rather than blaming data.

`verify:costs` drives `readVideoCosts` — the production reader — over eight scenarios. The
load-bearing one is **exhaustiveness**: every `cost_ledger` row lands in exactly one of the
two views. A headline metric does not usually go wrong by being computed incorrectly; it
goes wrong by being computed over a set somebody quietly narrowed. That now fails a harness.
It caught one defect while being written: `ledger_rows` summed the settled and open counts,
which under-counts by one row per superseded estimate.

### 9c. Stage 9 would have written a title for a zero-second video

The sweep this round was CLAUDE.md's own instruction — *grep for `?? 0` on a value that
means a measurement*. Twenty hits, nineteen of them counts where absent genuinely is zero.
The twentieth:

```ts
durationSeconds: Number(render.duration_s ?? 0),   // → "runtime: 0s" in the prompt
```

`renders.duration_s` is nullable. An unmeasured render was described to the model as a
zero-second video, and the model wrote a title, description and tags for it — confidently,
because 0 is a number and nothing in the prompt says it might be a missing measurement. That
text becomes a draft publication.

Second defect in the same three lines: `status` was selected and never looked at, so a
queued, rendering or failed render — one with no file at all — would still get a paid call
and a draft describing it.

Both are refusals now (`render_not_ready`, `no_duration`), placed **above the pricing
probe** so no money moves. `verify:metadata` §2b asserts each is refused *and* that zero
model calls were made; the second assertion is the one that matters.

This is the same rule in the same duration path as the `probe()` fix in §4c. Three duration
bugs have already shipped here that made a file which plays and is wrong. It was invisible
to every green check because `0` typechecks.

### 9d. Still with no reader

The views sweep, run as `create view` names against `src/` and `scripts/`:

`v_cost_by_stage`, `v_cost_per_1k_views`, `v_entry_state`, `v_script_vo_status`,
`v_shot_readiness`, `v_referral_attribution` (read only by its harness), `v_concept_cost`.
`v_cost_attributed` is read by `v_video_cost` — a SQL-level reader, which counts.

Each is the pattern CLAUDE.md names: a mechanism built to make something visible, with
nothing that reads it. `v_shot_readiness` and `v_script_vo_status` are the interesting two,
because they are about exactly the inert 03 → 04 → 05 chain §7 describes.

## 10. The gate I did not add, and a blocker that was not blocking

### 10a. `matching_recipes` is not a fourth workspace gate, and the reason is the round's finding

The proposal was: a library whose recipes match no shot kind is an ungeneratable workspace,
same family as the three gates 0028 added. It is not, for two independent reasons.

**The state cannot occur.** Both recipe-write paths validate through `RecipeInputSchema`,
whose `tags` is `z.array(z.enum(SHOT_KIND_KEYS)).min(1)`. The Studio's `save_prompt_recipe`
declares a looser `z.array(z.string())` in its own args, but re-validates through the
library schema before writing — so an untagged or off-vocabulary recipe is refused at both
doors. A gate here would guard a state no write path produces, and the assertion for it
would go green for ever while proving nothing. That is precisely the failure this round is
about; building it deliberately would have been worse than the accident.

**`matching_recipes` already has a reader.** `v_unresolved_shots` computes it with the
identical correlated subquery, is scoped to the shots the question is about
(`compiled_params is null`), and is read by `unresolvedShots()`. `v_shot_readiness` was a
second view over the same concept with no reader at all — the two-modules rule at view
level — and 0029 drops it.

### 10b. The agreement, closed in the other direction

0028 asserted that when stage 5 refuses, `v_pipeline_blockers` names the same reason. The
converse was missing and is the one that matters: **a script stage 5 actually submitted must
have had `blocker = null`.**

It found a defect on the first run. Stage 5 submitted a shot — spent money, wrote the
estimate row, got a job id — on a script the view called blocked with *"no host voice on the
channel — stage 6 cannot run"*. The view was wrong. Stage 5 needs `derived_from_vo`; it does
not need a host voice, which is what lets *stage 6* produce that state. The branch sat
unconditionally at the top of the CASE and fired regardless.

The reachable version is ordinary: set a host voice, run stage 6, then change voice provider
or clear the setting. Every already-timed script on that channel now reports a stage-6
blocker stage 6 has already satisfied. Same harm as `blocker = null` on an ungeneratable
workspace, pointed the other way — a confidently wrong answer to "why did nothing come out?"

0029 moves the host voice inside the durations branch, where it explains that branch rather
than pre-empting it: *"durations are still estimates and the channel has no host voice"* when
it is what is stopping stage 6, and *"durations are still estimates — stage 6 has not run"*
when it is not.

### 10c. The vacuous-precondition sweep

The question: which assertions are true only because something upstream never worked?

`verify:review` came out clean and is the pattern done right — it asserts the refusal on a
fresh workspace, *then* verifies the integration and adds the rate, *then* asserts the
positive. Both branches, in the same section.

The productive form of the question turned out not to be "is this assertion negative?" but
**"is the thing being asserted produced by the same model doing the asserting?"** A producer
checked against a model of itself agrees with itself, at no cost, for ever. That reframes the
sweep as: which views are asserted by a harness with no consumer asserted alongside?

| View | Harness | Production reader |
|---|---|---|
| `v_pipeline_blockers` | verify:submit | board — **both directions now asserted** |
| `v_video_cost` | verify:costs | `readVideoCosts`, which the harness drives |
| `v_concept_cost` | verify:concepts | `cost/llm.ts` |
| `v_recipe_coverage` | verify:submit | `prompts/library.ts` |
| `v_replayed_callbacks` | verify:webhook | integrity alert |
| `v_deferred_steps` | doctor | `integrations/verify.ts` |
| `v_recipe_performance` | — | `shots/run.ts`, `library.ts` |
| `v_unresolved_shots` | — | `library.ts` |
| `v_unconfirmed_terminal_generations` | — | integrity alert |
| **`v_referral_attribution`** | — | **none** — `readPartnerRollup` reads `v_partner_rollup` |
| **`v_stuck_submits`** | — | **none** — named in one comment in `submit.ts` |
| **`v_script_vo_status`** | — | **none** |
| **`v_entry_state`** | — | **none** |
| **`v_cost_by_stage`** | — | **none** |
| **`v_cost_per_1k_views`** | — | **none** |

The six in bold are not all the same thing and should not be treated alike.
`v_cost_per_1k_views` needs published videos and belongs to phase 4; `v_cost_by_stage` and
`v_script_vo_status` are answerable now and simply have no screen. `v_referral_attribution`
is the uncomfortable one — a near-twin of `v_partner_rollup`, which is the one that is read.
Not deleted this round because unlike `v_shot_readiness` it is not a strict duplicate, and
deleting on suspicion is how the wrong copy goes.

## 11. Two views given consumers, and what reading them properly exposed

### 11a. `v_cost_by_stage` could not see the most expensive stage

It filtered `where stage is not null`, and stage 5's ledger rows set no stage at all. The
`stage: 'still'` in `submit.ts` is a field of the **vendor payload** naming which half of the
two-call chain is being submitted — it never reached the ledger, and it is what made this
look already-set at a glance. So every figure the view produced was a breakdown of the LLM
stages presented as a breakdown of the pipeline, with video generation structurally invisible
to the view named for it.

Three further corrections, each a standing rule: `sum(cost_inr)` skipped nulls so an unpriced
row vanished from its stage's total; estimate and reconcile were added together; and a bare
total per stage looks identical after one video and after a hundred, so `scripts` is now the
denominator and `inr_per_script` is derived from it.

The stage vocabulary stays in TypeScript. `v_cost_by_stage` returns only stages that have
rows; `CHARGING_STAGES` in `cost/by-stage.ts` fills in the never-ran ones as `hasRun: false`
with null figures. **A stage that has never run must not render as ₹0** — "assembly is free"
and "assembly has never been built" are different claims. A third copy of the vocabulary in
SQL is how the shot-kind list would have gone wrong.

### 11b. The fourth `ON CONFLICT` against a partial index

`voice/run.ts` used `upsert(..., { onConflict: 'script_id,stage,entry_kind,unit' })`.
`cost_ledger_script_stage_entry_key` cannot be inferred for **two** independent reasons: it
is partial (`where script_id is not null`) *and* its third column is an expression
(`coalesce(stage,'')`). So the audio vendor bills for the speech and no ledger row lands.

I wrote last round that a fourth instance was impossible because the Studio's write had been
folded into `writeLlmCost` and there was no fourth place to put it. **That was wrong.**
`writeLlmCost` covers LLM subjects priced in tokens; voice is priced in characters and has
always had its own writer, so it was never in scope of that claim. The lesson is not about
the line — it is that "there is no fourth place" is a claim about the whole codebase and I
made it from one module.

Stage 6 was also the only money-spending stage with no database harness, which is why
nothing caught it. `verify:voice` now exists, and its §3 asserts both that the insert lands
*and* that the upsert it replaced still cannot run — so the fix cannot be quietly reverted
by someone who finds insert-and-catch uglier.

### 11c. `v_script_vo_status` counted instead of answering

`takes`, `total_duration_s`, `characters_billed`, `shots_timed` — four numbers that grow,
none of them an answer to the question the voice stage raises, which is *where does the chain
stop*. It now returns `vo_state`, and the counts are evidence for it.

`stitched_untimed` is the state 03 → 04 → 05 sat in for a week with fifteen harnesses green.
The distinction that makes the screen worth having: `stitched_untimed` and `not_started` both
have zero timed shots, and only one of them means money has already been spent. A screen that
merged them would be the reassuring one. Settings → Voice now shows the distribution, which
is the artifact; the list is the evidence.

### 11d. Load-bearing assertions, marked

`verify:submit` §0 and the old §9 are the same three lines, and §0 means something only
because §4 submits to a vendor and then asserts the view said null about it. Nothing in §0
said so. Sections that carry an assertion the others rest on now say `LOAD-BEARING` and name
what makes it true. Two rules of thumb for which one it is: usually the assertion about rows
that do *not* exist, and usually the one whose subject was produced by a different module
than the one asserting.

Writing this round's first draft of `verify:costs` §5c proved the rule immediately — it
asserted that `05-generate` spend was attributed, against a harness whose ledger rows are all
written by a local helper that sets no stage. It failed, correctly. The claim about
production moved to `verify:submit` §4, where a real `submitShots` writes the row.

### 11e. Rule 1's seventh catch

`pnpm check:vendors` refused this round's own comment in `voice/run.ts`, which named the
audio vendor while explaining a ledger defect. Second time it has fired on a comment that
named a vendor in the course of explaining something correct, and it was right both times.

## 12. Limits and the credit clock, and the numerator neither has

Both blocks were asked for as dashboard additions. Applying the inverse test up front turned
them into the same finding: **this project tracks purchases and ceilings, and does not track
consumption.** The natural rendering of each — usage over ceiling, credits remaining —
requires a numerator that does not exist, and inventing one puts a fabricated figure on the
screen the operator checks daily.

### 12a. The limits block

| Piece | Available? |
|---|---|
| Ceiling | `integrations.concurrency_limit`, **null on every driver** — read from the account at verification, and nothing has verified |
| Usage, live | `in_flight` — real, and 0 for ever on a workspace that has never generated |
| Usage, retrospective | `generations.error_code` — **real and the part that survives the inverse test** |
| Reset countdown | **does not exist**, and must not be drawn |

A concurrency ceiling is not a window. A countdown beside it would be a fiction, and the one
windowed quota worth showing — YouTube's 10,000 units/day — has *structurally* unobservable
consumption in phase 1, because publishing is by hand and this codebase makes no call against
it. `QUOTAS` in `pipeline/limits.ts` is therefore an empty array with the reason written into
it, and it gains a row the day `src/lib/publish/` calls the API.

`concurrency_limited` and `rate_limited` are counted apart, and that is the assertion the
card's shape rests on. `drivers/types.ts` keeps them distinct because one wants a queue and
the other exponential backoff, and treating a concurrency ceiling as a rate limit produces a
retry storm that makes the ceiling worse. A merged "times you were limited" figure would
erase a distinction the driver layer maintains to prevent exactly that.

"Never submitted" and "never limited" render differently — an em dash, not a zero.

### 12b. The credit clock

`generations.credits_spent` **has no writer anywhere in `src/`**. So a "remaining" figure
today would be the purchase total, unchanged for ever, presented as though it moved.

That is the absent-versus-zero rule in its most expensive form so far, and it is worth
naming precisely because it is not the usual shape: not a missing measurement rendered as
zero, but **a stale constant rendered as a live balance** — on the screen opened every day,
about money. `creditsUnexpired` is 1,500 in the harness and putting it under a heading
reading "remaining" would look right, read right, and be wrong.

What is exact today is the clock, and it is the part that matters daily: credits die about
90 days after purchase whether or not anything used them, and **nothing is billed at the
moment they evaporate**, so the cost ledger structurally cannot see the loss. That is the
argument for the card being on the board rather than in Settings.

`v_credit_position` was **extended, not replaced** — it has existed since 0008 and
`onboarding/step-view.ts` reads four of its columns. The first draft of 0031 created a
second view of the same name and failed to apply, which is how it was caught. Two views for
one concept, nearly committed, in the middle of a two-round audit of exactly that.

### 12c. What would make each real

- Limits: nothing, for the retrospective half — it works the moment a generation is refused.
  The ceiling fills in when an integration verifies.
- Credits: a writer for `generations.credits_spent`. The vendor returns credits spent on
  completion, so the webhook handler is where it belongs. `consumptionObserved` flips on its
  own the moment one row carries a figure, and `verify:limits` §3 asserts both directions —
  so the screen starts showing a balance without anybody remembering to change it.

## 13. What the reference workflows exposed

Three ComfyUI workflows were supplied as reference, explicitly not as importable recipes —
they call Seedream/Seedance, GPT-Image-2 and Gemini Omni directly, so no params transplant.
Nothing was imported. Reading them for *shape* found one live defect and settled two design
questions.

### 13a. `accepts_character_ref` gated a reference that is never passed

The workflows name their references positionally inside the prompt text — *"Use @image_1 as
a start frame. Reference @image_2 for the full body shots"* — and asking whether our template
could express that made something else obvious first:

`submit.ts` refused a shot whose recipe was not marked `accepts_character_ref`, with the
reason *"refused rather than submitted without it, which would generate a stranger and bill
for it."* The **accepted** path submitted without it too. Nothing in `src/` reads the
`characters` table at all; the compiled payload has no reference field and never had one.

So the gate let through exactly the outcome its own message named. **That is the inverse of
the vacuous-precondition failure** — not a guard for a state that cannot occur, but a guard
that permits the state it claims to prevent, while reading as protection. And the reason it
read as covered: `verify:submit` §3 tested only the refusing half.

A shot carrying a character reference is now refused outright until something passes one.
§3 asserts both halves, with the accepting one marked LOAD-BEARING — it flips the day a
reference is actually passed, which is the point.

### 13b. Named reference slots — the answer is "one, and we cannot express it"

`characters` has `external_ref_id` and `reference_urls[]`, so multiple images *per character*
are expressible. `shots.character_id` is singular, so two distinct reference subjects — a
start frame and an identity reference — are not. And `TEMPLATE_VARS` is
`description, intent, duration`: the template has no vocabulary for referring to a reference
at all.

Adding named slots now would guard a state no write path produces, which is the rule from
§10a. The honest order is: pass the one reference we have, then find out whether a second
subject is needed, then widen the schema.

### 13c. Duration in the prompt text — unverified, and the gap named

The Gemini Omni workflow carries a note in the graph itself: *"requires you to specify the
`duration` and `aspect ratio` in the prompt"*, which is the entire reason its Prompt
Constructor subgraph exists. Our compile step assumes structured params.

**Whether any Higgsfield model has the same requirement cannot be checked from here** — the
hosted MCP server is not connected in this session, and guessing which models need it is
precisely the guess this project refuses elsewhere. What can be said structurally:

- `{{duration}}` is available to a template and `compiled_params.duration_s` is set, so a
  recipe *can* carry duration in prompt text today.
- Nothing records **which** models require it, and nothing enforces the pairing. A recipe for
  such a model whose template omits `{{duration}}` compiles cleanly and produces a clip of
  the wrong length — the same silent-wrongness class as the three duration bugs.
- The smallest closing change is a per-recipe list of params that must also appear in the
  template text, checked in `RecipeInputSchema`. It is not being built until a model is known
  to need it, for the §10a reason.

### 13d. A fixed-slot skeleton, which is not a recipe

`prompts/skeletons.ts` records the Seedream poster prompt read as seven ordered slots —
subject, surface, colour event, background, typography, decoration, mood. The surface slot
is the interesting one: it carries a negative clause *inside* a positive prompt
("no cracks or broken facial surfaces"), which is how models with no negative-prompt
parameter get their exclusions, and an author who does not know that gets cracked chrome.

Freeform prose degrades unevenly — a description that happens to mention background and mood
produces a different class of image from one that does not, and the prompt reads fine either
way. Named slots make an omission visible as an empty slot rather than as an image that is
subtly flatter than the last one. That matters most for `graphic_plate` and `detail_macro`,
where the subject is a designed surface and anything unsaid is invented.

`list_prompt_recipes` returns skeletons **only when the library is empty** — the one moment
an author needs a shape rather than a warning — and that is also what reads the module. Every
one carries `unverified` saying what is unproven about it, and none carries params, both
asserted in `verify:studio` with the second marked LOAD-BEARING: a shape catalogue that could
be mistaken for an import path is the failure the library exists to prevent.

## 14. The duplicate guard, and numbers that turn themselves on

### 14a. `check:duplicates`

The two-modules rule had fired twice and neither catch was the rule working: `normalise.ts`
was found by reading, and the second `v_credit_position` was found because **Postgres refused
to create it** — at apply time, after both were committed, in the middle of a two-round audit
of exactly that pattern. Luck is not coverage.

Three checks, split by what can actually see each thing. Module basename collisions and a
view created twice with no drop between are static and run in `pnpm check`. Column-set
overlap between live views needs `information_schema`, because deriving a view's columns from
its SQL means writing a parser and a parser that is wrong in one direction produces false
confidence — that half runs in CI after the migrations step.

Overlap is not automatically wrong, so both halves fail *until justified*, with the same
outlived-exemption rule `check:gates` uses. Writing the exemptions found two things:

- My first three guesses were wrong. I invented plausible-sounding pairs without measuring,
  and the outlived-exemption rule caught all three on the first run — which is the mechanism
  working on its author within a minute of existing.
- Two real overlapping pairs, both justified after reading them: `v_render_cost` /
  `v_script_cost` are different denominators over the same spend, and `v_replayed_callbacks`
  / `v_unconfirmed_terminal_generations` are two different forgery signals over the same
  columns. Five module basenames repeat, and `env.ts` × 3 is rule 1 being obeyed.

Both halves negative-tested by breaking them.

### 14b. Withheld numbers, generalised

`src/lib/pipeline/observability.ts` is the register. Each entry is a number a screen refuses
to show, the writer that does not exist, what the screen says instead, and what appears when
the writer lands. Every one is answered by a **probe against the rows**, never a constant —
which is the whole difference between a documented limitation and a permanent one.

Three entries today:

| Withheld | Missing writer |
|---|---|
| Credits remaining | `generations.credits_spent` — already handled, now in the register |
| **Settled cost of a video generation** | **nothing writes a `reconcile` row against a `generation_id`** |
| Whether a video went live | `publications.external_post_id` / `published_at` — manual publish, phase 1 |

The middle row is the find. `submit.ts` writes the estimate; `confirm.ts` writes a status, an
asset and an ingest enqueue, and no ledger row. **Rule 5 says "reconcile on completion" and
that half has never existed** — so a video that generates stays `nothing_settled` for ever
and can never become countable towards cost per video, no matter how many complete.
`/costs` now says so, from the probe, so the line disappears on its own when a reconcile
lands.

Whether to write that reconcile is a decision I have not taken: the vendor's status response
carries no credit figure in our driver's parsed shape, so a reconcile today could only assert
the estimate as actual. That is a money-semantics judgement rather than a mechanical fix.

### 14c. The shim could not count, and said so as a zero

`readObservability` asks "has anything ever written this column" with
`select('id', { count: 'exact', head: true })`. The `pg` shim ignored the options argument
entirely and returned `count: undefined`, which `count ?? 0` turns into a confident zero —
breaking the shim's own stated contract that anything unimplemented fails loudly.

The consequence reached further than this round: `readVideoCosts` computes `ledgerEmpty` the
same way, so **`verify:costs` §0's "the ledger is reported empty" has passed for as long as
it has existed and proved nothing** — it would have passed with a full ledger. Only the
converse can tell the difference, and only after the shim was taught to count. Both are
asserted now, the converse marked LOAD-BEARING.

Third instance of the two-instrument rule, and the same shape as the `pg_proc` one: the shim
could not observe the thing and reported that as a value rather than as an error.

---

## How to refresh this document

```bash
pnpm check                                  # everything that needs no database
export DATABASE_URL=...                     # any Postgres you may create databases on
for h in ingest assemble review studio referral webhook submit concepts metadata trends costs voice limits; do pnpm verify:$h "$DATABASE_URL"; done
pnpm build && pnpm verify:scaling && pnpm verify:tour
```

The counts in §2 are `grep -c PASS` on those outputs. If a number here disagrees with a run,
the run is right — this file is a snapshot and the register has been stale once already.
