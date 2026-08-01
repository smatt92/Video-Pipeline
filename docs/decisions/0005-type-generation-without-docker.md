# 0005 — A no-Docker path for `db:types`

**Date:** 2026-08-01
**Status:** accepted (workaround; `pnpm db:types` stays canonical)

## Context

`supabase start` and `supabase gen types typescript` both require Docker — the latter
even when you pass `--db-url`, because it runs postgres-meta in a container and there is
no flag to avoid it.

The environment this scaffold was built in cannot pull container images at all: the
egress policy denies Docker Hub's blob CDN (`production.cloudfront.docker.com`) and
ECR's (`d2glxqk2uabbnd.cloudfront.net`), both with 403. The Docker daemon itself runs
fine; there is simply no way to obtain an image. CLAUDE.md is unambiguous that DB types
are generated and never hand-written, so "write them by hand this once" was not on the
table.

## Decision

Add `scripts/gen-types-nodocker.mjs`, which calls the **same generator the CLI calls** —
`@supabase/postgres-meta`, pinned to `0.96.6`, the exact version the bundled CLI invokes
— directly against a Postgres connection string. Same metadata query, same TypeScript
template, same output. Only the transport differs.

`pnpm db:types` (Supabase CLI, Docker) remains canonical.
`pnpm db:types:nodocker` is the fallback.

## Consequences

- One extra devDependency: `@supabase/postgres-meta@0.96.6`, pinned exactly. It is not a
  new source of truth — it is the CLI's own dependency, invoked without the container.
- The pin can drift from whatever version a newer Supabase CLI bundles. CI runs the
  no-Docker path and diffs its output against the committed `src/lib/db/types.ts`, so
  drift shows up as a failing build rather than as a silent divergence. If the two ever
  disagree, **the CLI wins** and the pin gets bumped.
- On a machine with working Docker, use `pnpm db:types`. Nothing about this decision
  makes the normal path worse.

## Alternative rejected

Point `gen types` at a hosted Supabase project (`--linked`). Rejected because it makes
type generation depend on network access and on a remote database being in the same state
as your migrations — which is exactly the drift the local-first workflow exists to
prevent.
