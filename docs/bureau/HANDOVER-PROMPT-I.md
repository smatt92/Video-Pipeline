# Handover — Prompt I: generation on the Runway API (06-Oct-2026)

Decision: `docs/decisions/0015-generation-on-runway.md`. Register: `0008` §15. Voice-library
answer: `0013`, addendum.

## Before this run, what routed where

| Route | Was |
|---|---|
| `character_beat` | Higgsfield (webhook) → fal failover; recipe needed `accepts_character_ref`; every beat was an overlay in practice because all reference frames were placeholders |
| `money_shot` | Gemini Veo, polled, no failover |
| `acted_beat` | Runway Act-Two through its own HTTP code in `jobs.ts` (a second Runway client) |
| reference frames | no generation path; placeholders in `characters.json` |

## Now

- Runway first for all three generated routes (`gen4_turbo`, `veo3.1_fast` with `audio:false`
  passed explicitly, Act-Two). Higgsfield / fal / Gemini Veo only with `GENERATION_FAILOVER=on`.
  One routing predicate, `providersForRoute`, used by the estimator and the submitter.
- One Runway HTTP client (`src/lib/drivers/runway.ts`) for voice, dubs, SFX, Act-Two and video.
- Billed length shared by estimate, cap fitter, enqueue and ledger (gen4_turbo 2–10 s whole,
  Veo 4/6/8). Planned figure = one call × 1.5; the ledger gets one call; a terminal task's
  `cost.credits` lands as a **measured** reconcile.
- Reference frames: `pnpm frame:audition` → pick → `pnpm frame:lock` (uploads, reads back,
  writes `storage:` into `characters.json`; you commit). Resolved per call, never stored resolved.
- Embeddings: 429 backoff; an uncomputed similarity makes `variation_check` **refuse** by name;
  approval refuses in TypeScript and in SQL; re-running `variation_check` on the brief lifts it.
- Onboarding: step 4 generation + step 5 voice → Runway key; new required step 11 → Gemini key.
- Migration **0044** (renumbered: 0043 is the Vault-function fix that landed first).

## CI

Green on `f8bf74c` (run 140): all 50 steps before Build passed, including the new
“Character beats on the generation vendor — ledger, status, stored frame count”; then Build,
the render, the episode end to end, scaling and the tour. Step list below.

## Sahil — what to do, in order

1. **Paste** `docs/bureau/hosted-migrations-3-0043.sql` (if not yet), then
   `docs/bureau/hosted-migrations-3-of-3-0044.sql`. One transaction each; a second paste refuses.
2. **Vercel and Trigger.dev environment** — see (a) below.
3. Settings → Integrations → Runway: paste the API key, verify. Onboarding step 11: Gemini key.
4. Lock Pip's frame: `pnpm frame:audition --character pip --ref <Prompt B sheet.png> --count 4`
   → look → `pnpm frame:lock pip out/frames/pip/<file>.png` → commit `characters.json`.
5. One real clip (25 credits): `RUNWAY_API_KEY=… pnpm verify:runway-video "$DATABASE_URL"
   --require-real --frame out/frames/pip/<file>.png`; watch `out/runway-video-real.mp4`.
6. If Pip held, activate the recipe in the SQL editor:
   `update prompts set is_active = true, accepts_character_ref = true, retired_at = null, retired_reason = null where name = 'bureau-character-beat-gen4-turbo' and version = 1;`
   Money shots, after watching one: same with `'bureau-money-shot-veo31-fast'`
   (`accepts_character_ref` stays false).
7. Compare the first measured reconcile's credits with the estimate's billed seconds × 5. If
   they differ, insert a superseding `rate_card` row (never UPDATE).

### (a) Environment variable changes

| Variable | Vercel | Trigger.dev (prod) | Value from |
|---|---|---|---|
| `RUNWAY_API_KEY` | optional fallback | optional fallback (the stages read the integration record in Vault first; set it here only if Vault is not populated) | dev.runwayml.com → API Keys. API credits, not app credits |
| `GEMINI_API_KEY` | optional fallback | optional fallback (same) | Google AI Studio → Get API key (free tier) |
| `GENERATION_FAILOVER` | leave unset (= off) | leave unset (= off) | — set `on` only to route to the dormant vendors |
| `HIGGSFIELD_API_KEY_ID`, `HIGGSFIELD_API_KEY_SECRET`, `HIGGSFIELD_WEBHOOK_SECRET`, `FAL_KEY` | may be removed | may be removed | not needed by the Bureau run; the legacy `05-generate` lane still needs the Higgsfield ones if you ever use it |

Nothing new is required at boot: Vercel starts with none of these. The real requirement is the integration record: step 3 above.

### (b) Hosted-migration bundle

`docs/bureau/hosted-migrations-3-of-3-0044.sql` — after `hosted-migrations-3-0043.sql`.

### (c) Still unverified

- Every Runway video/image/task call (host outside this container's egress; no key here).
  `verify:runway-video` §1 ran the real driver, dispatcher and ingest against a local stand-in
  at the vendor's paths; §2 (one real clip) skipped.
- The rates (plan v2.3 figures, marked verified as published prices; the pricing page was not
  readable here) and whether terminal tasks really carry `cost.credits`.
- Whether gen4_turbo holds the chalk-line cast — why both recipes ship retired.
- `frame:audition` / `frame:lock` — never run.
- Gemini free-tier rate limits in practice.
- The legacy `05-generate` lane is unchanged and still Higgsfield-only (a separate decision).

## CI step list (run 140, `f8bf74c`, read step by step — not the log tail)

Every step `success`: guards (gates, script names, worker binaries, worker env manifest —
which caught `GENERATION_FAILOVER` locally first —, Remotion lockstep, font scale, guardrails,
**vendor isolation** — which caught a vendor name in a refusal message locally first —,
calendar, public env), typecheck, lint, timings, tour, **Bureau rules**, entry flow, migrations
0001–0044 applied, enums, drift, catalogue rows, duplicates, align, ingest, assemble, review,
stages 1/2/5/9/10/11, webhook, referral, costs, voice, limits, pilot, Studio MCP, **Bureau MCP**,
Bureau publishing, **verify:runway-video** (§2 SKIP by design), Build (no vendor credentials in
its env), render, **episode end to end**, scaling, tour.

## Found on the way

A parallel session pushed migration `0043_close_secret_delete_to_anon.sql` while this one had
its own 0043; the rebase was clean and CI on that intermediate head (run 139) was **green**,
because the ledger insert is `on conflict (version) do nothing` — the second 0043 applied
without being recorded, and any database already holding 0043 would have skipped it for ever.
Renumbered to 0044, and `scripts/lib/migrations.mjs` now refuses two files with one version in
every tool that lists migrations.
