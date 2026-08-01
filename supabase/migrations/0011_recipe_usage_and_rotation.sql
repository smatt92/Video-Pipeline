-- Migration 0011 — recipe reuse is a template risk, and nothing was counting it
--
-- One recipe compiled 3 of 7 shots on the first real shotlist and would keep doing that on
-- every script forever. `structure_hash` protects script variety; nothing protected visual
-- variety, and repeated identical camera moves are more legible to a policy reviewer than
-- beat structure is — a reviewer watches, they do not diff.
--
-- Both findings here are the evolution kind. `prompts` was designed as a recipe store, and
-- a store does not need to know how often it is drawn from; it needs to the moment
-- selection has a choice and that choice compounds across hundreds of videos.

-- ─────────────────────────────────────────────────────────────
-- 1. Count the draws
--
-- Two counters, not one, because they answer different questions.
--
--   times_compiled  how often selection picked it. Rises whether or not the clip was
--                   any good, so it measures *exposure* — the template risk.
--   times_shipped   how often a clip from it reached a published render. Rises only on
--                   success, so it measures *value*.
--
-- Their ratio is what win_rate will eventually be computed from, which is why both are
-- wired now and both stay at zero until real runs move them. A single "uses" column would
-- have conflated the risk with the reward and been useless for either.
-- ─────────────────────────────────────────────────────────────

alter table prompts
  add column times_compiled   int not null default 0,
  add column times_shipped    int not null default 0,
  add column last_compiled_at timestamptz;

comment on column prompts.times_compiled is
  'How many shots selection has compiled from this recipe. Exposure, not quality — it '
  'rises on clips nobody watched. High and concentrated is the templating risk.';

comment on column prompts.times_shipped is
  'How many published renders contain a clip from this recipe. Incremented at stage 10, '
  'which does not exist yet, so it is zero everywhere and honestly so.';

comment on column prompts.last_compiled_at is
  'Drives least-recently-used rotation within a rank tier. Nothing else reads it.';

/*
 * Recording a draw.
 *
 * A function rather than an UPDATE at the call site, because the counter and the timestamp
 * have to move together — a `last_compiled_at` that advanced without `times_compiled` would
 * corrupt the rotation order in a way nobody would notice until one recipe had quietly
 * taken every shot for a month.
 */
create or replace function public.record_recipe_compile(p_prompt_id uuid)
returns void
language sql
as $$
  update prompts
  set times_compiled = times_compiled + 1,
      last_compiled_at = now()
  where id = p_prompt_id;
$$;

-- ─────────────────────────────────────────────────────────────
-- 2. A recipe has to say whether it carries a character reference
--
-- Addendum 04 §3 raises a recurring character to channel IP: *one character, image
-- reference attached to every single shot, explicitly named in every prompt.* The addendum
-- is filed and not queued, so this migration does not implement it.
--
-- What it does fix is a hole in code already written. `shots.character_id` exists in 0001,
-- and compilation ignored it completely — so a shot with a character would compile to a
-- recipe that silently drops the reference and generates a different-looking person. That
-- is not a missing feature, it is a wrong answer produced confidently, and it destroys the
-- exact asset §3 says compounds.
--
-- Note what this column is *not*. It is not a shot kind. A character can appear in an
-- establishing wide, a medium, an action insert, or a macro of their hands — the character
-- axis is orthogonal to the framing axis, and collapsing them into a
-- "character-to-camera" kind would make every other kind mean "no character", which is the
-- opposite of what §3 asks for.
-- ─────────────────────────────────────────────────────────────

alter table prompts
  add column accepts_character_ref boolean not null default false;

comment on column prompts.accepts_character_ref is
  'True when this recipe was proven to carry a character reference through to the output. '
  'Orthogonal to tags: a character can appear in any framing. Compilation refuses to '
  'select a recipe without this for a shot that has a character_id, rather than silently '
  'dropping the reference and generating a stranger.';

create index on prompts (accepts_character_ref) where accepts_character_ref;

-- ─────────────────────────────────────────────────────────────
-- 3. Coverage, and why one recipe is a warning
--
-- A kind served by exactly one active recipe is not covered, it is a single point of visual
-- repetition. Every shot of that kind, across every video, gets the same camera. The
-- library screen renders this as a warning rather than a tick for that reason.
-- ─────────────────────────────────────────────────────────────

create view v_recipe_coverage as
select
  k.shot_kind,
  count(p.id) filter (where p.is_active)                         as active_recipes,
  count(p.id)                                                    as total_recipes,
  coalesce(sum(p.times_compiled) filter (where p.is_active), 0)  as compiles,
  coalesce(sum(p.times_shipped)  filter (where p.is_active), 0)  as ships,
  -- What share of this kind's compiles went to its single busiest recipe. 1.0 means one
  -- recipe is doing all the work for this kind, which is the templating risk stated as a
  -- number.
  case
    when coalesce(sum(p.times_compiled) filter (where p.is_active), 0) = 0 then null
    else round(
      max(p.times_compiled) filter (where p.is_active)::numeric
      / sum(p.times_compiled) filter (where p.is_active), 3)
  end                                                            as top_recipe_share
from (select unnest(array[
        'establishing', 'subject_medium', 'detail_macro', 'action_insert',
        'environment_move', 'abstract', 'graphic_plate'
      ]) as shot_kind) k
left join prompts p on k.shot_kind = any(p.tags)
group by k.shot_kind
order by count(p.id) filter (where p.is_active), k.shot_kind;

comment on view v_recipe_coverage is
  'Recipes per shot kind, with how concentrated their use is. One active recipe is a '
  'warning, not a tick: every shot of that kind in every video gets the same camera, and '
  'a reviewer watches rather than diffs. top_recipe_share of 1.0 says one recipe is doing '
  'all the work for a kind even when several exist.';
