-- 0055 — One row per LLM call sent through the Message Batches API.
--
-- Forward-only. One new table; nothing existing changes.
--
-- A batched call is two moments a tick or more apart: it is submitted, and some time later
-- (usually within the hour, at most 24) its result exists. `routedBatch()` (src/lib/llm/
-- batch.ts) writes this row at submit and reads it back on every later tick until the batch
-- has ended, so the work in between survives a worker restart, a redeploy and a failed tick.
--
-- custom_id is the call's idempotency key and the batch request's `custom_id` — the same
-- string, so a result can only land on the call that asked for it, and asking twice for the
-- same key returns the first request rather than paying for a second one (rule 6).
--
-- Rule 5: the estimate ledger rows are written at submit, priced at the batch endpoint's rate
-- (0054) on an estimated quantity — input characters / 4, and max_tokens as the output upper
-- bound — and the reconcile rows are written from the result's own `usage` when it lands.
-- A request that errored or expired is not billed by the API and gets no reconcile row: its
-- estimate stays visible as committed-and-unknown rather than being closed by a zero nobody
-- measured.

create table llm_batch_requests (
  custom_id     text primary key,
  task          text not null,
  model         text not null,
  -- Null until the batch exists. A row stuck in 'submitting' with no batch id is a submit that
  -- died between this insert and the API's answer; it is reported, never silently retried.
  batch_id      text,
  status        text not null default 'submitting' check (status in
                  ('submitting', 'submitted', 'succeeded', 'errored', 'expired', 'canceled')),
  -- The LlmCostSubject the ledger rows carry, so the reconcile lands on the estimate's subject.
  subject       jsonb not null,
  usd_inr_rate  numeric not null check (usd_inr_rate > 0),
  max_tokens    integer not null check (max_tokens > 0),
  -- The schema-checked output; null until succeeded.
  result        jsonb,
  -- The API's own usage for a result, as reported. Null until one exists.
  usage         jsonb,
  error         text,
  submitted_at  timestamptz not null default now(),
  ended_at      timestamptz,
  check ((status = 'succeeded') = (result is not null)),
  check (status = 'submitting' or batch_id is not null)
);

create index llm_batch_requests_open on llm_batch_requests (submitted_at) where status in ('submitting', 'submitted');

comment on table llm_batch_requests is
  'LLM calls sent through the Message Batches API: submitted on one tick, collected on a later one. '
  'custom_id = the batch request custom_id = the cost_ledger idempotency key base.';

-- Server-side only, like every other ledger-adjacent table: the worker writes it with the
-- service role, and no browser session has any business reading prompts or model output.
alter table llm_batch_requests enable row level security;
