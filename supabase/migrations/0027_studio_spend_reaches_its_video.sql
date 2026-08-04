-- Migration 0027 — Studio spend reaches the video it produced
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR, and mine, from three days ago.
--
-- 0017's comment on `cost_ledger.studio_session_id` says the column is "set alongside
-- script_id afterwards, so the session total and the per-video total both stay answerable
-- from the same rows." That sentence describes a mechanism the schema on the same page
-- forbids: `cost_ledger_script_stage_entry_key` is unique on
-- `(script_id, coalesce(stage,''), entry_kind, unit)` where script_id is not null, and
-- every Studio turn carries `stage = 'studio'`. The second turn on a materialised session
-- would collide with the first and be swallowed as a retry — money moving with no row,
-- which is the exact failure 0017 was written to prevent.
--
-- So the row cannot carry both. 0026 then inherited the mistake in the other direction: it
-- resolved a script from four paths and none of them was a Studio session, so a session
-- that *did* materialise a script had its whole spend land in `v_cost_unattributed` for
-- ever. Both halves of the same wrong assumption.
--
-- The attribution belongs in the view, where it costs nothing and collides with nothing.
-- `studio_sessions.script_id` already exists and is already materialised on first
-- generation; this reads it.
-- ─────────────────────────────────────────────────────────────

drop view v_cost_unattributed;
drop view v_video_cost;
drop view v_cost_attributed;

create view v_cost_attributed as
select
  cl.id,
  coalesce(
    cl.script_id,                    -- drafting, shotlist, metadata
    s.script_id,                     -- a generation, via its shot
    r.script_id,                     -- a render
    ss.script_id                     -- a Studio session that went on to materialise one
  ) as script_id,
  case
    when cl.render_id         is not null then 'render'
    when cl.generation_id     is not null then coalesce(g.kind, 'generation')
    when cl.studio_session_id is not null then 'studio'
    when cl.script_id         is not null then 'llm'
    when cl.concept_id        is not null then 'concept'
    when cl.channel_id        is not null then 'channel'
    else 'unknown'
  end as component,
  cl.entry_kind,
  cl.cost_inr,
  cl.cost_usd,
  cl.driver,
  cl.unit,
  cl.occurred_at,
  -- The subject columns, carried through so an estimate can be matched to its reconcile.
  -- Nothing in the schema pairs those two rows: the idempotency key is
  -- (generation_id, entry_kind), which makes each unique but does not link them.
  cl.generation_id,
  cl.render_id,
  cl.script_id     as subject_script_id,
  cl.studio_session_id,
  cl.concept_id,
  cl.channel_id
from cost_ledger cl
left join generations     g  on g.id  = cl.generation_id
left join shots           s  on s.id  = g.shot_id
left join renders         r  on r.id  = cl.render_id
left join studio_sessions ss on ss.id = cl.studio_session_id;

comment on view v_cost_attributed is
  'Every cost_ledger row with the script it belongs to resolved once, by the four paths '
  'that reach one — including a Studio session, whose script_id is materialised on first '
  'generation and is the only place that link exists. A charge cannot carry both '
  'studio_session_id and script_id: the (script_id, stage, entry_kind, unit) unique index '
  'would collide on the second turn of a session and swallow it as a retry. script_id null '
  'here is spend that belongs to no video, which is a real category rather than a join '
  'failure, and v_cost_unattributed is where it goes.';

-- ─────────────────────────────────────────────────────────────
-- Unchanged from 0026 below this line, recreated because the views were dropped.
-- ─────────────────────────────────────────────────────────────

