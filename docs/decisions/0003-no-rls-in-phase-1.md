# 0003 — No RLS in Phase 1, and what that obliges

**Date:** 2026-08-01
**Status:** accepted (revisit before any second user, and before Phase 3)

## Context

`docs/SCHEMA.sql` declares no row-level security and no policies. ARCHITECTURE.md §1
lists Supabase Auth with "single user for now; don't build tenancy yet", which is the
right call — tenancy built before it is needed is tenancy built wrong.

But "no RLS" is not a neutral default. With RLS off, the anon key is not a reduced
privilege; it is full read/write access to every table, handed to anyone who opens
DevTools. The schema is silent on this, so it is worth being explicit rather than
discovering it later.

## Decision

Leave RLS off for Phase 1. In exchange, the anon key is treated as having no privileges
worth using:

- Every write goes through the service-role client, on the server or in a Trigger task.
- Data reaches the browser through Server Components, not through a browser-side
  Supabase client.
- `serviceClient()` throws if it is ever constructed in a browser context.
- `SUPABASE_SERVICE_ROLE_KEY` never takes a `NEXT_PUBLIC_` prefix.

## Consequences

- Phase 1 is safe **only** while the Supabase instance is not publicly reachable, or
  while the anon key is not published. Do not deploy this to a public URL with a real
  anon key and consider it protected.
- Phase 3 introduces channel tokens (`channels.vault_secret_id`) and real publishing
  authority. RLS must exist before then. This is a hard prerequisite, not a nice-to-have.
- The `enforce_review_pass` trigger is unaffected: it is a database trigger, so it holds
  regardless of which key connects. That is exactly why the spec put it there rather
  than in a route handler.

## Alternative rejected

Enable RLS now with permissive policies. Rejected because a policy that allows everything
looks like a control and is not one — worse than an acknowledged absence, because it
stops anyone from asking the question again.
