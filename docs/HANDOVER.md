# Handover — what Gate 4 and Gate 5 need from you, in order

Everything buildable without a vendor account is built. What is left needs three things
only you can supply: **Higgsfield API access**, an **ElevenLabs Creator plan**, and **an
hour of your judgement on shot recipes**.

This file is the order to do them in and what each unblocks. It is written so you never
have to re-derive a step from six addenda — every claim here has a pointer, but you should
not need to follow one to act.

---

## The shape of it

```
  A. Deploy the worker         →  nothing runs anywhere until this is true
  B. ElevenLabs (Gate 3)       →  cheapest real vendor call; unblocks stage 6
  C. Higgsfield (Gate 4)       →  the expensive one; needs a public webhook URL
  D. Your hour on recipes      →  the library; without it stage 5 refuses, correctly
  E. Gate 5 — one video        →  everything above, in sequence, watched
```

B before C on purpose. ElevenLabs is synchronous — request, response, done — so it proves
the credential path, the Vault read, the cost ledger and the driver interface without
needing a webhook to reach you. Higgsfield is asynchronous and adds the callback, the
signature-less shared secret, and the confirmation. Debugging both at once means every
failure has two candidate causes.

D after C, not before. A recipe is only worth saving once you have watched the clip it
produced, and watching a clip needs C.

---

## Where the screens are now

The entry flow moved, and three URLs you may have bookmarked are not where they were. This
table is here so you do not go hunting for the board.

| You want | Go to | Was |
|---|---|---|
| The board — every video by state | `/board` | `/` |
| The setup wizard | `/setup` (steps at `/setup/1` … `/setup/10`) | `/onboarding` |
| The product tour | `/onboarding` | behind sign-in, same path |
| Whatever the app thinks you need | `/` | — |

`/` is now a **splash**: it renders immediately, checks whether you are signed in and
whether you have seen the tour, and sends you onward — to `/onboarding`, `/login` or
`/board`. It is not a page you interact with, and it never holds you for more than the
redirect.

The two that moved, moved for the same reason: `/` had to become the one URL that decides
where you go, and it could not do that while also being the board. `/onboarding` is now the
*product tour*, which is public and sits before sign-in — the wizard that spends money took
the new name (`/setup`) because it is a different thing entirely, and having them share a
word was the source of the confusion.

Setup is no longer a gate. Every screen opens with nothing connected; a task that needs an
unverified integration refuses and names it. If a screen refuses, that is the answer, not a
failure — the fix is the named step in `/setup`, and the sidebar checklist links straight
to it.

---

## A. Deploy the worker

**Unblocks:** everything. No Trigger task has ever run.

```bash
pnpm check:trigger-build                       # no account needed; already green in CI
pnpm dlx trigger.dev@4.5.9 login               # opens a browser

TRIGGER_PROJECT_REF=proj_… pnpm trigger:deploy:dry   # builds the image, uploads nothing
TRIGGER_PROJECT_REF=proj_… pnpm trigger:deploy
```

Run the dry run every time. It is where a broken ffmpeg build extension surfaces as a build
error instead of as `spawn ffmpeg ENOENT` on a run you have already paid for.

**Set the worker's environment variables in the Trigger dashboard.** Trigger does not share
Vercel's environment, and a variable set on Vercel and forgotten here produces a control
plane that works and a pipeline that fails on its first real run.

| Variable | Needed by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | every task — they all write rows |
| `STORAGE_DRIVER=supabase-storage` | **never `local-fs`** in production |
| `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`, `SUPABASE_STORAGE_BUCKET`, `SUPABASE_S3_REGION` | ingest and assemble |
| `ANTHROPIC_API_KEY` | stages 3 and 4 |
| ~~`USD_INR_RATE`~~ | **removed.** The rate is `profiles.usd_inr_rate`, set in onboarding step 1 — an operational value, changeable without a redeploy. See `src/lib/cost/fx.ts` |
| `WEBHOOK_CALLBACK_BASE_URL` | stage 5, and it must be the **production** domain |

**How you know it worked:** trigger `07-assemble` from the dashboard against a script id
that has normalised assets. It should produce a `renders` row. It will not have one yet, so
in practice this step is confirmed by C.

**Your stage 3/4 rows are not in the hosted project.** Stages 3 and 4 ran for real on
2026-08-01 — one concept, one script, seven shots, four cost rows, ₹6.07 through both
stages — but against a **development container's local Postgres**, because `*.supabase.co`
was refused at that container's egress policy. Those rows have never been in VidGen, and the
container they live in is ephemeral.

