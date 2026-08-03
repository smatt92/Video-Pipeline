-- Migration 0022 — a generation that has a row and does not yet have a job
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION.
--
-- `generations.status` was written when the row was created *after* the vendor accepted
-- the call. In that world `queued` is exact: the row exists, the vendor has the job, the
-- id is on the row, and the callback can find it.
--
-- Stage 5 now writes the row *before* the call, and it has to. A crash between the insert
-- and the submit must leave evidence that a submit was attempted — the idempotency key is
-- what stops the retry from becoming a second charge, and a key that was never written
-- protects nothing. So the row goes first.
--
-- That creates a state the original design had no name for: a row with no
-- `external_job_id`, where nobody yet knows whether the vendor has the work. Calling it
-- `queued` would make it indistinguishable from a submitted job whose id failed to write,
-- which is exactly the row an operator needs to be able to find.
--
-- The tested-by-a-second-case shape, precisely: the first design was right for its case,
-- and a second case revealed a state it could not express.
-- ─────────────────────────────────────────────────────────────

alter table generations drop constraint if exists generations_status_check;

alter table generations
  add constraint generations_status_check
  check (status = any (array[
    'submitting'::text,
    'queued'::text,
    'running'::text,
    'succeeded'::text,
    'failed'::text,
    'cancelled'::text,
    'timeout'::text
  ]));

comment on column generations.status is
  'submitting — the row exists and the vendor has not been called yet, or the call is in '
  'flight. queued — the vendor accepted it and external_job_id is set. A row stuck in '
  'submitting is the one an operator must be able to find: it means a submit was attempted '
  'and nobody knows whether it landed, which is the only state in this table where the '
  'money may be spent and the evidence missing.';

-- ─────────────────────────────────────────────────────────────
-- The row that needs a human
--
-- Not an alert, a view. A submit that crashed between the insert and the vendor's reply
-- cannot be resolved automatically: retrying might double-charge, and abandoning it might
-- throw away a generation that succeeded. The only correct response is to look, which
-- means the rows have to be findable.
--
-- The interval is deliberate. A submit in flight is a normal state for a few seconds; one
-- that has been in flight for five minutes is not, because the driver's own timeout is far
-- below that.
-- ─────────────────────────────────────────────────────────────

create view v_stuck_submits as
select
  g.id,
  g.shot_id,
  g.driver,
  g.model,
  g.idempotency_key,
  g.submitted_at,
  now() - g.submitted_at as stuck_for,
  -- The estimate row exists whether or not the call landed, because rule 5 writes it
  -- first. Its presence is what makes this a money question rather than a tidying one.
  exists (
    select 1 from cost_ledger cl
     where cl.idempotency_key = g.idempotency_key || ':estimate'
  ) as charged
from generations g
where g.status = 'submitting'
  and g.external_job_id is null
  and g.submitted_at < now() - interval '5 minutes';

comment on view v_stuck_submits is
  'Generations whose row was written and whose vendor call cannot be accounted for. '
  'Deliberately not auto-resolved: retrying may double-charge and abandoning may discard '
  'a generation that succeeded, so the only correct response is a human looking. `charged` '
  'says whether an estimate row was already written, which is what decides how urgent it is.';

notify pgrst, 'reload schema';
