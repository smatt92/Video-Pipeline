-- Migration 0032 — a cost row says how its number was arrived at
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION. `entry_kind` was exact for the case it was built for
-- and a second case shows what it cannot say.
--
-- `entry_kind` answers *when* — estimate at submit, reconcile on completion, refund after.
-- It was doing double duty as an answer to *how the number was arrived at*, because until
-- now those two questions had the same answer: an estimate came from the rate card and a
-- reconcile came from the vendor.
--
-- They come apart the moment a completed generation needs to be countable. Rule 5's
-- reconcile half has never existed — nothing writes a reconcile against a `generation_id` —
-- so a video that generates stays outstanding for ever and can never enter cost per video.
-- The tempting fix is to write a reconcile equal to the estimate on success. **That is
-- refused here**: it would put a fabricated figure in the ledger everything derives from,
-- indistinguishable from a measured one, and the whole value of this table is that its rows
-- can be checked.
--
-- So the row says how it was priced, and the view counts accordingly. A completed
-- generation is countable, from its estimate, labelled as an estimate everywhere it
-- surfaces. The real reconcile lands when a credit-balance delta is observable — the same
-- mechanism as the rate card, where a verified number comes from watching a balance move
-- rather than from reading a response body.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column cost_source text not null default 'rate_card'
    check (cost_source in ('rate_card', 'measured'));

comment on column cost_ledger.cost_source is
  'How this row''s figure was arrived at, which is a different question from entry_kind''s '
  '*when*. rate_card = quantity times a unit rate; the quantity may be exact (tokens, '
  'characters) and the price is still ours rather than the vendor''s. measured = the vendor '
  'told us, or a credit balance was observed to move by this much. Every row today is '
  'rate_card, and a screen that shows a total must say so.';

-- ─────────────────────────────────────────────────────────────
-- Incurred, and why it is not the same as settled
--
-- Money the account has actually parted with. A reconcile or a refund always qualifies. An
-- estimate qualifies once its generation reaches a terminal state — the call happened and
-- was billed, whatever we later learn about the exact figure. An estimate on a generation
-- still in flight does not: it is committed, and the vendor may yet refuse it for free.
--
-- This is the distinction that lets a completed video be counted without inventing a
-- reconcile for it.
-- ─────────────────────────────────────────────────────────────

drop view v_cost_unattributed;
drop view v_video_cost;
drop view v_cost_attributed;

create view v_cost_attributed as
select
  cl.id,
  coalesce(cl.script_id, s.script_id, r.script_id, ss.script_id) as script_id,
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
  cl.cost_source,

  -- Money actually parted with. See the note above.
  case
    when cl.entry_kind in ('reconcile', 'refund') then true
    when cl.generation_id is null then true
    else g.status in ('succeeded', 'failed', 'cancelled', 'timeout')
  end as incurred,

  cl.cost_inr,
  cl.cost_usd,
  cl.driver,
  cl.unit,
  cl.occurred_at,
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
  'Every cost_ledger row with the script it belongs to resolved once, plus whether the money '
  'has actually been parted with. `incurred` is false only for an estimate whose generation '
  'is still in flight — that one is committed and the vendor may yet refuse it for free.';

