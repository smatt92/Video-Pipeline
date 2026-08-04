-- Migration 0025 — recipe performance, derived rather than counted
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR.
--
-- `prompts` carries `win_rate`, `times_compiled`, `times_shipped` and `last_compiled_at`.
-- Every one of them is **only ever selected**. `grep` finds three readers and zero writers;
-- `win_rate` is set to null at insert and never updated again.
--
-- That is not a missing feature. `src/lib/shots/compile.ts` *weights recipe selection by
-- win_rate* — so production picks recipes using a number that is permanently null, and the
-- tier ordering it documents at length cannot ever have had an effect.
--
-- The consequence is the one ARCHITECTURE §0.1 calls the whole point of the product:
--
--   > The durable asset is the *loop* ... Nobody can copy your accumulated
--   > hook-performance data. Everybody can copy your model choice.
--
-- The loop accumulates nothing. Videos get made, recipes get used, and the system never
-- gets better — because the evidence that would make it better is never written. Everything
-- is green: the same inert-chain shape as 0024, one level up, on the learning loop rather
-- than the production one.
--
-- ─────────────────────────────────────────────────────────────
-- Derived, not counted, and that is the substantive decision
--
-- The obvious repair is to increment the counters where they should have been incremented.
-- That trades a column nothing writes for a column that drifts: stage 4 is replayable and
-- re-compiles the same shot, a re-run would double-count, and a corrected shotlist would
-- leave the old recipe's tally permanently high. A counter that is wrong in a way nobody can
-- detect is worse than one that is obviously zero.
--
-- The rows already hold the answer. `shots.prompt_id` says which recipe compiled a shot,
-- and the path from a shot to a passed review is a join. Deriving costs a view and cannot
-- drift, so the columns are dropped rather than kept alongside it — two sources for one
-- fact is the failure CLAUDE.md names, and keeping a denormalised copy "for speed" on a
-- table of tens of rows would be that failure for no gain.
-- ─────────────────────────────────────────────────────────────

create view v_recipe_performance as
with compiled as (
  select s.prompt_id, count(*) as n, max(s.created_at) as last_at
    from shots s
   where s.prompt_id is not null
   group by s.prompt_id
),
-- Shipped means: this shot was in a render a human passed. Not "a generation succeeded" —
-- a clip that generated cleanly and was cut for being wrong is not a win, and the whole
-- value of the number is that it reflects the editorial judgement rather than the vendor's.
shipped as (
  select s.prompt_id, count(distinct s.id) as n
    from shots s
    join renders r  on r.script_id = s.script_id
    join reviews rv on rv.render_id = r.id and rv.decision = 'pass'
   where s.prompt_id is not null
   group by s.prompt_id
)
select
  p.id                                as prompt_id,
  p.name,
  p.driver,
  p.model,
  p.is_active,
  coalesce(c.n, 0)                    as times_compiled,
  coalesce(sh.n, 0)                   as times_shipped,
  c.last_at                           as last_compiled_at,
  -- Null, never zero, until the recipe has been used. Zero is a claim that it was tried and
  -- never shipped; null is the absence of evidence, and the two must not sort together.
  case
    when coalesce(c.n, 0) = 0 then null
    else round(coalesce(sh.n, 0)::numeric / c.n, 3)
  end                                 as win_rate
from prompts p
left join compiled c  on c.prompt_id = p.id
left join shipped  sh on sh.prompt_id = p.id;

comment on view v_recipe_performance is
  'What a recipe has actually earned: how many shots it compiled, how many of those reached '
  'a render a human passed, and the ratio. Derived from rows rather than counted into '
  'columns, because stage 4 is replayable and a counter would double on every re-run. '
  'win_rate is null rather than zero on an unused recipe — absence of evidence is not '
  'evidence of failure, and sorting them together would retire recipes nobody has tried.';

-- ─────────────────────────────────────────────────────────────
-- The second instrument that was reporting a real number about nothing
--
-- `v_recipe_coverage` (0011) measures templating risk: what share of a shot kind's compiles
-- went to its single busiest recipe, where 1.0 means one recipe is doing all the work. It
-- summed `times_compiled`.
--
-- So it has always reported `compiles = 0` and `top_recipe_share = null` for every kind —
-- an alarm wired to a sensor nobody connected. Rebuilt on the derived view, it starts
-- measuring the thing it was written to measure.
-- ─────────────────────────────────────────────────────────────

drop view v_recipe_coverage;

create view v_recipe_coverage as
select
  k.shot_kind,
  count(p.id) filter (where p.is_active)                       as active_recipes,
  count(p.id)                                                  as total_recipes,
  coalesce(sum(rp.times_compiled) filter (where p.is_active), 0) as compiles,
  coalesce(sum(rp.times_shipped)  filter (where p.is_active), 0) as ships,
  -- What share of this kind's compiles went to its single busiest recipe. 1.0 means one
  -- recipe is doing all the work for this kind, which is the templating risk stated as a
  -- number.
  case
    when coalesce(sum(rp.times_compiled) filter (where p.is_active), 0) = 0 then null
    else round(
      max(rp.times_compiled) filter (where p.is_active)::numeric
      / sum(rp.times_compiled) filter (where p.is_active), 3)
  end                                                          as top_recipe_share
from (select unnest(array[
        'establishing', 'subject_medium', 'detail_macro', 'action_insert',
        'environment_move', 'abstract', 'graphic_plate'
      ]) as shot_kind) k
left join prompts p on k.shot_kind = any(p.tags)
left join v_recipe_performance rp on rp.prompt_id = p.id
group by k.shot_kind
order by count(p.id) filter (where p.is_active), k.shot_kind;

comment on view v_recipe_coverage is
  'Recipes per shot kind and how concentrated their use is. One active recipe is a warning '
  'rather than a tick: every shot of that kind gets the same camera, and repeated identical '
  'camera moves are legible to a policy reviewer. Reads v_recipe_performance — it previously '
  'summed columns nothing wrote, so it reported zero compiles for every kind since 0011.';

-- The columns this replaces. Dropped rather than left beside the view: nothing ever wrote
-- them, and a stale duplicate of a fact is how the next person spends an afternoon
-- discovering their change had no effect.
alter table prompts
  drop column win_rate,
  drop column times_compiled,
  drop column times_shipped,
  drop column last_compiled_at;

notify pgrst, 'reload schema';
