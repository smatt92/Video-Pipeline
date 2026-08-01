# 0002 — Five deltas on top of SCHEMA.sql

**Date:** 2026-08-01
**Status:** accepted
**Amends:** `docs/SCHEMA.sql` (via `supabase/migrations/0002_phase1_invariants.sql`)

## Context

`docs/SCHEMA.sql` applies cleanly and is migration 0001, byte for byte. Three things in
it, however, make rules the specs state plainly unenforceable, and two more make cost
figures undefendable. Migrations are forward-only and `SCHEMA.sql` is the spec's record
of the data shape, so none of this is fixed by editing that file — 0002 is the delta.

## Decisions

### 1. `generations.idempotency_key` becomes `NOT NULL`

CLAUDE.md rule 6: *"Every generation carries an idempotency_key. Retries must not
double-charge."* 0001 declares it `text unique`. In Postgres a nullable unique column
permits **unlimited** NULLs — so a retry path that forgot to set one inserts happily,
uniqueness never fires, and the vendor is billed twice. The rule was documented but not
enforced. Now it is structural.

### 2. `generations.wait_token` and `webhook_received_at`

Stage 5 submits a job and parks on a Trigger.dev wait token. The webhook arrives at
Vercel carrying the vendor's request id and must find the token waiting for it. 0001 has
nowhere to put that token, which makes the resume-on-webhook path in ARCHITECTURE.md §2
unimplementable as specified.

`wait_token` is written **before** the vendor call is made, not after, so a webhook that
beats the submit response still finds a row. `webhook_received_at` makes at-least-once
delivery detectable: a second delivery is a replay, and replays must not move money.

### 3. `driver_health` table

CLAUDE.md: *"circuit-break after N consecutive failures."* Trigger.dev fans out across
containers, so an in-process counter counts per worker and resets on every deploy — which
is to say it does not break at all. And the specs are explicit that failure states are
rows, not swallowed exceptions. This is that row. It doubles as the dashboard's answer to
"is the vendor down, or am I broken?"

### 4. `rate_card` uniqueness

0001 has no key on `rate_card`, so "the current USD rate for (driver, model)" can match
two rows and the cost written depends on scan order. Cost-per-video is the project's
headline metric; it cannot depend on scan order.

### 5. `cost_ledger.entry_kind` + FX provenance

Rule 5 requires a cost row at submit time, reconciled on completion — two rows per
generation, with different meanings. 0001 cannot tell them apart, and webhooks are
delivered at-least-once, so a replayed delivery silently inserts a second reconciliation
and inflates every downstream number. `entry_kind` plus a unique index on
`(generation_id, entry_kind)` makes the replay a no-op.

`usd_inr_rate` is added for the same reason `unit_cost_snapshot` exists on `generations`:
0001 stores `cost_usd` and `cost_inr` side by side with no record of the rate between
them, so a historical rupee figure cannot be recomputed or explained. Snapshot it.

Also added: a CHECK that a ledger row attributes spend to *something* — a row pointing at
neither a generation nor a render is a bug, not a row.

## Consequences

- `docs/SCHEMA.sql` and the live database now differ. `docs/SCHEMA.sql` is the record of
  v1, not a mirror of production; the migration sequence is the truth.
- Anything inserting into `generations` must supply an idempotency key. That is the point.

## Considered and not done

- `shots.status` has no `cancelled` value, though `generations.status` does. Left alone:
  no Phase 1 code path cancels a shot, and adding states nothing sets is how check
  constraints rot.
- Enabling RLS. Separate decision — see 0003.
