# CLAUDE.md — Kiln

AI video content pipeline. Trend → concept → script → shots → generate → assemble → review → publish → measure.
Read `docs/ARCHITECTURE.md` before proposing anything structural. `docs/SCHEMA.sql` is the source of truth for data shape.

## Stack

Next.js 15 (App Router) on Vercel · Supabase Postgres · Cloudflare R2 · Trigger.dev v3 · Remotion + ffmpeg · Higgsfield (`higgsfield-js`) · ElevenLabs · Anthropic SDK · TypeScript strict · pnpm

## Non-negotiable rules

1. **No vendor name outside `src/lib/drivers/` or `src/lib/publish/`.** `grep -rl "higgsfield\|elevenlabs" src --exclude-dir=drivers --exclude-dir=publish` must return empty. CI enforces this. If a task seems to need a vendor call elsewhere, the driver interface is wrong — fix the interface.
2. **No media bytes through a Vercel route.** 4.5MB hard limit, not configurable. Browser→R2 presigned; worker→R2 direct. Vercel handles IDs and URLs only.
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
- Trigger tasks are numbered by pipeline stage (`01-trends.ts` … `11-measure.ts`) and are individually replayable from any prior stage's output.
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

## Current phase

Phase 1 — see `docs/ROADMAP.md`. Publishing is manual (download + copy metadata). Do not build auto-publish until Meta app review clears.
