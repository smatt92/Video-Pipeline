# 0015 — Video and image generation on the Runway API

Status: accepted · 2026-10-06 · supersedes 0012 row 14 for the Bureau run · extends 0013

## Decision

Sahil, 06-Oct-2026 (plan v2.3): one vendor and one credit pool for character video, money
shots, reference frames, voice, dubs and sound effects — the **Runway API**. A free Gemini key
stays, for script and title embeddings only. Higgsfield and fal stay in the code as dormant
failover, routed off.

| Route | Before | Now |
|---|---|---|
| `character_beat` | Higgsfield (webhook), fal failover | Runway `gen4_turbo` image-to-video from the character's locked reference frame |
| `money_shot` | Gemini Veo (polled) | Runway `veo3.1_fast`, `audio: false` passed explicitly; image-to-video with a start frame, else text-to-video |
| `acted_beat` | Runway Act-Two (its own HTTP code in `jobs.ts`) | Runway Act-Two through the shared client |
| reference frames | none — placeholders, Prompt B on app credits | Runway `gen4_image` via `pnpm frame:audition` → Sahil picks → `pnpm frame:lock` |
| embeddings | Gemini | Gemini, free tier, with 429 backoff |

## Why

One account, one balance, one set of outages to watch, one key on the worker. Voice moved in
0013; video was the last thing keeping a second paid vendor in the pipeline, and Higgsfield's
own record here (undocumented rate limits that fail silently, credits that expire, API gated
to a higher plan) was the cost of keeping it.

## Trade-offs accepted

- **Single vendor.** A Runway outage now stops voice *and* video. The failover path below is
  the mitigation, and it is off.
- **Gen-4 Turbo stickman consistency is unproven.** Gen-4 Turbo animates from a first frame;
  nobody has watched it hold a chalk-line figure with one accent colour for 8 seconds. That is
  why the seeded `gen4_turbo` recipe is **retired** (`accepts_character_ref = false`) until a
  clip has been watched — see "What turns it on".
- **Veo through Runway costs more per second than Gemini direct** (Sahil's statement in the
  prompt; not re-priced here). Accepted for the single pool; at most one money shot per Short.
- **No webhooks.** Runway offers none (0013). Every Runway task is polled by `21-gen-dispatch`
  once a minute through the per-provider concurrency in `claim_gen_jobs` (Runway: 3). The
  recorded exception to rule 4 now covers video too.
- **API credits are a separate pool from Runway app credits.** Prompt B's cast work in the app
  does not fund the pipeline, and vice versa.

## The facts, checked against the vendor

Read from `runwayml/sdk-node` 4.21.0 (main, fetched 2026-10-06), `src/resources/`. The pricing
page (`docs.dev.runwayml.com/guides/pricing`) could not be read from this environment (the
fetch needed an interactive permission nobody was present to grant), and the API host is
outside the egress allowlist, so **no figure below has been observed against a balance**.

| Fact given | What the SDK says | Consequence in code |
|---|---|---|
| gen4_turbo image-to-video | `promptImage` required (string or `[{uri, position:'first'}]`); `ratio` one of `1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672`; `duration?: number` — documented as **2–10 s** since SDK 3.5.0 (`5 | 10` before that) | 9:16 is `720:1280`; billed length = ceil(shot), clamped 2–10 (`clipSeconds`) |
| veo3.1_fast, 10 credits/s audio off, 15 with | `audio?: boolean` ("Audio inclusion affects pricing"); `duration?: 4 \| 6 \| 8`; `ratio` one of `1280:720, 720:1280, 1080:1920, 1920:1080`; image-to-video (first and optional last frame) **and** text-to-video | `audio: false` in every body (asserted by `test:bureau`, LOAD-BEARING); 3.2 s → a 4 s clip |
| "do not assume 9:16 or 8 s exist for every model" | Confirmed: gen4_turbo has no `1080:1920`; Veo has no 5 s or 10 s | Per-model tables in `video-runway.ts`; a body that cannot be built is refused before anything is ledgered |
| gen4_image 5 credits (720p) / 8 (1080p), with references | `referenceImages?` ≤ 3, `tag` 3–16 chars, letter first, `[A-Za-z0-9_]`; 9:16 ratios `720:1280`, `1080:1920` | Rate rows per resolution (`image_720p`, `image_1080p`); tags validated |
| gen4_image_turbo 2 credits | `referenceImages` **required** | Refused without one |
| promptText | ≤ 1000 UTF-16 code units, every model here | Refused, never clipped (a clip drops the trailing style rule) |
| $0.01 per credit | not in the SDK | `CREDIT_USD` (unchanged from 0013) |
| — | **Terminal tasks carry `cost.credits`**: "Final cost in credits … Fully refunded tasks report 0" | Written as a `reconcile` row with `cost_source = 'measured'` (0032: "the vendor told us"). Absent → nothing written; the estimate stands, labelled |
| eleven_voice_dubbing 1 credit / 2 s | not in the SDK | Unchanged: dubs keep ledgering the vendor's own `estimatedCost` upper bound (0013) |
| eleven_text_to_sound_v2 1 credit / s | not in the SDK; the Runway MCP's tool description says the same | Unchanged |

