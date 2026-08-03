# CLAUDE.md — Kiln

AI video content pipeline. Trend → concept → script → shots → generate → assemble → review → publish → measure.
Read `docs/ARCHITECTURE.md` before proposing anything structural. `docs/SCHEMA.sql` is the source of truth for data shape.

## Stack

Next.js 15 (App Router) on Vercel · Supabase Postgres · **Supabase Storage** (S3 protocol) ·
**Trigger.dev v4** · Remotion + ffmpeg · **Remotion Player** (`@remotion/player`) / Vidstack /
**wavesurfer.js** on the review screen · Higgsfield (**`@higgsfield/client`**) · ElevenLabs · Anthropic SDK ·
TypeScript strict · pnpm

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

**A mechanism built to surface a failure mode is itself subject to that failure mode.**
`v_pipeline_blockers` made silence readable, and nothing read it — the board derived state
from row counts, so a concept that would never move rendered as `shot_listed` for ever. The
instrument for finding invisible problems was invisible.

So whatever you build to make a problem visible needs its own answer to **"and what reads
this?"** — named, in the same change, before it counts as done. A view with no caller, an
alert nobody routes, a log line in a file nobody opens: each is the original problem wearing
the costume of its own solution, and each is *harder* to notice than what it replaced,
because its existence reads as coverage.

**Two modules for one concept is worse than none.** `src/lib/generate/normalise.ts` and
`src/lib/ingest/normalise.ts` both existed; one defined `TARGET`/`conforms`, the other
`CANONICAL`/`isCanonical`, they disagreed about the canonical intermediate, and only one was
live. Nothing was broken and no test could show it — both compiled, the live one passed its
harness, and the dead one passed by not running. The cost is that the next person to tune
the encoder had a coin-flip's chance of editing the file that does nothing, then debugging
why their change had no effect. When you find the second module, delete one; do not
document the difference. A superseded file is not history — git is history.

```bash
pnpm doctor                          # which failure is this? — run this first, always
pnpm verify:ingest   "$DATABASE_URL" # 3 shapes → canonical, corrupt → error row
pnpm verify:assemble "$DATABASE_URL" # 6 clips → one MP4, over a real S3 endpoint
pnpm verify:studio   "$DATABASE_URL" # MCP server over real HTTP; generate_shot refuses
pnpm verify:review   "$DATABASE_URL" # a trim drifts every later shot; the publish gate holds
```

## Current phase

Phase 1 — see `docs/ROADMAP.md`. Publishing is manual (download + copy metadata). Do not build auto-publish until Meta app review clears.