create view v_video_cost as
with attributed as (
  select * from v_cost_attributed where script_id is not null
),
settled as (
  select
    script_id,
    sum(cost_inr)                            as settled_inr,
    count(*) filter (where cost_inr is null) as unpriced,
    count(*)                                 as rows_n
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1
),
open_est as (
  select
    a.script_id,
    sum(a.cost_inr)                            as open_inr,
    count(*) filter (where a.cost_inr is null) as unpriced,
    count(*)                                   as rows_n
  from attributed a
  where a.entry_kind = 'estimate'
    -- Outstanding only. A charge that has reconciled is no longer committed-and-unknown;
    -- counting it in both columns would double it in any caller that adds them. Matched on
    -- the whole subject plus unit, because one LLM call is billed at two rates and writes
    -- two rows — `is not distinct from` so a null subject matches a null subject rather
    -- than matching nothing.
    and not exists (
      select 1 from cost_ledger r
      where r.entry_kind = 'reconcile'
        and r.generation_id     is not distinct from a.generation_id
        and r.render_id         is not distinct from a.render_id
        and r.script_id         is not distinct from a.subject_script_id
        and r.studio_session_id is not distinct from a.studio_session_id
        and r.concept_id        is not distinct from a.concept_id
        and r.channel_id        is not distinct from a.channel_id
        and r.unit              is not distinct from a.unit
    )
  group by 1
),
-- Every attributed row, counted regardless of entry kind. Deliberately not
-- settled.rows_n + open_est.rows_n: an estimate superseded by its reconcile is correctly
-- excluded from both figures, so that sum under-counts by one row per completed
-- generation. This column is what makes v_video_cost and v_cost_unattributed exhaustive
-- over cost_ledger, which is the only assertion that can catch a quietly narrowed
-- denominator — the way a headline metric actually goes wrong.
all_rows as (
  select script_id, count(*) as rows_n from attributed group by 1
),
by_component as (
  select
    script_id,
    component,
    sum(cost_inr)                            as inr,
    count(*) filter (where cost_inr is null) as unpriced
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1, 2
),
components as (
  select
    script_id,
    jsonb_object_agg(component, jsonb_build_object('inr', inr, 'unpriced', unpriced)) as component_inr
  from by_component
  group by 1
),
rendered as (
  select script_id, count(*) as renders, count(*) filter (where status = 'ready') as renders_ready
  from renders group by 1
),
published as (
  select r.script_id, count(*) filter (where p.status = 'live') as live
  from publications p join renders r on r.id = p.render_id
  group by 1
)
select
  sc.id                                    as script_id,
  sc.concept_id,
  c.channel_id,
  c.title,
  sc.created_at,

  case when coalesce(st.unpriced, 0) > 0 then null else st.settled_inr end as settled_inr,
  coalesce(st.unpriced, 0)                 as unpriced_settled_rows,

  case when coalesce(oe.unpriced, 0) > 0 then null else oe.open_inr end as open_estimate_inr,
  coalesce(oe.unpriced, 0)                 as unpriced_open_rows,

  coalesce(ar.rows_n, 0)                   as ledger_rows,
  cm.component_inr,

  coalesce(rd.renders, 0)                  as renders,
  coalesce(rd.renders_ready, 0)            as renders_ready,
  coalesce(pb.live, 0)                     as publications_live,

  case
    when coalesce(rd.renders_ready, 0) = 0 then 'not_rendered'
    when coalesce(st.unpriced, 0) > 0      then 'unpriced'
    when st.settled_inr is null            then 'nothing_settled'
    else 'countable'
  end                                      as denominator_state
from scripts sc
join concepts c on c.id = sc.concept_id
left join settled    st on st.script_id = sc.id
left join open_est   oe on oe.script_id = sc.id
left join all_rows   ar on ar.script_id = sc.id
left join components cm on cm.script_id = sc.id
left join rendered   rd on rd.script_id = sc.id
left join published  pb on pb.script_id = sc.id
where st.script_id is not null
   or oe.script_id is not null
   or rd.script_id is not null;

comment on view v_video_cost is
  'Cost per video, one row per script, with settled and committed spend kept apart and '
  'an unknown cost represented as null rather than as zero. denominator_state says '
  'whether the row may be averaged into a headline figure and, when not, why — so the '
  'excluded rows stay visible instead of being dropped by a where clause upstream.';

create view v_cost_unattributed as
select
  component,
  entry_kind,
  count(*)                                 as rows_n,
  sum(cost_inr)                            as inr,
  count(*) filter (where cost_inr is null) as unpriced,
  min(occurred_at)                         as first_at,
  max(occurred_at)                         as last_at
from v_cost_attributed
where script_id is null
group by 1, 2;

comment on view v_cost_unattributed is
  'Spend that belongs to no video, by component. The complement of v_video_cost and '
  'exhaustive with it: a cost-per-video figure is only honest alongside what it excludes.';

notify pgrst, 'reload schema';
