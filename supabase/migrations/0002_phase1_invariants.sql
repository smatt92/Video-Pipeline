-- Migration 0002 — Phase 1 invariants
--
-- docs/SCHEMA.sql (migration 0001) is the spec's record of the data shape and is not
-- edited. This migration is the forward-only delta that makes three CLAUDE.md rules
-- enforceable at the database rather than by application politeness.
--
-- See docs/decisions/0002-phase1-schema-deltas.md for the reasoning behind each block.

-- ─────────────────────────────────────────────────────────────
-- 1. Rule 6: "Every generation carries an idempotency_key."
--
-- 0001 declares `idempotency_key text unique`. In Postgres a nullable unique column
-- permits unlimited NULLs, so the rule was unenforced: a retry path that forgot the
-- key would insert happily and double-charge. Make it structural.
-- ─────────────────────────────────────────────────────────────

alter table generations
  alter column idempotency_key set not null;

-- ─────────────────────────────────────────────────────────────
-- 2. Webhook → waiting run correlation.
--
-- Stage 5 submits a job and parks on a Trigger.dev wait token. The webhook arrives at
-- Vercel with the vendor's request id and has to find the token that is waiting for it.
-- 0001 has nowhere to put that token, which makes the whole resume-on-webhook path in
-- ARCHITECTURE.md §2 unimplementable.
--
-- `wait_token` is written before the vendor call is made, not after, so a webhook that
-- beats the submit response still finds a row to complete.
-- ─────────────────────────────────────────────────────────────

alter table generations
  add column wait_token        text,
  add column webhook_received_at timestamptz;

comment on column generations.wait_token is
  'Trigger.dev wait token id. Written pre-submit so an early webhook can still resume the run.';
comment on column generations.webhook_received_at is
  'First webhook delivery for this generation. Non-null means the vendor called us back; '
  'a later duplicate delivery is a replay and must be ignored for cost purposes.';

create index on generations (wait_token) where wait_token is not null;

-- ─────────────────────────────────────────────────────────────
-- 3. Circuit breaker state.
--
-- CLAUDE.md: "circuit-break after N consecutive failures". Trigger.dev fans out across
-- containers, so an in-process counter breaks per worker and resets on every deploy —
-- which is to say it does not break at all. Failure state is a row, like every other
-- failure state in this system.
-- ─────────────────────────────────────────────────────────────

create table driver_health (
  driver               text primary key,
  state                text not null default 'closed'
                       check (state in ('closed','open','half_open')),
  consecutive_failures int not null default 0,
  opened_at            timestamptz,
  reopen_after         timestamptz,     -- when a half-open probe becomes allowed
  last_failure_at      timestamptz,
  last_success_at      timestamptz,
  last_error_code      text,
  updated_at           timestamptz not null default now()
);

comment on table driver_health is
  'One row per driver. The breaker reads and writes this atomically; it is also the '
  'dashboard''s answer to "is Higgsfield down or am I broken?"';

-- ─────────────────────────────────────────────────────────────
-- 4. Rate card lookups must be deterministic.
--
-- 0001 has no key on rate_card, so "the current USD rate for (driver, model)" could
-- match two rows and the cost written would depend on scan order. The cost ledger is
-- the project's headline metric; it cannot depend on scan order.
-- ─────────────────────────────────────────────────────────────

alter table rate_card
  add constraint rate_card_driver_model_effective_key
  unique (driver, model, effective_from);

create index on rate_card (driver, model, effective_from desc);

-- ─────────────────────────────────────────────────────────────
-- 5. Cost ledger: retries must not double-write.
--
-- A generation writes an estimate row at submit time and a reconciliation row when the
-- webhook confirms actual spend. Webhooks are delivered at-least-once, so without a key
-- a replayed delivery inserts a second reconciliation and inflates cost per video.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column entry_kind text not null default 'estimate'
    check (entry_kind in ('estimate','reconcile','refund'));

comment on column cost_ledger.entry_kind is
  'estimate = written at submit from the rate card, before the result exists (rule 5). '
  'reconcile = actual spend, written once on terminal webhook. '
  'refund = vendor returned credits (nsfw / failed), written as a negative amount.';

create unique index cost_ledger_generation_entry_key
  on cost_ledger (generation_id, entry_kind)
  where generation_id is not null;

-- A ledger row that attributes spend to nothing is a bug, not a row.
alter table cost_ledger
  add constraint cost_ledger_has_subject
  check (generation_id is not null or render_id is not null);

-- ─────────────────────────────────────────────────────────────
-- 6. FX provenance for cost_inr.
--
-- 0001 stores cost_usd and cost_inr side by side with no record of the rate used, so a
-- historical rupee figure cannot be explained or recomputed. Snapshot the rate on the
-- row, the same way unit_cost_snapshot works on generations.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column usd_inr_rate numeric;

comment on column cost_ledger.usd_inr_rate is
  'USD→INR rate applied when this row was written, snapshotted from USD_INR_RATE. '
  'cost_inr = cost_usd * usd_inr_rate. Keeps historical rupee figures explainable.';