They are dumped to `kiln-stage34-rows.sql` (14 inserts: 1 channel, 1 concept, 1 script,
7 shots, 4 cost_ledger). Load them into VidGen after the migrations land if you want the
first real cost figures and a walkable concept on the board; skip it if you would rather
start clean. Nothing depends on them.

Detail: `docs/decisions/0010-trigger-deploy.md`.

---

## B. ElevenLabs — Gate 3

**You need:** a Creator plan. The cheaper tiers do not return character-level alignment, and
without alignment there are no word timings, no derived shot durations and no free
captions. That is the entire reason the plan tier matters.

1. Settings → Integrations → ElevenLabs → paste the key → **Test connection**.
   Do not skip Test. An enabled-but-unverified integration is refused by every task by
   design, so a key that is present and unverified looks exactly like a key that is absent.
2. Settings → Voice → pick the host voice. Record the `voice_id`.
3. Settings → Rate card → set the ElevenLabs character rate and mark it verified. Until you
   do, stage 6 refuses to submit: an unverified rate produces no rupee figure anywhere.
4. Run stage 6 on a script that has `vo_text`.

**How you know it worked:** a `vo_takes` row with a non-empty `word_timings` array, and the
script's shots flipping `duration_source` from `authored` to `derived_from_vo`. The review
screen shows `estimated` next to any shot that is still on the shotlist guess.

**What to watch for:** the timings must come from the **normalised** alignment, not the raw
one. "$5" is spoken as "five dollars"; captions built from the raw alignment caption text
the viewer never hears, and a shot boundary drawn from raw timings lands about 0.4s early on
that line. The code already reads the normalised field — this is what to check if captions
look subtly wrong.

### B — what can go wrong, cheapest first

**Cheap — minutes, no money moves.**

| # | What it looks like from outside | What tells it apart |
|---|---|---|
| 1 | Test connection fails. Nothing else has run. | The `integration_checks` row: `passed=false` with the vendor's own message. A 401 is a wrong key; a 403 is the right key on a plan without the endpoint. |
| 2 | Stage 6 refuses without calling anything: *"has never verified"*. | You enabled the integration and did not press **Test connection**. Enabling states intent; verifying states fact. `usability()` names which of the two you did. |
| 3 | The app says a column does not exist; `psql` disagrees. | PostgREST's schema cache is stale after a migration. `pnpm db:doctor` says so directly. Nothing to do with ElevenLabs. |
| 4 | Stage 6 refuses on pricing. | No verified character rate. **Unlike the video rates, this one is published** — ElevenLabs lists per-character pricing, so you may enter it from the pricing page and mark it verified, exactly as the Anthropic rates in migration 0006 were. The "never trust documentation" rule in C is about credit rates nobody publishes. |

**Expensive — bills, and produces something you cannot use.**

| # | What it looks like from outside | What tells it apart |
|---|---|---|
| 1 | Synthesis succeeds. Audio is fine. Nothing downstream changes. | **The plan tier is too low to return character alignment.** The `vo_takes` row exists with `word_timings = []`. `v_script_vo_status` shows `shots_timed` at 0 while `takes` is non-zero — that gap is the whole signal. Characters were billed and no timings came back, so every shot keeps its authored guess. This is the single most likely expensive failure in step B and it looks like success. |
| 2 | Everything works. The whole voiceover is in the wrong voice. | A valid `voice_id` for a voice you did not intend. Nothing automated catches this — a valid id is a valid id. **Listen to the first take before running the rest of the script.** |
| 3 | Captions are subtly early or late, worse further in. | Chunk offsets misapplied at a seam. Compare the last word end of chunk *n* against the first word start of chunk *n+1* after offsets — the review screen's waveform draws both on one axis, and `pnpm verify:review` asserts the seam arithmetic on the code path. If the code is right and the seam is still wrong, the vendor returned per-chunk timings in a frame the code did not expect. |

The distinction that matters in B: **a call that returns audio has not necessarily returned
what you needed.** The audio is the cheap half of what you paid for.

---

## C. Higgsfield — Gate 4

**You need:** API access on a plan that has it, and a **publicly reachable callback URL**.