create view v_video_cost as
with attributed as (
  select * from v_cost_attributed where script_id is not null
),
incurred as (
  select
    script_id,
    sum(cost_inr) filter (where cost_source = 'measured')  as measured_inr,
    sum(cost_inr) filter (where cost_source = 'rate_card') as estimated_inr,
    count(*) filter (where cost_source = 'measured')       as measured_rows,
    count(*) filter (where cost_inr is null)               as unpriced,
    count(*)                                               as rows_n
  from attributed
  where incurred
    -- A superseded estimate must not be added to the reconcile that replaced it.
    and not (
      entry_kind = 'estimate'
      and exists (
        select 1 from cost_ledger r
        where r.entry_kind = 'reconcile'
          and r.generation_id     is not distinct from attributed.generation_id
          and r.render_id         is not distinct from attributed.render_id
          and r.script_id         is not distinct from attributed.subject_script_id
          and r.studio_session_id is not distinct from attributed.studio_session_id
          and r.concept_id        is not distinct from attributed.concept_id
          and r.channel_id        is not distinct from attributed.channel_id
          and r.unit              is not distinct from attributed.unit
      )
    )
  group by 1
),
committed as (
  select
    script_id,
    sum(cost_inr)                            as committed_inr,
    count(*) filter (where cost_inr is null) as unpriced,
    count(*)                                 as rows_n
  from attributed
  where not incurred
    -- An estimate whose reconcile has already arrived is neither incurred-as-an-estimate
    -- nor still committed: it has been superseded. Without this it would be counted as
    -- outstanding for ever beside the reconcile that replaced it, and a caller adding the
    -- two columns would bill the clip twice.
    and not exists (
      select 1 from cost_ledger r
      where r.entry_kind = 'reconcile'
        and r.generation_id     is not distinct from attributed.generation_id
        and r.render_id         is not distinct from attributed.render_id
        and r.script_id         is not distinct from attributed.subject_script_id
        and r.studio_session_id is not distinct from attributed.studio_session_id
        and r.concept_id        is not distinct from attributed.concept_id
        and r.channel_id        is not distinct from attributed.channel_id
        and r.unit              is not distinct from attributed.unit
    )
  group by 1
),
all_rows as (
  select script_id, count(*) as rows_n from attributed group by 1
),
by_component as (
  select
    script_id, component,
    sum(cost_inr) filter (where incurred)                  as inr,
    count(*) filter (where cost_inr is null)               as unpriced
  from attributed
  group by 1, 2
),
components as (
  select script_id,
         jsonb_object_agg(component, jsonb_build_object('inr', inr, 'unpriced', unpriced)) as component_inr
  from by_component group by 1
),
rendered as (
  select script_id, count(*) as renders, count(*) filter (where status = 'ready') as renders_ready
  from renders group by 1
),
published as (
  select r.script_id, count(*) filter (where p.status = 'live') as live
  from publications p join renders r on r.id = p.render_id group by 1
)
select
  sc.id                                    as script_id,
  sc.concept_id,
  c.channel_id,
  c.title,
  sc.created_at,

  -- Kept apart on purpose. A caller may add them; nothing here does it for them, and the
  -- screen has to say which part of a total was priced from our own rate card.
  case when coalesce(ic.unpriced, 0) > 0 then null else ic.measured_inr  end as measured_inr,
  case when coalesce(ic.unpriced, 0) > 0 then null else ic.estimated_inr end as estimated_inr,
  coalesce(ic.measured_rows, 0)            as measured_rows,
  coalesce(ic.unpriced, 0)                 as unpriced_incurred_rows,

  case when coalesce(cm2.unpriced, 0) > 0 then null else cm2.committed_inr end as committed_inr,
  coalesce(cm2.unpriced, 0)                as unpriced_committed_rows,

  coalesce(ar.rows_n, 0)                   as ledger_rows,
  cm.component_inr,

  coalesce(rd.renders, 0)                  as renders,
  coalesce(rd.renders_ready, 0)            as renders_ready,
  coalesce(pb.live, 0)                     as publications_live,

  -- Four outcomes now, because "countable" splits by how the figure was arrived at. A
  -- screen must be able to label an average as estimated rather than presenting it as a
  -- measurement, and a caller that cannot tell them apart will add them.
  case
    when coalesce(rd.renders_ready, 0) = 0                     then 'not_rendered'
    when coalesce(ic.unpriced, 0) > 0                          then 'unpriced'
    when ic.script_id is null                                  then 'nothing_incurred'
    when coalesce(ic.estimated_inr, 0) = 0
         and coalesce(ic.measured_inr, 0) <> 0                 then 'countable_measured'
    else 'countable_estimated'
  end                                      as denominator_state
from scripts sc
join concepts c on c.id = sc.concept_id
left join incurred   ic  on ic.script_id  = sc.id
left join committed  cm2 on cm2.script_id = sc.id
left join all_rows   ar  on ar.script_id  = sc.id
left join components cm  on cm.script_id  = sc.id
left join rendered   rd  on rd.script_id  = sc.id
left join published  pb  on pb.script_id  = sc.id
where ic.script_id is not null
   or cm2.script_id is not null
   or rd.script_id is not null;

comment on view v_video_cost is
  'Cost per video, one row per script, with measured and rate-card figures kept apart and an '
  'unknown cost null rather than zero. A completed generation is countable from its estimate '
  '— denominator_state says countable_estimated — because inventing a reconcile equal to the '
  'estimate would put a fabricated figure in the table everything derives from. The real '
  'reconcile lands when a credit-balance delta is observable.';

create view v_cost_unattributed as
select
  component, entry_kind,
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
  'exhaustive with it.';

notify pgrst, 'reload schema';