## What was built

- `src/lib/drivers/runway.ts` — **the one Runway HTTP client.** Start task, read task, poll
  with backoff (5 s doubling to 20 s; the vendor asks for no more than one read per 5 s),
  organisation read. `voice-runway.ts` and `jobs.ts` (Act-Two, and now video) both use it; the
  second hand-rolled client that lived in `jobs.ts` is gone.
- `src/lib/drivers/video-runway.ts` — model tables, `clipSeconds` / `clipCredits`, request
  bodies (pure, harnessed), `submitVideo`, `submitPerformance`, `submitImage`.
- `src/lib/drivers/generation.ts` — the vendor-neutral face core code imports:
  `billedSeconds(provider, model, shotS)`, the shared number the estimator prices, the fitter
  swaps against, the enqueue submits and the dispatcher ledgers.
- Routing: `ROUTE_PROVIDERS` in `jobs.ts` — Runway primary for all three generated routes —
  and `providersForRoute(route)`, **the one routing predicate**. `recipeForRoute` (estimator)
  and `enqueueGeneration` (submitter, via the same recipe) both resolve through it.
- Reference frames: the dispatcher resolves `params.reference_frame` (`storage:<key>` or https)
  to a 15-minute presigned URL **for the call only** and never writes it back; QC resolves it
  the same way for the vision judge. `syncCast` copies a `storage:` reference from
  `characters.json` into `characters.external_ref_id`.
- `pnpm frame:audition` / `pnpm frame:lock` — the `voice:audition` / `voice:lock` pattern:
  candidates priced up front against the verified rate row and refused over `--max-usd`, a
  ledger estimate before each call and a measured reconcile after; nothing written to storage
  or the bible until Sahil runs `frame:lock`, which uploads, reads back, compares bytes, and
  only then edits `reference_frame_ids`. The commit is his.
- Migration 0043: rate rows; two recipes, retired; the variation refusal in
  `bureau_brief_approve`.
- `verify:runway-video` — see 0008 §15.

## The failover path

