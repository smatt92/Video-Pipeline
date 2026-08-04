-- Migration 0033 — the pilot shot
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: neither. A new control over an existing one.
--
-- Stage 5 fans out every shot in a script in one call. Six shots at ₹50–200 each are
-- committed before a single frame has been seen, so the first thing anybody learns about a
-- recipe is learned six charges in — and on a recipe's first outing the look is usually
-- wrong. The whole fan-out was spent finding that out.
--
-- So: submit shot 1 alone, look at it, fan out the rest only on approval. A rejected look
-- costs one clip instead of six.
-- ─────────────────────────────────────────────────────────────
--
-- ── Why approval is a compare-and-set ────────────────────────────────────────
--
-- Approving spends money — that is the entire point of the control — so it has the same
-- shape as approving a concept and confirming a generation: a transition the database
-- decides, exactly once, rather than an application check two clicks or two tabs can both
-- pass. `approve_pilot_once` carries `pilot_approved_at is null` as the compare half, and
-- `pilot_generation_id = $2` as well, so approving a pilot that has since been replaced
-- also loses. An `is null` check alone would miss that case.
--
-- ── Why it lives on the script, not the shot ─────────────────────────────────
--
-- The shot is the artifact; the decision is about the script's remaining shots. On
-- `shots.status` it would make "is this script waiting on a pilot?" a question about which
-- of N rows happens to be first, and the answer would change when a shot was reordered.
-- ─────────────────────────────────────────────────────────────

alter table scripts
  add column pilot_generation_id uuid references generations(id) on delete set null,
  add column pilot_approved_at   timestamptz,
  add column pilot_approved_by   uuid,
  add column pilot_rejected_at   timestamptz,
  add column pilot_reject_reason text;

comment on column scripts.pilot_generation_id is
  'The one shot submitted alone, before the rest. Set by stage 5 after a successful pilot '
  'submit; the fan-out refuses until pilot_approved_at is set. Written after the submit '
  'rather than before, so a failed submit cannot leave a script waiting on a pilot that '
  'does not exist — the blocker view would then say "waiting on pilot approval" for ever '
  'with nothing to look at, which is the invented state becoming the silence it prevents.';

comment on column scripts.pilot_approved_at is
  'Set only by approve_pilot_once, which is a compare-and-set because approving spends '
  'money — the same reason concept approval and generation confirmation are.';

alter table scripts
  add constraint scripts_pilot_decided_once
  check (pilot_approved_at is null or pilot_rejected_at is null);

create index scripts_pilot_pending_idx
  on scripts (id)
  where pilot_generation_id is not null
    and pilot_approved_at is null
    and pilot_rejected_at is null;

create function approve_pilot_once(
  p_script_id     uuid,
  p_generation_id uuid,
  p_approved_by   uuid default null
)
returns boolean
language plpgsql
as $$
declare
  won boolean;
begin
  update scripts
     set pilot_approved_at = now(),
         pilot_approved_by = p_approved_by
   where id = p_script_id
     and pilot_generation_id = p_generation_id
     and pilot_approved_at is null
     and pilot_rejected_at is null
  returning true into won;

  return coalesce(won, false);
end;
$$;

comment on function approve_pilot_once is
  'Approve a script''s pilot, exactly once. Returns true to the single caller that won and '
  'false to every other — a second click, a second tab, or a caller approving a pilot that '
  'has since been replaced. Everything that spends money hangs off that boolean: the '
  'fan-out reads pilot_approved_at, not the caller''s word for it.';

-- ─────────────────────────────────────────────────────────────
-- The board must name the new state, in the same change that invents it
--
-- Read-silence-back, applied to a state being created rather than discovered. A script
-- whose pilot is submitted and awaiting a human has nothing wrong with it and is going
-- nowhere — exactly the shape that made `shot_listed` mean "stuck for ever". This view has
-- now twice reported an invented state as something it was not (readiness in 0028, a
-- blocker that was not blocking in 0029), so the state gets named here rather than after
-- somebody notices a board full of stalled rows.
--
-- `awaiting_pilot_approval` is also a column of its own, not only a blocker string:
-- waiting on a person is not a misconfiguration, and a screen must be able to render it
-- differently and offer the decision rather than report a problem that does not exist.
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
    when not exists (
      select 1 from integrations i
       where i.kind = 'video' and i.is_enabled and i.last_verified_at is not null
    ) then 'no verified video integration — enabling states intent, verifying states fact'

    when not exists (select 1 from prompts p where p.is_active)
      then 'the prompt library has no active recipe — production reads the library, it never improvises'

    when not exists (select 1 from shots sh where sh.script_id = s.id)
      then 'no shots — stage 4 has not run'

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

    when s.pilot_rejected_at is not null
      then 'the pilot shot was rejected — change the recipe and submit a new pilot'
    when s.pilot_generation_id is not null and s.pilot_approved_at is null
      then 'waiting on pilot approval — one shot was generated so the rest can be judged before they are paid for'

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

  case
    when not exists (
      select 1 from integrations i
       where i.kind = 'video' and i.is_enabled and i.last_verified_at is not null
    ) then true
    when not exists (select 1 from prompts p where p.is_active) then true
    else false
  end as blocker_is_workspace_wide,

  (s.pilot_generation_id is not null
     and s.pilot_approved_at is null
     and s.pilot_rejected_at is null)  as awaiting_pilot_approval
from scripts s
join concepts c on c.id = s.concept_id
join channels ch on ch.id = c.channel_id;

comment on view v_pipeline_blockers is
  'For every script, the first reason it cannot reach a generation — or null when nothing is '
  'blocking it. Workspace gates first because they block every script at once; the pilot '
  'gate after the readiness gates, because a pilot can only exist once those pass. '
  'awaiting_pilot_approval is a column of its own so a screen can tell waiting-on-a-person '
  'apart from a misconfiguration: this view has twice reported an invented state as '
  'something it was not, and rendering a pending pilot as stalled would be the third.';

notify pgrst, 'reload schema';
