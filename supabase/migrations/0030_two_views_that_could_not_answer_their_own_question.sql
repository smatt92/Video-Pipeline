-- Migration 0030 — two views that could not answer their own question
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR for `v_cost_by_stage`, EVOLUTION for
-- `v_script_vo_status`.
--
-- Both had no reader, which is why neither was ever asked to answer anything. Giving them
-- consumers meant reading them properly for the first time, and `v_cost_by_stage` turned
-- out to contradict its own name.
-- ─────────────────────────────────────────────────────────────
--
-- ── v_cost_by_stage could not see the most expensive stage ────────────────────
--
-- It filtered `where stage is not null`, and stage 5's ledger rows set no stage at all.
-- The `stage: 'still'` in `submit.ts` is a field of the *vendor payload* naming which half
-- of the two-call chain is being submitted; it never reached the ledger. So every figure
-- this view produced was a breakdown of the LLM stages presented as a breakdown of the
-- pipeline — and video generation, the single most expensive thing here, was structurally
-- invisible to the view named for it. Stage 5 now sets `stage = '05-generate'`.
--
-- Three further corrections, each one of this project's standing rules:
--
--   · `sum(cost_inr)` skips nulls, so an unpriced row silently vanished from its stage's
--     total. A stage with one unpriced call had an *unknown* cost, not a smaller one.
--   · estimate and reconcile were added together, double-counting every generation that
--     has completed. They are separate columns and nothing here merges them.
--   · a bare total per stage looks identical after one video and after a hundred. The
--     denominator is `scripts` — how many distinct scripts the stage charged — and
--     `inr_per_script` is null when that is zero.
--
-- What the view deliberately does NOT do is list stages that have never run. That needs
-- the stage vocabulary, which lives in `PipelineStage` in `src/lib/cost/llm.ts`, and a
-- third representation of it in SQL is how the shot-kind vocabulary would have gone wrong.
-- SQL reports facts about rows; the reader owns the vocabulary and fills in the never-ran
-- stages — which is the absent-versus-zero half of this screen and the reader's real job.
--
-- ── v_script_vo_status counted things instead of saying where it stopped ──────
--
-- `takes`, `total_duration_s`, `characters_billed`, `shots_timed`. Every one a number that
-- grows, none of them an answer to the question the voice stage actually raises, which is
-- *where does the chain stop*. `coalesce(sum(...), 0)` made a script with no takes report
-- 0 seconds of speech rather than no measurement, and `shots` versus `shots_timed` — the
-- pair that made the whole 03 → 04 → 05 chain provably inert for a week — was left for the
-- reader to compare.
-- ─────────────────────────────────────────────────────────────

drop view v_cost_by_stage;

create view v_cost_by_stage as
select
  cl.stage,
  count(*)                                                   as entries,
  count(distinct coalesce(cl.script_id, s.script_id))         as scripts,

  -- Null when any contributing row is unpriced: an unknown cost is not a smaller one.
  case
    when count(*) filter (
      where cl.entry_kind in ('reconcile','refund') and cl.cost_inr is null
    ) > 0 then null
    else sum(cl.cost_inr) filter (where cl.entry_kind in ('reconcile','refund'))
  end                                                        as settled_inr,

  case
    when count(*) filter (where cl.entry_kind = 'estimate' and cl.cost_inr is null) > 0
      then null
    else sum(cl.cost_inr) filter (where cl.entry_kind = 'estimate')
  end                                                        as open_estimate_inr,

  count(*) filter (where cl.cost_inr is null)                as unpriced_rows,

  -- The denominator, attached. A total per stage cannot distinguish a hundred cheap videos
  -- from one ruinous one; this can.
  case
    when count(distinct coalesce(cl.script_id, s.script_id)) = 0 then null
    when count(*) filter (
      where cl.entry_kind in ('reconcile','refund') and cl.cost_inr is null
    ) > 0 then null
    else round(
      coalesce(sum(cl.cost_inr) filter (where cl.entry_kind in ('reconcile','refund')), 0)
        / count(distinct coalesce(cl.script_id, s.script_id)),
      4
    )
  end                                                        as inr_per_script,

  min(cl.occurred_at)                                        as first_at,
  max(cl.occurred_at)                                        as last_at