`GENERATION_FAILOVER` — `off` (default, production) or `on`; anything else throws at the first
routing decision rather than reading as off. Off: `providersForRoute` returns only `runway`,
so no recipe for Higgsfield, fal or Gemini Veo can be selected, no job is ever queued for
them, and a missing `HIGGSFIELD_*` or `FAL_KEY` blocks nothing (the dispatcher's
per-provider loop finds no jobs; `credentialsFor` is never asked). On: character beats fall
over to Higgsfield then fal, money shots to Gemini Veo — **only when a recipe for them is
active and their rate is verified**; neither is true today, so turning the flag on changes
nothing until someone adds both. Failover is per *recipe selection*, not per failed job: a
Runway job that fails stays failed (retried by the queue's own attempts), it is not
re-submitted elsewhere — re-routing a paid-for failure automatically is the kind of thing
that doubles a bill silently.

One limitation, recorded rather than fixed: a Higgsfield character reference was a vendor-side
id (`external_ref_id` without a URL). `syncCast` now copies only `storage:` and `https`
references, so with failover on, a Higgsfield character beat would need its own reference
added — the dispatcher refuses a frame that is neither, by name.

## The legacy lane is untouched

`primaryForKind('video')` still answers Higgsfield, because the pre-Bureau concept → script
lane (`05-generate`, `submitShots`, the `/api/webhooks/…` confirm path, `verify:submit`,
`verify:webhook`) is webhook-only and built on that SDK. The Bureau episode run never calls it.
The onboarding wizard no longer asks for it: steps resolve through `ROLE_INTEGRATION`
(`generation` and `voice` → Runway, `embeddings` → Gemini, new required step 11), so the
dormant vendor is not a precondition for using the app. Porting or deleting the legacy lane is
a separate decision.

## "Required" keys, and where the requirement lives

`RUNWAY_API_KEY` and `GEMINI_API_KEY` are required to *run* — onboarding steps 4/5 and 11 do
not complete without them, and each stage refuses by name. They stay **optional in the boot
schema** (`src/lib/drivers/env.ts`): it is validated at boot on Vercel, and a credential only
the wizard can supply cannot be a precondition for reaching the wizard (the 500-on-every-route
incident recorded in that file). CLAUDE.md wins over the prompt's wording here.

## Embeddings: absent is not zero

Free tier → 429 is normal. `embedTexts` retries a 429 up to 4 calls (Retry-After honoured,
else 2 s doubling) and then returns `ok: false` with the reason. `checkVariation` turns any
uncomputed similarity into status **`refused`** with `refused_reason` (the vendor's sentence),
`similarity.ok = null`, and no score — never `pass`, never `0`. The brief is flagged
`variation:refused — …`; `approveBrief` refuses it, and so does `bureau_brief_approve` in the
database (0043), for a caller that skips the TypeScript. Re-running `variation_check` with the
brief's id computes and stores the embedding and the new result, which lifts the refusal.

**Why not `v_pipeline_blockers`.** That view is one row per *script*, and a script exists only
after a brief is approved — by which point variation has already been checked. An embeddings
blocker there would mark scripts blocked by something that no longer blocks them, the defect
0029 removed. The refusal lives where the consumer refuses: on the brief (flag + stored
result, shown on the Approvals card) and at approval.

The embeddings ledger row is still priced at the paid tier's published rate (0040) on a free
key — an over-statement of fractions of a paisa, labelled `rate_card`, kept rather than
writing a zero nobody measured.

## Cost per Short

At USD 0.01 per credit and ₹88 per USD. One call is what gets ledgered; the plan figure
multiplies generated shots by `REROLL_ALLOWANCE = 1.5` (half the clips re-rolled once), and
the episode total and `fitToCap` use the plan figure, so the cap is checked against what a
Short is expected to cost.

| Line | Credits per call | Planned (× 1.5) | ₹ planned |
|---|---|---|---|
| Character beat, 8 s gen4_turbo (5/s) | 40 | 60 | 52.80 |
| Voice, ~900 characters (1 per 50) | 18 | 18 (not re-rolled) | 15.84 |
| Money shot, 4 s veo3.1_fast audio off (10/s) — optional | 40 | 60 | 52.80 |
| **Without a money shot** | | **78** | **68.64** |
| **With one** | | **138** | **121.44** |

Against the ₹150 per-Short cap and the ₹125 target. A 3.2 s money shot is billed as 4 s and a
7.4 s beat as 8 s — `billedSeconds`, so the table is what the estimator computes.

## What turns it on (Sahil)

1. Paste `docs/bureau/hosted-migrations-3-of-3-0043.sql` after bundles 1 and 2.
2. Settings → Integrations (or onboarding step 4): Runway API key; step 11: Gemini key.
3. `pnpm frame:audition --character pip --ref <Prompt B sheet>` → pick →
   `pnpm frame:lock pip <file>` → commit `characters.json`.
4. `RUNWAY_API_KEY=… pnpm verify:runway-video "$DATABASE_URL" --require-real --frame <Pip's locked png>`
   — one 25-credit clip, saved to `out/runway-video-real.mp4`; watch it.
5. If Pip held, activate the recipe (the statement is in `HANDOVER-PROMPT-I.md`).
