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
a harness — which is a real and useful category, covering 218 assertions across eleven
harnesses, all green as of today. The largest single hole is **stage 5**: the code to
submit a video generation exists, is complete, and is called by nothing.

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
| `verify:webhook` | **25** | The callback over real HTTP: secret gate, payload gate, delivery RPC, replay, the vendor overruling the body | A local server stands in for the status endpoint |
| `verify:ingest` | **5** | 3 source shapes → the canonical intermediate; a corrupt file → an error row | Sources are ffmpeg-generated |

**Total: 218 assertions, all green today, and all eleven harnesses run in CI.** Four further
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

### 3.1 Stage 5 — submit. **The largest hole, and the one that surprised me.**

`src/lib/generate/submit.ts` exports `submitShots`. It is complete: it refuses anything it
cannot price, submits stills only, and leaves the video half to the still's webhook so a
failed still cannot bill a video.

**Nothing calls it.** Not a Trigger task, not a Server Action, not an MCP tool. `grep` finds
exactly one occurrence in `src/`, which is its own definition. There is no `05-generate.ts`
in `src/trigger/`.

The Studio's `generate_shot` walks every gate — video integration verified, recipe present,
call priceable — writes the shot row, and stops there, with a comment saying it is "written
to be replaced by the stage-5 submit path rather than to duplicate it". That is the right
call and it means the product currently **cannot submit a video generation by any route**.

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

## 6. The smallest gap I picked, and why

Asked to pick one thing after writing the survey above, I took **§3.2, the webhook leg**,
over the more obviously important §3.1 (stage 5 has no caller). The reasoning, since the
choice is arguable:

- **Stage 5 cannot be finished without a vendor.** Writing `05-generate.ts` today produces
  more code that has never run, in the category this document exists to make visible. It is
  the bigger hole and it is blocked; the honest move is to leave it named.
- **The webhook could be finished today and had not been**, which is the definition of the
  cheapest remaining thing.
- **Its failure mode is the worst-timed one in the project.** If the RPC shape were wrong,
  every generation would confirm-and-fail silently, and the discovery would come at Gate 4,
  after a real generation had been paid for, on the one path that cannot be re-run by hand.
- **It de-risks stage 5 rather than duplicating it.** The submit path's whole design rests
  on the callback settling exactly once — the video half is submitted from the still's
  webhook precisely so a failed still cannot bill a video. Proving the callback is proving
  the assumption stage 5 is built on.

It also turned out to be the right pick for a reason I could not have known in advance: the
shim defect it surfaced was silently affecting every scalar RPC in every harness. It had
been there since the shim was written.

---

## How to refresh this document

```bash
pnpm check                                  # everything that needs no database
export DATABASE_URL=...                     # any Postgres you may create databases on
for h in ingest assemble review studio referral webhook; do pnpm verify:$h "$DATABASE_URL"; done
pnpm build && pnpm verify:scaling && pnpm verify:tour
```

The counts in §2 are `grep -c PASS` on those outputs. If a number here disagrees with a run,
the run is right — this file is a snapshot and the register has been stale once already.
