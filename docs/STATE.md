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

**Total: 319 assertions, all green today, and all fifteen harnesses run in CI.** Four further
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

## How to refresh this document

```bash
pnpm check                                  # everything that needs no database
export DATABASE_URL=...                     # any Postgres you may create databases on
for h in ingest assemble review studio referral webhook submit concepts metadata trends; do pnpm verify:$h "$DATABASE_URL"; done
pnpm build && pnpm verify:scaling && pnpm verify:tour
```

The counts in §2 are `grep -c PASS` on those outputs. If a number here disagrees with a run,
the run is right — this file is a snapshot and the register has been stale once already.
