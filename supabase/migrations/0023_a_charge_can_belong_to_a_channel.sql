-- Migration 0023 — a cost row whose subject is the channel
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION.
--
-- `cost_ledger_has_subject` lists five subjects — generation, render, script, concept,
-- studio session — and every one of them is an artifact that exists before the money is
-- spent. That was exact for every stage that existed when it was written.
--
-- Stage 2 is the first charge that does not fit. One call proposes five concepts; the
-- concepts do not exist when the call is billed, and when they do exist the charge belongs
-- to all five rather than to any one of them. Attributing it to the first concept would
-- misreport cost-per-concept by 5×, and attributing it after the writes would lose the
-- charge whenever a concept was refused by a constraint.
--
-- What the charge is actually *about* is the channel. So that becomes the sixth subject.
--
-- The tested-by-a-second-case shape again: the original list was right for artifacts, and
-- the second case is a charge that belongs to a set it is about to create.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column channel_id uuid references channels(id) on delete cascade;

alter table cost_ledger drop constraint if exists cost_ledger_has_subject;

alter table cost_ledger
  add constraint cost_ledger_has_subject
  check (
    generation_id is not null
    or render_id is not null
    or script_id is not null
    or concept_id is not null
    or studio_session_id is not null
    or channel_id is not null
  );

create index cost_ledger_channel_id_idx
  on cost_ledger (channel_id)
  where channel_id is not null;

comment on column cost_ledger.channel_id is
  'The subject for a charge that belongs to a set rather than to an artifact — stage 2 '
  'proposes N concepts in one call, and the concepts do not exist when the call is billed. '
  'Not a denormalised convenience field: a row with channel_id and no concept_id is a '
  'batch charge, and cost-per-concept has to divide it rather than attribute it.';

-- ─────────────────────────────────────────────────────────────
-- Cost per concept, with the batch charge divided
--
-- The view exists because the division is easy to get wrong in three different ways and
-- every one of them produces a plausible number. A stage-2 charge covers the concepts that
-- *survived validation and landed*, which is not the same as the number requested and not
-- the same as the number the model returned.
-- ─────────────────────────────────────────────────────────────

create view v_concept_cost as
with batch as (
  select
    cl.channel_id,
    date_trunc('day', cl.occurred_at) as day,
    sum(cl.cost_inr) as batch_inr
  from cost_ledger cl
  where cl.channel_id is not null
    and cl.concept_id is null
    and cl.entry_kind <> 'estimate'
  group by 1, 2
),
landed as (
  select
    c.channel_id,
    date_trunc('day', c.created_at) as day,
    count(*) as n
  from concepts c
  group by 1, 2
)
select
  b.channel_id,
  b.day::date as period,
  b.batch_inr,
  coalesce(l.n, 0) as concepts_landed,
  case
    when coalesce(l.n, 0) = 0 then null
    else round(b.batch_inr / l.n, 4)
  end as inr_per_concept
from batch b
left join landed l on l.channel_id = b.channel_id and l.day = b.day;

comment on view v_concept_cost is
  'Stage 2 spend divided by the concepts that actually landed that day. Null per-concept '
  'when nothing landed, which is a real outcome — a batch can be paid for and rejected '
  'wholesale in validation — and must not read as zero.';

notify pgrst, 'reload schema';
