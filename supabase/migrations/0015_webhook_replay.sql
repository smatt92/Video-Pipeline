-- Migration 0015 — a replayed callback is a different threat from a forged one
--
-- ** SECTION 1 IS THE EVOLUTION KIND. SECTION 3'S NOTE RECORDS A CARELESSNESS. **
--
-- ─────────────────────────────────────────────────────────────
-- The question this answers
--
-- 0013 added `confirmed_at` and described it as "when the vendor's status endpoint
-- independently confirmed the outcome a webhook claimed". `v_unconfirmed_terminal_
-- generations` then reads it as a *boolean* — null means unconfirmed, which is the shape
-- of a forged callback landing.
--
-- But `confirm.ts` writes it unconditionally on every delivery, and nothing anywhere reads
-- it before acting. So the column is a flag to one reader and a most-recent-timestamp to
-- its only writer, and the second delivery of a genuine callback:
--
--   1. overwrites webhook_received_at, losing when the first one actually arrived
--   2. issues a SECOND status fetch against a vendor with undocumented rate limits that
--      fail silently
--   3. rewrites confirmed_at, destroying the record of when the outcome was really settled
--   4. at Gate 4, re-enqueues the ingest — a second download, normalise and storage write
--
-- None of that needs a leaked secret or a forged body. Anyone who can see the traffic can
-- resend a real delivery verbatim, and the vendor itself will do it on any timeout.
--
-- This is the evolution kind: the design was correct for one delivery, and the second
-- delivery is the case that tested it. It is not a contradiction on the page — nothing
-- specified idempotency and then made it impossible, the way 0009's `vo_char_start` did.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 1. Count deliveries, and keep the first one's timestamp
--
-- `webhook_received_at` becomes what it sounds like — when the FIRST callback arrived —
-- rather than when the most recent one did. That is the useful one: it is the number you
-- subtract from `submitted_at` to learn how long the vendor took.
--
-- The count is the observable part. Idempotency below makes a replay harmless; this makes
-- it *visible*, which is a separate requirement. A silently-tolerated replay and a
-- silently-tolerated forgery look identical from the outside, and one of them means
-- somebody has the secret.
-- ─────────────────────────────────────────────────────────────

alter table generations
  add column webhook_deliveries int not null default 0,
  add column webhook_last_received_at timestamptz;

comment on column generations.webhook_deliveries is
  'How many callbacks named this job. More than one is a vendor retry or a replay — '
  'harmless by construction (see confirm_generation_once) but never silent, because a '
  'replay and a forgery are indistinguishable from the outside and one of them means the '
  'shared secret leaked.';

comment on column generations.webhook_received_at is
  'When the FIRST callback for this job arrived. Not overwritten by later deliveries — '
  'the interesting interval is submitted_at → first callback, and a redelivery an hour '
  'later would otherwise erase it. See webhook_last_received_at for the most recent.';

-- ─────────────────────────────────────────────────────────────
-- 2. Recording a delivery is one atomic statement
--
-- Read-then-write would let two simultaneous deliveries both read 0 and both write 1.
-- Concurrent duplicate delivery is precisely the case being defended against, so the
-- counter cannot itself have a race in it.
-- ─────────────────────────────────────────────────────────────

create function record_webhook_delivery(p_job_id text)
returns table (generation_id uuid, deliveries int, already_confirmed boolean)
language sql
as $$
  update generations
     set webhook_deliveries      = webhook_deliveries + 1,
         webhook_received_at     = coalesce(webhook_received_at, now()),
         webhook_last_received_at = now()
   where external_job_id = p_job_id
  returning id, webhook_deliveries, confirmed_at is not null;
$$;

comment on function record_webhook_delivery is
  'Increments the delivery counter and stamps first/last arrival in one statement. '
  'Returns whether the generation was already confirmed, so the caller can skip a '
  'redundant vendor fetch on a replay without a second round trip.';

-- ─────────────────────────────────────────────────────────────
-- 3. The confirmation itself is compare-and-set
--
-- This is the guarantee. `confirmed_at is null` in the WHERE clause means exactly one
-- caller can ever transition a generation to a terminal state: the first one to get here
-- wins, every later one updates zero rows and is told so.
--
-- Returning the row count is the whole point — the caller must only enqueue the ingest
-- when it won. An application-level `if (row.confirmed_at) return` cannot give this,
-- because two deliveries can both pass that check before either writes.
--
-- ** The runbook was wrong about this, and that part IS the careless kind. ** Step 4 of
-- 0009 says it tests replay protection; what it actually tests is a callback with a wrong
-- secret and a callback with an invented job id. Both are forgery. The genuine-callback-
-- twice case — the one available to anyone who can see the traffic, with no secret needed
-- — was named and not tested. Writing "replay" and testing "forge" is the sort of thing
-- re-reading your own spec catches.
-- ─────────────────────────────────────────────────────────────

create function confirm_generation_once(
  p_generation_id uuid,
  p_status        text,
  p_error_code    text default null,
  p_error_detail  text default null
)
returns boolean
language plpgsql
as $$
declare
  won boolean;
begin
  update generations
     set status       = p_status,
         error_code   = p_error_code,
         error_detail = p_error_detail,
         confirmed_at = now(),
         completed_at = coalesce(completed_at, now())
   where id = p_generation_id
     and confirmed_at is null      -- the compare half of compare-and-set
  returning true into won;

  return coalesce(won, false);
end
$$;

comment on function confirm_generation_once is
  'Terminal transition, exactly once. Returns true to the single caller that won and '
  'false to every replay. Anything with a cost or a side effect — the ingest enqueue '
  'above all — belongs behind a true from this function, not behind an application-level '
  'read of confirmed_at, which two concurrent deliveries can both pass.';

-- ─────────────────────────────────────────────────────────────
-- 4. Replays are visible on their own
--
-- Distinct from v_unconfirmed_terminal_generations, which catches results written without
-- confirmation. This catches confirmation attempted more than once — the same secret
-- arriving twice. Neither implies the other.
-- ─────────────────────────────────────────────────────────────

create view v_replayed_callbacks as
select
  g.id,
  g.shot_id,
  g.external_job_id,
  g.status,
  g.webhook_deliveries,
  g.webhook_received_at,
  g.webhook_last_received_at,
  g.confirmed_at,
  g.webhook_last_received_at - g.webhook_received_at as spread
from generations g
where g.webhook_deliveries > 1;

comment on view v_replayed_callbacks is
  'Generations that received more than one callback. A vendor retry after a timeout is '
  'the ordinary cause and is harmless. A wide `spread` on a job that already succeeded is '
  'not ordinary: it is somebody resending a delivery they captured.';