This is the gate with the least evidence behind it in the project. Nothing in stage 5 has
ever executed against the vendor. Walk it step by step rather than firing a fan-out.

**The runbook is `docs/decisions/0009-gate-4-runbook.md`** and it is written to be followed
in order, with what each step should produce and what a failure at that point means —
because three of those failures look identical from outside and have different causes.

The order, compressed:

1. **`WEBHOOK_CALLBACK_BASE_URL` must be the production domain.** Not a preview URL: preview
   hostnames change on every push, and a webhook registered against a dead one fails
   silently — the vendor gets a DNS error and you get nothing at all.
2. **Set `HIGGSFIELD_WEBHOOK_SECRET`** on both Vercel and Trigger. The vendor does not sign
   webhook bodies; it echoes a shared secret in a header. That secret is the whole of the
   authentication.
3. Settings → Integrations → Higgsfield → key + secret → **Test connection**.
4. Settings → Rate card → the credit rates. **These cannot be read from documentation** —
   nobody publishes them. Submit one generation, watch the credit balance move, and enter
   the observed delta. Until then every submit refuses, which is correct.
5. **Submit exactly one shot.** Watch for the callback.
6. **Attack it deliberately** — steps 4 and 6 of the runbook. Forge a callback with the
   right secret and a job id you made up; the confirmation must refuse it. The only thing
   standing between a leaked secret and a forged asset is that the status URL is
   *constructed* from our own stored job id and never taken from the request body.

**How you know it worked:** a `generations` row at `succeeded` with `confirmed_at` set, an
`assets` row with `normalized_at` set, and a `cost_ledger` row written *before* the result
came back.

**Known vendor behaviour, so you do not misread it:** rate limits are undocumented and fail
silently, credits expire in about 90 days, and the docs are sparse. Treat a silent failure
as a rate limit before you treat it as a bug.

### C — what can go wrong, cheapest first

**Cheap — minutes, no money moves.**

| # | What it looks like from outside | What tells it apart |
|---|---|---|
| 1 | Test connection fails. | `integration_checks`, with the vendor's message. 401 = wrong key or secret. 403 = the API is gated to a higher plan than yours, which is a billing problem and not a config one. |
| 2 | Submit refuses immediately, before any call. | `WEBHOOK_CALLBACK_BASE_URL` is unset. `requireEnv` names the variable and the thing that wanted it. This refusal is the system working — see expensive #1 for what happens when it is set *wrongly* instead of not at all. |
| 3 | Submit refuses on pricing. | No verified credit rate. Correct, and the only way through it is expensive #2. |
| 4 | The app says a column does not exist; `psql` disagrees. | Stale PostgREST cache. `pnpm db:doctor`. |

**Expensive — bills, and produces nothing usable.**