from cost_ledger cl
left join generations g on g.id = cl.generation_id
left join shots       s on s.id = g.shot_id
where cl.stage is not null
group by cl.stage;

comment on view v_cost_by_stage is
  'Spend per pipeline stage, with settled and committed kept apart, an unpriced row making '
  'the stage total null rather than smaller, and the number of scripts the stage charged as '
  'a denominator. Only stages with rows appear — a stage that has never run is absent here '
  'and the reader adds it, because the stage vocabulary belongs to PipelineStage and must '
  'not exist a third time in SQL.';

-- ─────────────────────────────────────────────────────────────

drop view v_script_vo_status;

create view v_script_vo_status as
with takes as (
  select
    vt.script_id,
    count(*)                                                   as takes,
    count(*) filter (where vt.request_id is null)               as unstitched,
    -- Null, not 0. A script with no takes has no measured speech; 0 would claim it has
    -- some and that it is silent.
    sum(vt.duration_s)                                          as total_duration_s,
    sum(vt.characters_billed)                                   as characters_billed,
    sum(vt.cost_inr)                                            as cost_inr,
    count(*) filter (where vt.duration_s is null)               as unmeasured_takes,
    count(*) filter (where vt.characters_billed is null)         as unbilled_takes
  from vo_takes vt
  group by 1
),
shot_counts as (
  select
    script_id,
    count(*)                                                        as shots,
    count(*) filter (where duration_source = 'derived_from_vo')      as shots_timed
  from shots
  group by 1
)
select
  sc.id                                     as script_id,
  sc.concept_id,
  length(sc.vo_text)                        as vo_chars,
  coalesce(t.takes, 0)                      as takes,
  coalesce(t.unstitched, 0)                 as unstitched_takes,
  t.total_duration_s,
  t.characters_billed,
  t.cost_inr,
  coalesce(t.unmeasured_takes, 0)           as unmeasured_takes,
  coalesce(t.unbilled_takes, 0)             as unbilled_takes,
  coalesce(shc.shots, 0)                    as shots,
  coalesce(shc.shots_timed, 0)              as shots_timed,

  -- Where the chain stops, as a state rather than four numbers to compare.
  --
  -- `shots_timed` versus `shots` is the pair that made 03 → 04 → 05 provably inert for a
  -- week with fifteen harnesses green: stage 5 refuses any shot whose duration is still an
  -- estimate, and only stage 6 flips it. Leaving that comparison to whoever reads the view
  -- is what "nothing came out and no error anywhere" looks like.
  case
    when coalesce(shc.shots, 0) = 0                    then 'no_shots'
    when coalesce(t.takes, 0) = 0                      then 'not_started'
    when coalesce(t.unstitched, 0) > 0                 then 'takes_unstitched'
    when coalesce(shc.shots_timed, 0) = 0              then 'stitched_untimed'
    when shc.shots_timed < shc.shots                   then 'partially_timed'
    else 'timed'
  end                                       as vo_state
from scripts sc
left join takes       t   on t.script_id  = sc.id
left join shot_counts shc on shc.script_id = sc.id;

comment on view v_script_vo_status is
  'Where the voice chain stops, per script. vo_state is the answer; the counts are the '
  'evidence for it. total_duration_s and characters_billed are null rather than 0 when '
  'there are no takes — no measured speech is not silence. shots_timed versus shots is '
  'computed here rather than left to the reader: that comparison is what made the '
  '03 → 04 → 05 chain inert for a week with every per-stage harness green.';

notify pgrst, 'reload schema';
