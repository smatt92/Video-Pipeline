-- Migration 0017 — a Studio session is a thing money can be spent on
--
-- Two changes, one cause. `cost_ledger` cannot record a Studio turn, and
-- `studio_sessions.cost_inr` — the number the spend cap is enforced against — is a
-- free-standing column that nothing keeps honest.
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds this is: EVOLUTION, not a specification error.
--
-- 0006 widened `cost_ledger_has_subject` from (generation, render) to include (script,
-- concept), and its own comment explains why: a refused draft is billed and produces no
-- script, so the charge needs a subject that exists whether or not the call worked. That
-- reasoning was correct and it was complete for the pipeline lane, where every paid call
-- is made *about* a concept.
--
-- The Studio lane is the second case, and it breaks the assumption rather than
-- contradicting it. Addendum 01 §1: a session materialises a `scripts` row *on first
-- generation*. Every turn before that is billed — the brief, the back-and-forth, the
-- refusals — and belongs to no concept and no script, because deciding what to make is
-- precisely the work that happens before either exists. Under the 0006 constraint those
-- charges have nowhere to go, and rule 5 becomes unenforceable for the lane whose whole
-- risk is that it "can burn a lot of tokens on one bad turn" (0003's own comment on
-- spend_cap_inr).
--
-- The addendum does not contradict itself here; it simply never says where the money
-- goes. A gap, found by building against it. Evolution.
--
-- The alternative — materialise a concept and a script at session start so the charge has
-- somewhere to land — was rejected for the same reason 0006 rejected writing a scripts
-- row for a draft that does not exist: it corrupts the originality evidence in
-- ARCHITECTURE.md §0.2 with rows for videos nobody decided to make.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column studio_session_id uuid references studio_sessions(id) on delete cascade;

comment on column cost_ledger.studio_session_id is
  'Set on Messages API spend made inside a Studio session. Set alone on every turn before '
  'the session materialises a script — which is most of them, and all of the ones on a '
  'session that decided not to make anything. Set alongside script_id afterwards, so the '
  'session total and the per-video total both stay answerable from the same rows.';

create index on cost_ledger (studio_session_id) where studio_session_id is not null;

alter table cost_ledger
  drop constraint cost_ledger_has_subject;

alter table cost_ledger
  add constraint cost_ledger_has_subject
  check (generation_id is not null or render_id is not null
         or script_id is not null or concept_id is not null
         or studio_session_id is not null);

-- ─────────────────────────────────────────────────────────────
-- 2. The number the cap is enforced against is derived, not asserted
--
-- 0003 created studio_sessions.cost_inr, input_tokens and output_tokens as plain columns.
-- Nothing stops the agent loop from writing a ledger row and failing before it updates
-- them, or updating them and failing before the ledger row — and the second case is a
-- session that has spent money the cap cannot see.
--
-- A spend cap enforced against a counter the spender maintains is not a control. So the
-- three columns become derived: a trigger recomputes them from cost_ledger, which is the
-- table rule 5 already makes authoritative. The loop now writes exactly one thing per
-- turn, and the cap reads a number it cannot have been wrong about.
--
-- This is 0016's shape reused deliberately — source of truth plus a trigger-derived
-- mirror — because it settled the same argument there and the argument has not changed.
-- ─────────────────────────────────────────────────────────────

create or replace function refresh_studio_session_spend(p_session uuid)
returns void
language sql
as $$
  update studio_sessions s
  set
    cost_inr = coalesce((
      select sum(cl.cost_inr) from cost_ledger cl
      where cl.studio_session_id = s.id and cl.entry_kind <> 'estimate'
    ), 0),
    input_tokens = coalesce((
      select sum(cl.quantity)::bigint from cost_ledger cl
      where cl.studio_session_id = s.id and cl.unit = 'input_token'
    ), 0),
    output_tokens = coalesce((
      select sum(cl.quantity)::bigint from cost_ledger cl
      where cl.studio_session_id = s.id and cl.unit = 'output_token'
    ), 0)
  where s.id = p_session;
$$;

comment on function refresh_studio_session_spend(uuid) is
  'Recomputes a session''s spend from the ledger. Estimate rows are excluded because a '
  'Messages call is priced on tokens that do not exist until it returns — Studio spend is '
  'always written as reconcile, and counting an estimate as well would double it.';

create or replace function studio_session_spend_trigger()
returns trigger
language plpgsql
as $$
begin
  -- Both sides on an UPDATE that moves a row between sessions. It should never happen;
  -- a trigger that is only correct when nothing unexpected does is not a control either.
  if tg_op in ('UPDATE', 'DELETE') and old.studio_session_id is not null then
    perform refresh_studio_session_spend(old.studio_session_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.studio_session_id is not null then
    perform refresh_studio_session_spend(new.studio_session_id);
  end if;
  return null;
end;
$$;

create trigger cost_ledger_studio_spend
after insert or update or delete on cost_ledger
for each row
execute function studio_session_spend_trigger();

-- ─────────────────────────────────────────────────────────────
-- 3. A stopped session says why it stopped
--
-- `status` already has 'capped', which records that the session ended and loses the one
-- fact a person needs: what it was that ran out. A status with no reason is the swallowed
-- exception in table form.
-- ─────────────────────────────────────────────────────────────

alter table studio_sessions
  add column stopped_at     timestamptz,
  add column stopped_reason text;

comment on column studio_sessions.stopped_reason is
  'Why the loop stopped, in a sentence. Written on the same statement as the status '
  'change, so a session can never be capped without saying against which cap and at what '
  'total.';

-- ─────────────────────────────────────────────────────────────
-- 4. Where the session's spend is read back
--
-- The cap is per session; the guardrails also name a per-day and per-month cap. All three
-- are answered from the ledger and none of them from a counter.
-- ─────────────────────────────────────────────────────────────

create view v_studio_session_spend as
select
  s.id                                        as session_id,
  s.title,
  s.status,
  s.stopped_reason,
  s.model,
  s.script_id,
  s.spend_cap_inr,
  s.cost_inr,
  s.input_tokens,
  s.output_tokens,
  jsonb_array_length(s.transcript)            as turns,
  count(cl.id)                                as ledger_rows,
  s.created_at
from studio_sessions s
left join cost_ledger cl on cl.studio_session_id = s.id
group by s.id;

comment on view v_studio_session_spend is
  'One row per session: what it cost, against what ceiling, and how many ledger rows back '
  'that figure. A session whose ledger_rows is zero and whose cost_inr is not is a bug in '
  'the trigger, and this view is where it would be visible.';

notify pgrst, 'reload schema';
