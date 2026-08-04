-- Migration 0026 — cost per video, as rows, with a denominator
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: neither. Nothing here is a correction to a schema that
-- contradicts itself, and nothing is a design outgrowing its first case. `cost_ledger` is
-- already exact; six subjects, an entry_kind that separates committed from actual, and a
-- constraint that refuses a charge with no subject. What was missing was a *reader*.
--
-- CLAUDE.md rule 5 calls cost-per-video the project's headline metric. It has been
-- unanswerable for the whole build, not because the rows are wrong but because turning
-- them into a per-video number requires four joins and a decision about three different
-- ways of being uncertain — which is precisely the condition under which people stop
-- asking and start assuming.
-- ─────────────────────────────────────────────────────────────
--
-- Three things this view refuses to do, each of which produces a plausible number:
--
-- 1. It will not add an estimate to a reconcile. An estimate is money committed at submit
--    before the result exists (rule 5); a reconcile is money actually spent. Summing them
--    double-counts every generation that has completed. Excluding estimates makes a video
--    that is mid-flight look free, which is worse — that is spend the account has already
--    incurred. So both are reported, in separate columns, and nothing here ever merges
--    them. The caller decides, visibly.
--
-- 2. It will not treat an unpriced row as a free one. `cost_ledger.cost_inr` is nullable
--    and the rate card ships with unverified rates whose unit cost is null on purpose. A
--    video with one unpriced call has an *unknown* cost, not a smaller one. `total_inr`
--    goes null the moment any contributing row is null, and `unpriced_rows` says how many.
--    Summing nulls as zero would understate the headline metric in the flattering
--    direction, silently, for ever.
--
-- 3. It will not silently drop spend that belongs to no video. Every charge reachable from
--    a script is attributed here; `v_cost_unattributed` is the complement, and the two are
--    exhaustive by construction. A cost-per-video figure is only honest if you can also
--    say what it excludes — a Studio session that decided not to make anything, a refused
--    draft charged to a concept, a generation whose shot was deleted. Those are real money
--    and they are not part of any video's cost.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- Every ledger row, resolved to the script it belongs to
--
-- Six subjects reach a script by four different paths, and one of them (channel) does not
-- reach one at all. Doing this once, here, is what stops each consumer inventing its own
-- join and getting a different total.
-- ─────────────────────────────────────────────────────────────

create view v_cost_attributed as
select
  cl.id,
  coalesce(
    cl.script_id,                    -- drafting, shotlist, metadata, and settled Studio spend
    s.script_id,                     -- a generation, via its shot
    r.script_id                      -- a render
  ) as script_id,
  case
    when cl.render_id     is not null then 'render'
    when cl.generation_id is not null then coalesce(g.kind, 'generation')
    when cl.script_id     is not null and cl.studio_session_id is not null then 'studio'
    when cl.script_id     is not null then 'llm'
    when cl.studio_session_id is not null then 'studio'
    when cl.concept_id    is not null then 'concept'
    when cl.channel_id    is not null then 'channel'
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
left join generations g on g.id = cl.generation_id
left join shots       s on s.id = g.shot_id
left join renders     r on r.id = cl.render_id;

comment on view v_cost_attributed is
  'Every cost_ledger row with the script it belongs to resolved once, by the four paths '
  'that reach one. script_id is null for spend that belongs to no video — that is a real '
  'category, not a join failure, and v_cost_unattributed is where it goes.';

-- ─────────────────────────────────────────────────────────────
-- Cost per video
--
-- One row per script that has either incurred spend or been rendered. Not one row per
-- render: a script with two hook variants is one video's worth of drafting, shots and
-- voice, and the variants share all of it. `renders` says how many came out.
-- ─────────────────────────────────────────────────────────────

create view v_video_cost as
with attributed as (
  select * from v_cost_attributed where script_id is not null
),
-- A reconcile supersedes the estimate for the same subject. Rather than model that per
-- subject, take it per script and per component: if anything settled, the open estimates
-- for that component are the ones still outstanding. This is the honest granularity —
-- the ledger's own idempotency key is (generation_id, entry_kind), so an estimate and its
-- reconcile are two rows about one charge and nothing in the schema pairs them further.
settled as (
  select
    script_id,
    sum(cost_inr)                          as settled_inr,
    count(*) filter (where cost_inr is null) as unpriced,
    count(*)                               as rows_n
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1
),
open_est as (
  select
    a.script_id,
    sum(a.cost_inr)                          as open_inr,
    count(*) filter (where a.cost_inr is null) as unpriced,
    count(*)                                 as rows_n
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
    sum(cost_inr) as inr,
    count(*) filter (where cost_inr is null) as unpriced
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1, 2
),
components as (
  select
    script_id,
    jsonb_object_agg(
      component,
      jsonb_build_object('inr', inr, 'unpriced', unpriced)
    ) as component_inr
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

  -- Money actually spent. Null when any contributing row is unpriced — an unknown cost is
  -- not a smaller cost, and this is the column a headline number would be built on.
  case when coalesce(st.unpriced, 0) > 0 then null else st.settled_inr end as settled_inr,
  coalesce(st.unpriced, 0)                 as unpriced_settled_rows,

  -- Money committed at submit and not yet reconciled. Reported beside the settled figure,
  -- never added into it: adding them double-counts anything that has completed.
  case when coalesce(oe.unpriced, 0) > 0 then null else oe.open_inr end as open_estimate_inr,
  coalesce(oe.unpriced, 0)                 as unpriced_open_rows,

  coalesce(ar.rows_n, 0)                   as ledger_rows,
  cm.component_inr,

  coalesce(rd.renders, 0)                  as renders,
  coalesce(rd.renders_ready, 0)            as renders_ready,
  coalesce(pb.live, 0)                     as publications_live,

  -- The denominator question, as a column rather than as a caller's guess. A video counts
  -- towards cost-per-video only when it exists (something rendered) and its cost is fully
  -- known. Everything else is named and excluded rather than averaged in.
  case
    when coalesce(rd.renders_ready, 0) = 0 then 'not_rendered'
    when coalesce(st.unpriced, 0) > 0      then 'unpriced'
    when st.settled_inr is null            then 'nothing_settled'
    else 'countable'
  end                                      as denominator_state
from scripts sc
join concepts c on c.id = sc.concept_id
left join settled   st on st.script_id = sc.id
left join open_est  oe on oe.script_id = sc.id
left join all_rows  ar on ar.script_id = sc.id
left join components cm on cm.script_id = sc.id
left join rendered  rd on rd.script_id = sc.id
left join published pb on pb.script_id = sc.id
where st.script_id is not null
   or oe.script_id is not null
   or rd.script_id is not null;

comment on view v_video_cost is
  'Cost per video, one row per script, with settled and committed spend kept apart and '
  'an unknown cost represented as null rather than as zero. denominator_state says '
  'whether the row may be averaged into a headline figure and, when not, why — so the '
  'excluded rows stay visible instead of being dropped by a where clause upstream.';

-- ─────────────────────────────────────────────────────────────
-- The complement
--
-- Without this the per-video totals look complete and are not. Spend lands here when the
-- thing it was about never became a video: a Studio session that decided not to make
-- anything, a draft the model refused, a stage-2 batch charged to the channel.
-- ─────────────────────────────────────────────────────────────

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
