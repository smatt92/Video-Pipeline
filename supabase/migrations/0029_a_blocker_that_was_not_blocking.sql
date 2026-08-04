-- Migration 0029 — a blocker that was not blocking, and a view with no reason to exist
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR, in 0024, surfaced by an assertion added
-- one round after the fact — and found in the direction that costs money.
--
-- 0028 closed the agreement between `v_pipeline_blockers` and stage 5 in the *refusing*
-- direction: when stage 5 refuses, the view names the same reason. This closes the
-- converse, which is the one that matters: a script stage 5 actually **submitted** must
-- have had `blocker = null`.
--
-- It did not. Stage 5 submitted a shot — spent money, wrote an estimate row, got a job id
-- — on a script the view called blocked, with:
--
--     no host voice on the channel — stage 6 cannot run
--
-- The view was wrong, not stage 5. Stage 5 needs `duration_source = 'derived_from_vo'`.
-- It does not need a host voice; the host voice is what lets *stage 6* produce that state.
-- Once the durations are derived, the channel's voice setting has no bearing on whether
-- anything can generate, and the branch fired anyway because it sat unconditionally at the
-- top of the CASE.
--
-- The reachable version is not exotic: set a host voice, run stage 6, then change voice
-- provider or clear the setting. Every already-timed script on that channel now reports a
-- stage-6 blocker that stage 6 has already satisfied — sending a person to fix something
-- that is not stopping anything, and hiding whatever is. That is the same harm as
-- `blocker = null` on an ungeneratable workspace, pointed the other way: a view whose
-- answer to "why did nothing come out?" is confidently the wrong thing.
--
-- The host voice is a blocker *for a script whose durations are still estimates*, and only
-- then. So it moves inside that branch and explains it, rather than pre-empting it.
-- ─────────────────────────────────────────────────────────────

drop view v_pipeline_blockers;

create view v_pipeline_blockers as
select
  s.id                                as script_id,
  c.id                                as concept_id,
  c.channel_id,
  c.title,
  s.created_at,
  case
    -- ── Workspace gates, first ────────────────────────────────────────────
    -- They block every script at once, which makes them the earliest thing to fix, and a
    -- per-script blocker shown while the workspace cannot generate sends somebody to fix
    -- the wrong thing. Matched on `kind = 'video'` rather than a slug: which vendor fills
    -- the video role is a decision in `src/lib/drivers/catalog.ts`, and teaching SQL that
    -- mapping would put it in two places.
    when not exists (
      select 1 from integrations i
       where i.kind = 'video' and i.is_enabled and i.last_verified_at is not null
    ) then 'no verified video integration — enabling states intent, verifying states fact'

    when not exists (select 1 from prompts p where p.is_active)
      then 'the prompt library has no active recipe — production reads the library, it never improvises'

    -- ── Per-script gates, in the order stage 5 hits them ──────────────────
    when not exists (select 1 from shots sh where sh.script_id = s.id)
      then 'no shots — stage 4 has not run'

    -- `prompt_id is null` is the half 0024 missed. Stage 5 skips a shot when EITHER is
    -- absent — `if (!shot.compiled_params || !shot.prompt_id)`.
    when exists (
      select 1 from shots sh
       where sh.script_id = s.id
         and (sh.compiled_params is null or sh.prompt_id is null)
    ) then 'some shots have no compiled parameters — no library recipe matched'

    when exists (
      select 1
        from shots sh
        join prompts p on p.id = sh.prompt_id
       where sh.script_id = s.id
         and not exists (
           select 1 from rate_card rc
            where rc.driver = p.driver and rc.model = p.model
              and rc.unit = 'credit' and rc.is_verified
              and rc.effective_from <= now()
         )
    ) then 'no verified credit rate for the recipe these shots use — the call cannot be priced'

    -- ── The stage-6 gate, and the host voice inside it ────────────────────
    --
    -- Two messages for one condition, because "stage 6 has not run" and "stage 6 cannot
    -- run" are different facts and lead to different actions. The voice is only reported
    -- when it is actually what is stopping the durations from being derived.
    when exists (
      select 1 from shots sh
       where sh.script_id = s.id and sh.duration_source <> 'derived_from_vo'
    ) then case
      when ch.host_voice_id is null
        then 'durations are still estimates and the channel has no host voice — stage 6 cannot run'
      else 'durations are still estimates — stage 6 has not run'
    end

    else null
  end as blocker,

  -- Whether the first blocker is one nobody can fix from this script's page. The board
  -- needs this to send a person to Settings rather than to the shot list: a workspace-level
  -- blocker is identical on every row, and a hundred rows all saying the same thing should
  -- read as one problem rather than a hundred.
  case
    when not exists (
      select 1 from integrations i
       where i.kind = 'video' and i.is_enabled and i.last_verified_at is not null
    ) then true
    when not exists (select 1 from prompts p where p.is_active) then true
    else false
  end as blocker_is_workspace_wide
from scripts s
join concepts c on c.id = s.concept_id
join channels ch on ch.id = c.channel_id;

comment on view v_pipeline_blockers is
  'For every script, the first reason it cannot reach a generation — or null when nothing '
  'is blocking it. Ordered by how early the stage sits, with the workspace-level gates '
  'ahead of the per-script ones because they block every script at once. The host voice is '
  'reported only when durations are still estimates: once stage 6 has derived them, the '
  'channel''s voice setting no longer bears on whether anything can generate, and 0024 '
  'reported it as the blocker on scripts stage 5 was submitting successfully. Both '
  'directions of the agreement with stage 5 are asserted in verify:submit — §0 for the '
  'refusing direction, §4 for the clear one.';

-- ─────────────────────────────────────────────────────────────
-- v_shot_readiness, deleted
--
-- Two views for one concept is worse than none. `v_unresolved_shots` computes
-- `matching_recipes` with the identical correlated subquery, is scoped to exactly the
-- shots the question is about (`compiled_params is null`), and has a reader —
-- `unresolvedShots()` in `src/lib/prompts/library.ts`. `v_shot_readiness` had none, and
-- the next person to tune the matching rule had a coin-flip's chance of editing the copy
-- that does nothing.
--
-- It was also the candidate for a fourth workspace gate, and that gate is not being added:
-- the state it would catch — active recipes that carry no shot kind — cannot occur. Both
-- write paths validate through `RecipeInputSchema`, whose `tags` is
-- `z.array(z.enum(SHOT_KIND_KEYS)).min(1)`, and the Studio's `save_prompt_recipe`
-- re-validates through it rather than trusting its own looser arg schema. A gate for an
-- unreachable state is the exact failure this round is about: a check that measures the
-- right thing in a world where the precondition is impossible, and goes green for ever
-- while proving nothing.
--
-- A superseded view is not history. Git is history.
-- ─────────────────────────────────────────────────────────────

drop view v_shot_readiness;

notify pgrst, 'reload schema';
