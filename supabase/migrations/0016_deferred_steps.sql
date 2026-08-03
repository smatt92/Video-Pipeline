-- Migration 0016 — a third state for an onboarding step: deferred
--
-- ─────────────────────────────────────────────────────────────
-- Why this exists
--
-- The gate was built on a true premise: the app should be unusable until it is usable,
-- because a missing credential discovered mid-run is discovered after the money is spent.
--
-- It missed a case. Two of the ten steps need credentials from vendors whose API access is
-- gated behind paid plans. Someone can do everything correctly and still not have them for
-- days. As built, the gate then never opens and the operator cannot see the product they
-- built — which is not a safety property, it is a lockout, and a lockout is the thing that
-- gets bypassed with a fake pass rather than respected.
--
-- So: a third state. Not a pass, not a failure. `deferred` says "I know this is not done,
-- I am proceeding anyway, and here is why". It is recorded, timestamped, reasoned, visible
-- on every screen it affects, and it does NOT make the underlying integration usable — a
-- pipeline task still refuses, with the deferral as its reason.
--
-- The distinction that keeps this honest: deferral relaxes the GATE, never a REFUSAL. The
-- app becomes reachable; nothing becomes runnable that was not runnable before.
--
-- Classification: the evolution kind. Nothing specified a deferred state and then made it
-- unrepresentable. The two-state design was right for the case it was written against —
-- an operator who has their credentials — and the case that tested it was an operator who
-- does not have them yet and never will on the timescale the gate assumed.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 1. The record
--
-- jsonb keyed by step number is the source of truth, because a reason and a timestamp are
-- part of the fact and an int[] cannot carry them. The array is derived from it by the
-- trigger below rather than maintained alongside — two hand-maintained representations of
-- one fact is how they drift.
-- ─────────────────────────────────────────────────────────────

alter table profiles
  add column onboarding_deferrals jsonb not null default '{}'::jsonb,
  add column onboarding_deferred_steps int[] not null default '{}';

comment on column profiles.onboarding_deferrals is
  'Steps explicitly deferred: {"4": {"at": "...", "reason": "..."}}. The source of truth. '
  'A reason is required — a deferral without one is indistinguishable from a step someone '
  'forgot, and the whole point is that it is a decision rather than an omission.';

comment on column profiles.onboarding_deferred_steps is
  'Derived from onboarding_deferrals by a trigger, in the same shape as '
  'onboarding_completed_steps so the gate can compare sets without special-casing. Never '
  'written directly.';

-- Same derivation pattern as 0007's onboarding_step: one source, one trigger, no second
-- place for the same fact to be wrong.
create function sync_deferred_steps() returns trigger language plpgsql as $$
begin
  new.onboarding_deferred_steps := coalesce(
    (select array_agg(key::int order by key::int)
       from jsonb_object_keys(new.onboarding_deferrals) as key),
    '{}'
  );
  return new;
end
$$;

create trigger profiles_sync_deferred_steps
  before insert or update of onboarding_deferrals on profiles
  for each row execute function sync_deferred_steps();

-- A step cannot be both completed and deferred. If a deferred integration is later
-- verified for real, the deferral is cleared by the same action that records the pass —
-- otherwise the banner would keep naming an integration that now works.
alter table profiles
  add constraint profiles_deferred_not_completed
  check (not (onboarding_completed_steps && onboarding_deferred_steps));

-- ─────────────────────────────────────────────────────────────
-- 2. Deferring is one statement
--
-- Read-modify-write on a jsonb column from the application would lose a concurrent
-- deferral of a different step. Cheap to do correctly here.
-- ─────────────────────────────────────────────────────────────

create function defer_onboarding_step(
  p_profile_id uuid,
  p_step       int,
  p_reason     text
) returns jsonb language plpgsql as $$
declare
  updated jsonb;
begin
  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A deferral needs a reason. Without one it is indistinguishable from a step somebody forgot.';
  end if;

  update profiles
     set onboarding_deferrals = onboarding_deferrals || jsonb_build_object(
           p_step::text,
           jsonb_build_object('at', now(), 'reason', trim(p_reason))
         )
   where id = p_profile_id
  returning onboarding_deferrals into updated;

  if updated is null then
    raise exception 'No profile %. Step 1 creates it.', p_profile_id;
  end if;

  return updated;
end
$$;

comment on function defer_onboarding_step is
  'Records a step as deliberately skipped, with a reason. Does NOT mark it complete and '
  'does NOT make the underlying integration usable — isUsable() still requires a real '
  'verification. Deferral relaxes the gate, never a refusal.';

create function undefer_onboarding_step(p_profile_id uuid, p_step int)
returns jsonb language sql as $$
  update profiles
     set onboarding_deferrals = onboarding_deferrals - p_step::text
   where id = p_profile_id
  returning onboarding_deferrals;
$$;

comment on function undefer_onboarding_step is
  'Clears a deferral. Called when the step is genuinely completed later, so the banner '
  'stops naming an integration that now works.';

-- ─────────────────────────────────────────────────────────────
-- 3. What is inert, for the screens that have to say so
--
-- One row per deferred integration, joined to what it would have provided. The banner and
-- the empty states read this rather than each deriving the mapping themselves.
-- ─────────────────────────────────────────────────────────────

create view v_deferred_steps as
select
  p.id                            as profile_id,
  d.key::int                      as step,
  d.value ->> 'reason'            as reason,
  (d.value ->> 'at')::timestamptz as deferred_at
from profiles p
cross join lateral jsonb_each(p.onboarding_deferrals) as d(key, value);

comment on view v_deferred_steps is
  'Deferred steps with their reason and timestamp, one row each. Deliberately says nothing '
  'about which integration a step configures: that mapping is STEP_KIND in the application '
  'catalogue, and a step → vendor map in SQL is the same rule-1 violation as one in a '
  'component. The caller joins it.';
