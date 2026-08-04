-- Migration 0028 — the blocker view could not see the workspace
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION, and of the most uncomfortable sort — the design was
-- correct for the case it was built for, and the second case is *the state this workspace
-- is actually in today*.
--
-- `v_pipeline_blockers` exists because the failure mode of this pipeline is silence. It
-- answers, for every script, the first reason nothing came out. It checks four things: a
-- host voice on the channel, shots existing, shots having compiled parameters, and
-- durations no longer being estimates. Every one of them is a property of a *row belonging
-- to that script*.
--
-- Stage 5 refuses on three more, and none of them is a property of any script:
--
--   · no video integration is enabled AND verified — enabling states intent, verifying
--     states fact, and only the second lets a task spend money
--   · the prompt library has no active recipe, so there is nothing to generate from
--   · the recipe's driver/model has no verified credit rate, so the call cannot be priced
--     and rule 5 forbids the submit
--
-- The Studio's `generate_shot` checks all three, names them together, and attaches a remedy
-- to each. That code is exercised — §7 of `verify:studio`, against the real API, produced
-- exactly two of them. So the workspace-level gates were never missing from the codebase.
-- They were missing from **the one instrument anybody reads**.
--
-- The consequence is the sharpest form of this project's recurring failure. On a workspace
-- with an unverified video integration — which is this one, right now — a script can have
-- a host voice, shots, compiled parameters and derived durations, and `v_pipeline_blockers`
-- returns `blocker = null`. Null means *nothing is stopping this*. The board renders it as
-- ready. Stage 5 will refuse it, every time, for ever.
--
-- A mechanism built to surface a failure mode is itself subject to that failure mode. This
-- is the third instance of that rule and by some distance the worst: the instrument for
-- reading silence reported silence as readiness.
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
    --
    -- Ahead of the per-script ones because they block *every* script at once, which makes
    -- them the earliest thing to fix — and because a per-script blocker shown while the
    -- workspace cannot generate anything sends somebody to fix the wrong thing.
    --
    -- Matched on `kind = 'video'` rather than on a slug: which vendor fills the video role
    -- is a decision in `src/lib/drivers/catalog.ts`, and teaching SQL that mapping would
    -- put it in two places. "Is there any usable video integration" is the question the
    -- board is actually asking anyway.
    when not exists (
      select 1 from integrations i
       where i.kind = 'video' and i.is_enabled and i.last_verified_at is not null
    ) then 'no verified video integration — enabling states intent, verifying states fact'

    when not exists (select 1 from prompts p where p.is_active)
      then 'the prompt library has no active recipe — production reads the library, it never improvises'

    -- ── Channel and script gates ──────────────────────────────────────────
    when ch.host_voice_id is null then 'no host voice on the channel — stage 6 cannot run'

    when not exists (select 1 from shots sh where sh.script_id = s.id)
      then 'no shots — stage 4 has not run'

    -- `prompt_id is null` is the half the original missed. Stage 5 skips a shot when
    -- EITHER is absent — `if (!shot.compiled_params || !shot.prompt_id)` — and
    -- `v_shot_readiness.generatable` has always said so, in a view nothing reads.
    when exists (
      select 1 from shots sh
       where sh.script_id = s.id
         and (sh.compiled_params is null or sh.prompt_id is null)
    ) then 'some shots have no compiled parameters — no library recipe matched'

    -- The rate gate, per script, because the recipe its shots compiled against is the
    -- driver/model stage 5 will price. Rule 5: a submit that cannot be costed must not
    -- happen, so this is a refusal and not a warning.
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

    when exists (
      select 1 from shots sh
       where sh.script_id = s.id and sh.duration_source <> 'derived_from_vo'
    ) then 'durations are still estimates — stage 6 has not run'

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
  'is blocking it. Ordered by how early the stage sits, so the answer is the *first* thing '
  'to fix rather than a list, and with the workspace-level gates ahead of the per-script '
  'ones because they block every script at once. Exists because the failure mode of this '
  'pipeline is silence; 0028 added the three gates stage 5 refuses on that belong to no '
  'script, without which this view reported an ungeneratable workspace as having nothing '
  'wrong with it.';

notify pgrst, 'reload schema';
