# CLAUDE.md — Kiln

AI video content pipeline. Trend → concept → script → shots → generate → assemble → review → publish → measure.
Read `docs/ARCHITECTURE.md` before proposing anything structural. `docs/SCHEMA.sql` is the source of truth for data shape.

## Stack

Next.js 15 (App Router) on Vercel · Supabase Postgres · **Supabase Storage** (S3 protocol) ·
**Trigger.dev v4** · Remotion + ffmpeg · **Remotion Player / Vidstack / wavesurfer.js** on the
review screen · Higgsfield (**`@higgsfield/client`**) · ElevenLabs · Anthropic SDK ·
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

Two surfaces, different jobs — do not confuse them:

| Surface | Use for | Never use for |
|---|---|---|
| Hosted MCP `https://mcp.higgsfield.ai/mcp` | Interactive exploration in this Claude Code session: trying models, motions, seeds, character refs; finding shot recipes | Production runs, cron jobs, anything needing retries or cost attribution |
| `higgsfield-js` SDK (REST + webhook) | Everything in `src/trigger/` | Interactive back-and-forth |

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

```bash
pnpm doctor                          # which failure is this? — run this first, always
pnpm verify:ingest   "$DATABASE_URL" # 3 shapes → canonical, corrupt → error row
pnpm verify:assemble "$DATABASE_URL" # 6 clips → one MP4, over a real S3 endpoint
```

## Current phase

Phase 1 — see `docs/ROADMAP.md`. Publishing is manual (download + copy metadata). Do not build auto-publish until Meta app review clears.