| # | What it looks like from outside | What tells it apart |
|---|---|---|
| 1 | The submit succeeds. The generation sits at `queued` forever and then times out. Credits are gone. | **`WEBHOOK_CALLBACK_BASE_URL` points somewhere the vendor cannot reach** — a preview hostname, or localhost. The vendor gets a DNS failure and you get nothing at all. The distinguisher is `generations.webhook_deliveries`: **zero** means the callback never arrived; **non-zero** means it arrived and was rejected, which is a *different* problem (expensive #3). `v_unconfirmed_terminal_generations` lists everything in this state. This is the classic and it is why step 1 of the runbook is the production domain. |
| 2 | Every rupee figure in the product is confidently wrong. | **A credit rate entered from documentation rather than observation.** Nobody publishes these. The tell is `rate_card.source_note`: if it does not describe an observed balance delta, nobody observed one. Cost-per-video is the number this project exists to measure, and it cannot be backfilled. |
| 3 | Same as #1 from outside — generation hangs — but `webhook_deliveries` is non-zero. | **The shared secret differs between Vercel and Trigger**, so deliveries arrive and are refused with 401. Two systems, one variable, set separately. `v_replayed_callbacks` also surfaces repeat deliveries here. |
| 4 | Roughly half the fan-out fails, intermittently, and it looks like the vendor is flaky. | **An undocumented rate limit, hit by submitting every shot at once.** Failures still bill in some cases. Mitigation is procedural: **submit exactly one shot first** (runbook step 5), then raise concurrency from `integrations.concurrency_limit` rather than from a guess. `integrations.concurrency_source` exists so a screen never presents a default as a reading. |
| 5 | A forged completion lands an asset you did not generate. | This is defended structurally and is worth confirming rather than assuming: the status URL is *constructed* from our own stored `external_job_id` and never read from the request body. **Runbook steps 4 and 6 break it deliberately.** Do them — the confirmation is the security control and it has never been exercised. |

**Two things you do not have to worry about, so you do not spend time on them:**

- *A replayed webhook paying twice.* `confirm_generation_once` is a compare-and-set on
  `confirmed_at is null`; the second settlement is a no-op and shows up in
  `v_replayed_callbacks`. Migration 0015.
- *A video billed against a failed still.* The video submit lives inside the still's webhook
  handler, so it cannot fire unless the still succeeded. That ordering is the single easiest
  way to spend money on nothing in this pipeline, and it is prevented by where the code
  lives rather than by remembering.

---

## D. Your hour on shot recipes

**Unblocks:** stage 5 generating anything at all. Until the library has a recipe, both
`generate_shot` in the Studio lane and the pipeline's stage-4 compile refuse — and they
refuse with the empty library named as the reason, which is the system working.

**Where to explore:** the vendor's own hosted MCP server, in a Claude Code session. That is
what it is for — trying models, motions, seeds and character references interactively. It
can be attached to a session directly, which is the fastest way to work: ask, watch, save
the ones that survive. Do **not** explore through Kiln's `/api/mcp`: it refuses anything the
workspace is not set up to do, which is correct and is not what you want at 1am with a seed
to try.

Two things about that session that are easy to get wrong. Credits spent there are **not**
Kiln's rows — a generation made through the vendor's MCP lands in the vendor's account with
no `generations` row, no `cost_ledger` row and no idempotency key we issued, which is
exactly why Kiln has its own MCP server (Addendum 01 §2). And the exploration itself is a
real cost that the cost-per-video figure will never see. Budget it separately and knowingly;
`generations.origin = 'studio_unmanaged'` exists to record such rows with
`cost_inr = null` if you ever want to, because zero is a claim and null is the truth.

**What makes a recipe worth saving** — the bar is deliberately high, because a recipe that
cannot reproduce its own sample is worse than an empty library. An empty library is honest;
a broken one is trusted.

- You watched the clip and it is good.
- You have the **exact** parameters, verbatim. Not a summary, not defaults.
- Every `{{placeholder}}` in the template is fillable from what a shot carries:
  `{{description}}`, `{{intent}}`, `{{duration}}`. An unresolved placeholder is not blank —
  it reaches the vendor literally and is billed as a clip of the words "{{subject}}".
- If you tick **accepts character reference**, you watched a clip from these exact params
  and the person was the right person. A wrongly ticked box turns a refusal into a stranger
  in your video.

**Save them at** `/library/prompts`. That screen leads with what is *missing* — which shot
kinds have no recipe and which shots are blocked — so start there and work the gaps rather
than saving whatever you happened to try.

Aim for at least one recipe per shot kind you actually use. One recipe for a kind is a
warning, not a tick: every shot of that kind in every video gets the same camera move, and
repeated identical camera moves are exactly what the inauthentic-content policy looks for.

### D — what can go wrong, cheapest first

**Cheap — minutes, and the save is refused before anything is stored.**

| # | What it looks like from outside | What tells it apart |
|---|---|---|
| 1 | Save refused, naming a placeholder. | The template uses something a shot does not carry. Only `{{description}}`, `{{intent}}` and `{{duration}}` are fillable. The refusal lists the offenders by name. |
| 2 | Save refused on params. | `params` must parse as a JSON **object**. A string, an array or a number is not a parameter set, and the CHECK constraint in 0010 refuses an empty one. |
| 3 | You saved it and nothing changed — shots still will not compile. | **No tags, or the wrong tag.** A recipe with no shot kind matches nothing. The gaps table at the top of `/library/prompts` still lists the kind as uncovered; that table is the answer to "did that help?". |
| 4 | The vendor rejects the payload on submit. | Wrong `driver` or `model` string in the recipe. Fails fast, usually without billing. |

**Expensive — bills later, repeatedly, and looks fine until it does not.**

| # | What it looks like from outside | What tells it apart |
|---|---|---|
| 1 | Everything works. Clips come back. They are not good, and you cannot say why. | **A recipe saved from a clip nobody watched.** Every future shot of that kind is generated from a guess, billed, and discarded. The tell before it costs anything: `sample_output_url` empty, and `win_rate` null forever. There is no automated check here and there cannot be — this is exactly the discipline the library exists to enforce, and the reason an empty library is better than a broken one. An empty library is honest; a broken one is trusted. |
| 2 | The person in the video is not your character. | **`accepts_character_ref` ticked without watching a clip that carried one.** Compilation refuses to use a recipe *without* the flag for a shot that has a character — so a wrongly ticked box turns that refusal into a stranger, billed, in a finished video. Only tick it after you have watched a clip from these exact params and the face was right. |
| 3 | Videos are individually fine and collectively identical. | **One recipe per kind.** `v_recipe_coverage` reports `top_recipe_share`; 1.0 means one camera, always. Repeated identical camera moves are named in the inauthentic-content policy, so this is a compliance risk rather than an aesthetic one. |
| 4 | A batch generated weeks later looks different from the sample. | **Params summarised rather than copied verbatim.** The recipe cannot reproduce its own sample. Catch it now: regenerate once from the saved recipe and compare against `sample_output_url`. That is the cheapest hour you will spend in step D. |

The rule underneath all four: **the library is the set of things that are not guesses.** Two
recipes you watched beat nine you assembled from a docs page.

---

## E. Gate 5 — one video, end to end, watched

Only after A–D. Run the stages in pipeline order, which is **not** numeric order:

```
  3 script  →  4 shotlist  →  6 voice  →  5 video  →  5b ingest  →  7 assemble  →  8 review
```

Stage 6 before stage 5 is the audio-first inversion and it is load-bearing: word timings set
shot durations, so generating video first means generating it against a word-count guess and
spending the expensive artifact's budget on it.

**At the review screen, before you pass it, look at the drift column.** It is the rightmost
number in the shot strip. Anything over 0.25s means the picture and the voice have come
apart — the words land over the wrong images — and the file plays perfectly regardless.
Trimming a shot is the usual cause: it shortens the picture and not the voice, and the error
accumulates onto every later shot.

**Then publish manually.** Download the render, copy the metadata, upload by hand. Auto-
publish is blocked on Meta app review and must not be built until that clears.

---

## Rates: which ones you may type, and which you may not

Two kinds, and conflating them costs you in opposite directions — one blocks a stage for no
reason, the other makes every rupee figure downstream confidently wrong.

| Kind | Example | May you enter it from documentation? |
|---|---|---|
| **Published rate** | Anthropic per-token, ElevenLabs per-character | **Yes.** Mark it verified, cite the page and the date in `source_note`, exactly as the two `anthropic` rows in migration 0006 do. |
| **Unpublished credit rate** | Every video-model credit price | **No.** Nobody publishes them. Submit one generation, watch the credit balance move, enter the observed delta, and say so in `source_note`. |

The tell is `rate_card.source_note`. If it names a pricing page and a date, it is the first
kind. If it does not describe an observed balance change, it must not be marked verified —
and an unverified rate produces no rupee figure anywhere and refuses the submit, which is
the system working.

The rule in step C — "do not enter a credit rate you read in documentation" — is about the
second kind only. Applying it to ElevenLabs would block stage 6 for no reason.

## Three things not to do

1. **Do not add an application-level publish bypass.** `enforce_review_pass` is a database
   trigger and a compliance control, not a workflow convenience. No `force` flag, no admin
   override. ARCHITECTURE.md §0.2.
2. **Do not enter a *credit* rate you read in documentation.** Nobody publishes them. A rate
   marked verified that nobody observed makes every rupee figure downstream confidently
   wrong, and cost-per-video is the number this project is measured by. This does **not**
   apply to published per-token and per-character rates — see the table above.
3. **Do not fill the prompt library from recipes you have not watched.** See D.

---

## What is still unproven, and where it is written down

`docs/decisions/0008-what-is-unverified.md` is the live register — read it before claiming
anything works. The short version, in the order it will bite:

| Not run | Symptom if wrong |
|---|---|
| Stage 5, every part | The confirmation is the security control and has never been exercised |
| The ffmpeg build extension, as a built image | `spawn ffmpeg ENOENT`, after money moved. `trigger:deploy:dry` closes it |
| Stage 6 against the vendor | No word timings, so no derived durations and no captions |
| Anthropic fetching `/api/mcp` | The Studio connector leg. Needs a public hostname; ADR 0011 |
| Supabase Vault, hosted storage | Both have harnesses that need a live project |

