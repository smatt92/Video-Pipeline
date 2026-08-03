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
| `USD_INR_RATE` | every cost row |
| `WEBHOOK_CALLBACK_BASE_URL` | stage 5, and it must be the **production** domain |

**How you know it worked:** trigger `07-assemble` from the dashboard against a script id
that has normalised assets. It should produce a `renders` row. It will not have one yet, so
in practice this step is confirmed by C.

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

---

## D. Your hour on shot recipes

**Unblocks:** stage 5 generating anything at all. Until the library has a recipe, both
`generate_shot` in the Studio lane and the pipeline's stage-4 compile refuse — and they
refuse with the empty library named as the reason, which is the system working.

**Where to explore:** the vendor's own hosted MCP server, in a Claude Code session. That is
what it is for — trying models, motions, seeds and character references interactively. Do
**not** explore through Kiln's `/api/mcp`: it refuses anything the workspace is not set up
to do, which is correct and is not what you want at 1am with a seed to try.

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

## Three things not to do

1. **Do not add an application-level publish bypass.** `enforce_review_pass` is a database
   trigger and a compliance control, not a workflow convenience. No `force` flag, no admin
   override. ARCHITECTURE.md §0.2.
2. **Do not enter a credit rate you read in documentation.** Nobody publishes them. A rate
   marked verified that nobody observed makes every rupee figure downstream confidently
   wrong, and cost-per-video is the number this project is measured by.
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

