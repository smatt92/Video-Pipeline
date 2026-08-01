-- Migration 0005 — profiles, onboarding gate, workspace settings
--
-- Source: docs/addenda/03-supabase-settings-onboarding-screens.md §1–2.
--
-- The premise: the app should be unusable until it is usable. Today a missing credential
-- surfaces in the middle of a pipeline run, which is the most expensive possible place to
-- discover it. The onboarding step is a redirect gate, not a dismissible banner.

-- ─────────────────────────────────────────────────────────────
-- 1. Profiles
--
-- `id` is expected to equal `auth.users.id`, but carries no foreign key — matching the
-- convention already set by `concepts.approved_by` and `reviews.reviewer_id` in 0001.
-- The auth schema is a Supabase-managed namespace that does not exist on a plain
-- Postgres, and a hard FK here would make the migration sequence unrunnable anywhere
-- else, including CI.
-- ─────────────────────────────────────────────────────────────

create table profiles (
  id           uuid primary key,
  email        text not null unique,
  display_name text,

  -- Workspace settings. These are settings, not constants: the FX rate in particular
  -- decides every rupee figure in the product, and a constant in code cannot be corrected
  -- without a deploy.
  timezone     text not null default 'Asia/Kolkata',
  currency     text not null default 'INR',
  usd_inr_rate numeric,

  -- Onboarding gate
  onboarding_step                 int not null default 0,
  onboarding_completed_at         timestamptz,
  onboarding_first_video_render_id uuid references renders(id) on delete set null,

  created_at   timestamptz not null default now()
);

comment on column profiles.usd_inr_rate is
  'Overrides the USD_INR_RATE bootstrap env var once onboarding sets it. Env keeps the '
  'value only so the app can start before a profile exists; after that this is the truth, '
  'and cost_ledger.usd_inr_rate snapshots whichever was in force at write time.';

comment on column profiles.onboarding_step is
  'Highest step completed. Middleware redirects every route except /onboarding/* and '
  '/settings/* until the required steps pass. A banner would be ignored; a redirect '
  'cannot be.';

comment on column profiles.onboarding_first_video_render_id is
  'The guided first video. Onboarding ends by producing something real rather than with '
  '"you are all set" — it proves every integration works together and leaves the user '
  'holding an artifact. Null here means the user never finished, which is worth knowing.';

-- ─────────────────────────────────────────────────────────────
-- 2. Integrations stay workspace-scoped, but stop forbidding per-profile
--
-- Nullable and unused today. Adding the column now costs nothing; adding it later, once
-- rows and queries exist, costs a migration with a backfill and a week of "which
-- integration did that run use?".
-- ─────────────────────────────────────────────────────────────

alter table integrations
  add column profile_id uuid references profiles(id) on delete cascade;

comment on column integrations.profile_id is
  'Null means workspace-scoped, which is every row today. Reserved for multi-profile.';

create index on integrations (profile_id) where profile_id is not null;

-- ─────────────────────────────────────────────────────────────
-- 3. Onboarding needs to know whether a probe actually passed
--
-- Not in the addendum's SQL, but §2 requires "a real call, not a format check" at every
-- step, and `integrations.last_verified_at` only records that *something* succeeded. The
-- storage probe (write → read back → delete) and the credit-balance fetch are different
-- claims, and onboarding step 4 blocks on step 2 having passed specifically.
--
-- integration_events already records attempts; this records the *current* answer per
-- check so the wizard can render a green tick without replaying history.
-- ─────────────────────────────────────────────────────────────

create table integration_checks (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  check_name     text not null,          -- 'credentials' | 'round_trip' | 'balance' | 'voices'
  passed         boolean not null,
  detail         text,
  checked_at     timestamptz not null default now(),
  unique (integration_id, check_name)
);

comment on table integration_checks is
  'Latest result per named check. An integration is only usable by a pipeline task when '
  'every check it declares has passed — "the key is valid" and "we can round-trip an '
  'object" are separate facts and only one of them is about the credential.';
