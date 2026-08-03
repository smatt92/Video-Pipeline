-- Migration 0020 — onboarding happens before sign-in, and setup stops being a gate
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR, and it is the interesting sort — the
-- schema was a faithful realisation of a decision that has since been reversed.
--
-- 0005 gave `profiles` an onboarding gate and the app enforced it: no profile row, no app.
-- That put the product tour *behind* authentication, which means the only people who ever
-- saw the explanation of what Kiln is were people who had already decided to sign up. The
-- tour was doing no work.
--
-- Reversing it breaks an assumption the schema encodes rather than states: that the
-- onboarding gate has a profile to read. An anonymous visitor has no row, no id, and no
-- place to record that they have seen anything — so "has this person seen onboarding?"
-- becomes unanswerable for exactly the population the tour now targets.
--
-- A cookie answers it for them. That is not a schema change; what IS a schema change is
-- that the cookie has to survive the transition to a real account, or the first thing a
-- new user sees after signing in is the tour they just finished.
-- ─────────────────────────────────────────────────────────────

alter table profiles
  add column onboarding_seen_at timestamptz;

comment on column profiles.onboarding_seen_at is
  'When this person finished (or skipped) the product tour. Reconciled from the anonymous '
  'cookie at first sign-in, so the tour is not shown twice to someone who saw it before '
  'they had an account. Deliberately distinct from onboarding_completed_at: seen means '
  '"knows what this is", completed means "has configured it", and the entry flow now '
  'branches on the first while the deferral banner reports the second.';

-- ─────────────────────────────────────────────────────────────
-- Setup completeness is no longer a gate
--
-- Not enforced here, because it never was — `isOnboardingComplete` is application logic
-- and the middleware was what refused. What this migration does is make the *reason* the
-- old shape existed unrecoverable by accident: 0016 restricted deferral to the two steps
-- whose vendor gates API access behind a paid plan, on the grounds that "a gate that can
-- be waved through entirely is not a gate".
--
-- That reasoning was correct while setup was a gate. It is not a gate any more, so the
-- restriction now only prevents someone from recording *why* they skipped a step — which
-- makes the record worse, not the control stronger. Every step becomes deferrable.
--
-- What does NOT change, and is the whole design: deferring opens the app and makes
-- nothing runnable. `usability()` still requires is_enabled AND last_verified_at, and a
-- deferral only changes the sentence it gives back.
-- ─────────────────────────────────────────────────────────────

comment on column profiles.onboarding_deferred_steps is
  'Steps deliberately skipped. Since 0020 this may be any step, because setup is no longer '
  'a gate and the array''s job is now provenance rather than permission. Deferring has '
  'never made anything usable and still does not: a deferred integration is unverified, '
  'and every task refuses it with a sentence naming the deferral rather than a generic '
  '"not configured".';

-- The one invariant worth keeping from 0016: a step cannot be both done and skipped.
-- Unchanged, and re-stated here because it is now the only constraint on the array.

create or replace view v_entry_state as
select
  p.id                                   as profile_id,
  p.email,
  p.onboarding_seen_at is not null       as onboarding_seen,
  p.onboarding_completed_at is not null  as setup_complete,
  coalesce(array_length(p.onboarding_deferred_steps, 1), 0) as deferred_steps,
  coalesce(array_length(p.onboarding_completed_steps, 1), 0) as completed_steps
from profiles p;

comment on view v_entry_state is
  'What the entry flow branches on, per profile. Two independent booleans: seen decides '
  'whether the tour runs, complete decides whether the deferral banner shows. Reading them '
  'as one value is the mistake this view exists to make hard.';

notify pgrst, 'reload schema';
