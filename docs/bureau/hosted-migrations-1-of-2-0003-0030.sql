-- Kiln — migrations 0003 to 0030, bundled for the Supabase SQL editor.
--
-- GENERATED FILE. Do not edit; regenerate with `pnpm db:bundle`.
--
-- ── How to use ──────────────────────────────────────────────────────────────
--
--   1. Supabase dashboard → SQL Editor → New query
--   2. Paste this entire file
--   3. Run
--
-- Expected output is "Success. No rows returned". Anything else means nothing was
-- applied: the whole file is one transaction, so a failure rolls back every statement in
-- it. There is no half-applied state to clean up.
--
-- The last statement in this file is `notify pgrst, 'reload schema'`. Without it the
-- app keeps reporting "Could not find the table 'public.X' in the schema cache" even
-- though every table exists — PostgREST caches the schema and pasting SQL does not tell
-- it to reload. It is included; you do not need to run it separately.
--
-- ── Running it twice ────────────────────────────────────────────────────────
--
-- Safe. The guard below raises before any schema change if any of these versions is
-- already recorded, and the transaction rolls back. You will see an error that says so in
-- words — that error is the file working, not failing.
--
-- ── What it records ─────────────────────────────────────────────────────────
--
-- Each migration is written into supabase_migrations.schema_migrations, the same table
-- `supabase db push` uses. If the CLI starts working later it reads this as its own
-- history and reports the project up to date rather than replaying anything.
--
-- Migrations included (28):
--   0003  studio_lane_and_integrations
--   0004  audio_first_timing
--   0005  profiles_and_onboarding
--   0006  llm_cost_attribution
--   0007  vault_secrets_and_onboarding_progress
--   0008  credit_purchases_and_concurrency
--   0009  shot_vo_span_and_compile_state
--   0010  prompt_library
--   0011  recipe_usage_and_rotation
--   0012  vo_stitching_and_durations
--   0013  generation_ingest
--   0014  catalogue_rows_are_not_fixtures
--   0015  webhook_replay
--   0016  deferred_steps
--   0017  studio_spend_has_a_subject
--   0018  review_trims_and_reorder
--   0019  ui_scale_preference
--   0020  onboarding_before_sign_in
--   0021  referral_attribution_and_rollup
--   0022  submitting_is_a_state
--   0023  a_charge_can_belong_to_a_channel
--   0024  a_channel_has_a_voice
--   0025  a_recipe_earns_its_place
--   0026  cost_per_video_is_a_row
--   0027  studio_spend_reaches_its_video
--   0028  the_blocker_view_could_not_see_the_workspace
--   0029  a_blocker_that_was_not_blocking
--   0030  two_views_that_could_not_answer_their_own_question

begin;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key
);

alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;

-- ── Guard ───────────────────────────────────────────────────────────────────
do $kiln_guard$
declare
  seen text;
begin
  select string_agg(version, ', ' order by version) into seen
  from supabase_migrations.schema_migrations
  where version in ('0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0019', '0020', '0021', '0022', '0023', '0024', '0025', '0026', '0027', '0028', '0029', '0030');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0003_studio_lane_and_integrations.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0003 studio_lane_and_integrations'; end $kiln_progress$;

-- Migration 0003 — Studio lane, integrations, rough cuts, cost view correction
--
-- Source: docs/addenda/01-studio-lane-and-integrations.md §5.
--
-- Applied as specified except for six corrections, each marked [FIX] below and listed
-- in docs/decisions/0006-addendum-01-sql-corrections.md. None of them change intent;
-- they close holes that would have shipped silently.

-- ─────────────────────────────────────────────────────────────
-- 1. Studio lane
--
-- The Studio lane gets exactly one table, and it is a session log — not a parallel
-- content model. Everything downstream (shots, generations, assets, renders, reviews)
-- is shared with the pipeline lane, so review, stitch, cost and the originality trail
-- work on Studio output with no special-casing.
--
-- The transcript is the point. §0.2 of ARCHITECTURE.md makes human editorial judgment a
-- compliance control; a conversational lane produces literal turn-by-turn evidence of
-- it. This column is the appeal evidence.
-- ─────────────────────────────────────────────────────────────

create table studio_sessions (
  id            uuid primary key default gen_random_uuid(),
  channel_id    uuid references channels(id),
  script_id     uuid references scripts(id),      -- materialised on first generation
  title         text,
  model         text not null,
  transcript    jsonb not null default '[]',      -- full turn history = editorial evidence
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_inr      numeric not null default 0,
  spend_cap_inr numeric,
  status        text not null default 'active'
                check (status in ('active','archived','capped')),
  created_at    timestamptz not null default now()
);

create index on studio_sessions (status, created_at desc);
create index on studio_sessions (script_id);

comment on column studio_sessions.transcript is
  'Full turn history. This is originality evidence under the inauthentic-content policy, '
  'not a debug log — do not truncate it, and do not drop turns on archive.';
comment on column studio_sessions.spend_cap_inr is
  'Hard ceiling for the session. An agent loop with tool access can burn a lot of tokens '
  'on one bad turn; status flips to ''capped'' rather than continuing.';

alter table generations
  add column origin text not null default 'pipeline'
      check (origin in ('pipeline','studio','studio_unmanaged')),
  add column studio_session_id uuid references studio_sessions(id),
  -- soul(text→image) → dop(image→video) is a chain, not one call
  add column parent_generation_id uuid references generations(id);

comment on column generations.origin is
  'studio_unmanaged means the row records a generation made through a vendor MCP server '
  'we do not control: no idempotency key we issued, no cost we can attribute. Such rows '
  'must carry cost_inr = null rather than zero — zero is a claim, null is the truth.';
comment on column generations.parent_generation_id is
  'Keyframe→video chaining. A shot generated as text→image→video is two rows, two cost '
  'entries, one shot. Cost per shot is the sum of the chain, not the last link.';

create index on generations (studio_session_id) where studio_session_id is not null;
create index on generations (parent_generation_id) where parent_generation_id is not null;

alter table renders
  add column kind text not null default 'final'
      check (kind in ('rough_cut','final')),
  -- [FIX 1] The addendum adds renders.origin with no CHECK, while generations.origin has
  -- one. Same column, same meaning, same closed set — an unconstrained twin would drift.
  add column origin text not null default 'pipeline'
      check (origin in ('pipeline','studio','studio_unmanaged'));

comment on column renders.kind is
  'rough_cut = ffmpeg concat for review ("does this hang together?"). '
  'final = Remotion composition with captions, hook text, safe areas. '
  'Only final renders carry cost in v_render_cost.';

-- ─────────────────────────────────────────────────────────────
-- 2. Integrations
--
-- Credentials move from environment variables to the database, which changes the driver
-- constructor: a driver is built per-call from an integration record, never from
-- module-level process.env. Environment keeps two jobs only — bootstrap and CI.
--
-- The secret value is never a column here. `vault_secret_id` points into Supabase Vault;
-- `last_4` exists so the UI can show which key is configured without being able to read
-- it back.
-- ─────────────────────────────────────────────────────────────

create table integrations (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  kind             text not null check (kind in ('llm','video','audio','storage','mcp','channel')),
  config           jsonb not null default '{}',   -- non-secret only
  vault_secret_id  uuid,
  last_4           text,
  is_enabled       boolean not null default false,
  last_verified_at timestamptz,
  last_error       text,
  created_at       timestamptz not null default now()
);

comment on column integrations.config is
  'Non-secret configuration only. If a value would be damaging in a screenshot, it '
  'belongs in Vault behind vault_secret_id, not here.';
comment on column integrations.last_verified_at is
  'Set by the Test-connection action, which makes the cheapest real call the vendor '
  'offers. A pipeline task must refuse to select an integration that has never verified.';

create table mcp_servers (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  url              text not null,
  auth_mode        text not null check (auth_mode in ('none','bearer','oauth')),
  vault_secret_id  uuid,
  allowed_tools    text[] default '{}',
  is_enabled       boolean not null default false,
  last_verified_at timestamptz,
  created_at       timestamptz not null default now()
);

comment on column mcp_servers.allowed_tools is
  'Allowlist. Empty array means no tools are exposed, not all of them — an agent with '
  'unbounded tool access to a spending API is not a default worth having.';

create table integration_events (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid references integrations(id) on delete cascade,
  -- [FIX 2] The addendum documents the value set in a comment but does not constrain it.
  -- An audit trail with free-text event names stops being groupable within a month.
  event          text not null
                 check (event in ('created','rotated','verified','failed','disabled','enabled')),
  detail         text,
  occurred_at    timestamptz not null default now()
);

create index on integration_events (integration_id, occurred_at desc);

comment on table integration_events is
  'Cheap now, essential the day a key leaks and the question is "when did this change, '
  'and what used it since?"';

-- ─────────────────────────────────────────────────────────────
-- 3. Rate card gains endpoint granularity and an honesty flag
-- ─────────────────────────────────────────────────────────────

alter table rate_card
  add column endpoint    text,
  add column is_verified boolean not null default false,
  add column source_note text;

comment on column rate_card.is_verified is
  'False means the number is a guess. Nothing may display a rupee figure derived from an '
  'unverified rate — show "unpriced" instead. A wrong cost is worse than a missing one '
  'because it gets believed.';
comment on column rate_card.source_note is
  'Where the number came from: an invoice, an observed credit delta, a docs page. '
  'Without this, is_verified is just a boolean someone flipped.';

-- [FIX 3] 0002 keyed rate_card on (driver, model, effective_from). With per-endpoint
-- pricing, two endpoints on the same model are now distinct rates and that key rejects
-- the second one. Rekey to include endpoint.
--
-- endpoint is nullable and NULLs do not compare equal in a UNIQUE constraint, so a
-- plain constraint would silently permit unlimited duplicate NULL-endpoint rows — the
-- exact ambiguity 0002 existed to remove. A unique index over coalesce() restores it.
alter table rate_card
  drop constraint rate_card_driver_model_effective_key;

create unique index rate_card_driver_model_endpoint_effective_key
  on rate_card (driver, model, coalesce(endpoint, ''), effective_from);

create index on rate_card (driver, model, endpoint, effective_from desc);

-- ─────────────────────────────────────────────────────────────
-- 4. Cost views — correcting the double-count
--
-- The original v_render_cost joined renders→shots→generations on script_id, so every
-- variant render of one script reported the *full* script cost and summing across
-- renders multiplied it by the number of variants.
--
-- Shot spend is genuinely shared across variants of the same script: five hook variants
-- over one body did not generate the body five times. So shot cost is divided across the
-- final renders that share it, and render-specific spend (encode, per-variant VO)
-- attaches directly.
--
-- That division is a modelling choice, not a fact. If you would rather see full shot cost
-- against every variant, drop the divisor — but then never SUM this column.
-- ─────────────────────────────────────────────────────────────

drop view if exists v_cost_per_1k_views;
drop view if exists v_render_cost;

create view v_script_cost as
select
  s.script_id,
  sum(cl.cost_inr)                                        as cost_inr,
  count(distinct g.id)                                    as generations_used,
  count(distinct g.id) filter (where g.status = 'failed') as generations_wasted
from shots s
left join generations g  on g.shot_id = s.id
left join cost_ledger cl on cl.generation_id = g.id
group by s.script_id;

comment on view v_script_cost is
  'Total generation spend for a script, counted once. Includes wasted generations — a '
  'reshoot that cost money and produced nothing is part of what the script cost.';

create view v_render_cost as
select
  r.id        as render_id,
  r.script_id,
  -- [FIX 4] coalesce the shared term. The addendum wraps only the render-specific
  -- subquery, so a script with no generations yet yields NULL / n + 0 = NULL, and the
  -- render's own encode cost disappears rather than standing alone.
  coalesce(vsc.cost_inr, 0) / nullif(count(*) over (partition by r.script_id), 0)
    + coalesce((select sum(cl.cost_inr) from cost_ledger cl where cl.render_id = r.id), 0)
    as cost_inr,
  coalesce(vsc.generations_used, 0)   as generations_used,
  coalesce(vsc.generations_wasted, 0) as generations_wasted
-- [FIX 5] LEFT JOIN, not JOIN. An inner join drops any render whose script has no shots
-- rows yet, which is precisely the state a render is in while its first shots are still
-- generating — the window in which you most want to watch the cost climb.
from renders r
left join v_script_cost vsc on vsc.script_id = r.script_id
where r.kind = 'final';

comment on view v_render_cost is
  'Cost attributable to one final render. Shot spend is divided across the final renders '
  'of the same script because variants share it; SUM over this column is meaningful, '
  'SUM over an undivided one would not be. Rough cuts are excluded — they are a review '
  'artifact, not an output.';

create view v_cost_per_1k_views as
select
  p.id as publication_id,
  vrc.cost_inr,
  ms.views,
  case when ms.views > 0 then vrc.cost_inr / (ms.views / 1000.0) end as cost_per_1k_views
from publications p
join v_render_cost vrc     on vrc.render_id = p.render_id
join metrics_snapshots ms  on ms.publication_id = p.id and ms.age_bucket = '7d';

comment on view v_cost_per_1k_views is
  'The only number that touches the business question.';

-- ─────────────────────────────────────────────────────────────
-- 5. Existing seed rates are guesses; say so
--
-- [FIX 6] is_verified defaults to false, which is correct for new rows, but the rate_card
-- rows already seeded carry placeholder zeros. Marking them explicitly makes the
-- "unpriced" path exercisable from the first run rather than looking like real zero-cost
-- generation.
-- ─────────────────────────────────────────────────────────────

update rate_card
set is_verified = false,
    source_note = 'placeholder seeded during scaffold — replace with an observed credit delta'
where unit_cost = 0;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0003', 'studio_lane_and_integrations', array['-- applied from a lean bundle; text in supabase/migrations/0003_studio_lane_and_integrations.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0004_audio_first_timing.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0004 audio_first_timing'; end $kiln_progress$;

-- Migration 0004 — audio-first timing
--
-- Source: docs/addenda/02-audio-lane-settings-ia-design.md §1.
--
-- This migration encodes a reordering of the DAG, not just new columns. Stage 6 (voice)
-- now runs *ahead* of stage 5 (generate): the VO is synthesised first, its word timings
-- define the beat boundaries, and those boundaries set `shots.duration_s`. Video is then
-- generated to fit real speech instead of speech being stretched to fit video.
--
-- The reason is economic. VO costs roughly a hundredth of video generation, so a bad
-- duration estimate should be paid for by regenerating the cheap artifact, not the
-- expensive one. Let the cheap artifact define the timeline the expensive one satisfies.

-- ─────────────────────────────────────────────────────────────
-- 1. Shot durations become derived
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column duration_source text not null default 'authored'
    check (duration_source in ('authored', 'derived_from_vo'));

comment on column shots.duration_source is
  'authored = a human or the script model picked this number. derived_from_vo = it was '
  'computed from word timings and reflects real speech. When a shot looks mistimed, this '
  'column tells you whether the estimate was the problem or the delivery was.';

-- ─────────────────────────────────────────────────────────────
-- 2. VO takes and word timings
--
-- One row per synthesis call. Long scripts are chunked (200–500 words) because language
-- and accent drift on long single generations is a documented, repeatable failure, so a
-- script's VO is several rows ordered by chunk_idx with a cumulative offset_s.
-- ─────────────────────────────────────────────────────────────

create table vo_takes (
  id                uuid primary key default gen_random_uuid(),
  script_id         uuid not null references scripts(id) on delete cascade,
  chunk_idx         int not null default 0,
  driver            text not null,
  model             text not null,
  voice_id          text not null,
  language          text not null default 'en',
  text_in           text not null,
  asset_id          uuid references assets(id),
  -- derived from normalized_alignment, not the raw alignment
  word_timings      jsonb not null default '[]',   -- [{w, start, end}]
  offset_s          numeric not null default 0,    -- cumulative offset when chunked
  characters_billed int,
  cost_inr          numeric,
  seed              bigint,
  created_at        timestamptz not null default now(),
  unique (script_id, chunk_idx, language)
);

create index on vo_takes (script_id, language, chunk_idx);

comment on table vo_takes is
  'One synthesis call. A script''s full VO in one language is every row for that script '
  'ordered by chunk_idx, each shifted by its offset_s.';

comment on column vo_takes.word_timings is
  'Word-level timings derived from the vendor''s NORMALIZED alignment — what was actually '
  'spoken ("$5" → "five dollars"), not what was typed. Burned-in captions read from this, '
  'so using the raw alignment would caption text the viewer never hears.';

comment on column vo_takes.offset_s is
  'Seconds to add to every timing in this chunk to place it on the script timeline. '
  'Chunk 0 is 0; each later chunk carries the summed duration of everything before it.';

comment on column vo_takes.language is
  'Language variants are generated natively with the cloned host voice, not dubbed — '
  'dubbing returns no word timings, and without timings there are no derived durations '
  'and no free captions.';

-- ─────────────────────────────────────────────────────────────
-- 3. Audio generations need a home in the cost ledger too
--
-- `generations.kind` already allows 'audio', and cost_ledger already keys on
-- generation_id. Nothing new is required for VO to be costed — which is the point of the
-- shared result-and-cost shape. This is a note, not a change.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 4. Audio driver integration slot and rates
--
-- Concurrency is the throttle unit for the audio vendor, not requests-per-minute, and the
-- ceiling is a hard per-tier number (Free 2, Starter 3, Creator 5, Pro 10, Scale 15,
-- Business 15). It lives in the integration record so the Trigger task reads its limit
-- from the database. A hardcoded concurrency produces a permanent failure rate that looks
-- like a flaky vendor.
-- ─────────────────────────────────────────────────────────────

insert into integrations (slug, kind, is_enabled, config)
values (
  'elevenlabs',
  'audio',
  false,
  jsonb_build_object(
    'tier', null,               -- set from settings; drives max_concurrency
    'max_concurrency', null,    -- null = unknown, and unknown must not be guessed
    'chunk_words', 350,
    'normalization', 'auto'
  )
)
on conflict (slug) do nothing;

-- Unverified, like every other seeded rate. Per-1000-characters is the vendor's billing
-- unit; `unit` is 'character' and quantity is the character count.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('elevenlabs', 'eleven_multilingual_v2', '/v1/text-to-speech/with-timestamps', 'character', 0.0, 'USD', false, 'placeholder — read actual billing off the account', '1970-01-01T00:00:00Z'),
  ('elevenlabs', 'eleven_v3',              '/v1/text-to-speech/with-timestamps', 'character', 0.0, 'USD', false, 'placeholder — read actual billing off the account', '1970-01-01T00:00:00Z'),
  ('elevenlabs', 'eleven_flash_v2_5',      '/v1/text-to-speech/with-timestamps', 'character', 0.0, 'USD', false, 'placeholder — read actual billing off the account', '1970-01-01T00:00:00Z')
on conflict (driver, model, coalesce(endpoint, ''), effective_from) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 5. Pronunciation dictionary
--
-- Not in the addendum's SQL, but §2 requires "an editable table, because you will add
-- entries weekly", and the settings page needs somewhere to write. Phoneme tags only
-- apply on some models; others silently ignore them, which is why `kind` distinguishes
-- an alias substitution from a phoneme rule rather than assuming one works everywhere.
-- ─────────────────────────────────────────────────────────────

create table pronunciations (
  id            uuid primary key default gen_random_uuid(),
  grapheme      text not null,                 -- the written form, e.g. 'GTA'
  kind          text not null check (kind in ('alias', 'phoneme')),
  replacement   text not null,                 -- alias text, or the phoneme string
  alphabet      text check (alphabet in ('cmu', 'ipa')),
  language      text not null default 'en',
  notes         text,
  created_at    timestamptz not null default now(),
  unique (grapheme, language, kind)
);

comment on table pronunciations is
  'Indian place names, brand names and gaming acronyms are mispronounced by default. '
  'CMU is more predictable than IPA. Vendors cap the number of dictionary locators per '
  'request (3), so this table is a source to compile from, not a list to send wholesale.';

comment on column pronunciations.kind is
  'phoneme rules are honoured only by some models and silently ignored by the rest; '
  'alias substitution works everywhere. Prefer alias unless the model is known to support '
  'phonemes, because a silently ignored rule is worse than an ugly one that works.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0004', 'audio_first_timing', array['-- applied from a lean bundle; text in supabase/migrations/0004_audio_first_timing.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0005_profiles_and_onboarding.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0005 profiles_and_onboarding'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0005', 'profiles_and_onboarding', array['-- applied from a lean bundle; text in supabase/migrations/0005_profiles_and_onboarding.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0006_llm_cost_attribution.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0006 llm_cost_attribution'; end $kiln_progress$;

-- Migration 0006 — the ledger has to be able to hold LLM spend
--
-- CLAUDE.md rule 5: every external call that costs money writes a cost_ledger row at
-- submit time. Stage 3 drafts a script with a paid LLM call, and today that row cannot be
-- written at all — `cost_ledger_has_subject` (0002) requires generation_id or render_id,
-- and a script draft is neither. The rule was unenforceable for the first paid call in
-- the pipeline, which is the kind of gap that gets discovered by a cost figure that is
-- quietly too low rather than by an error.

-- ─────────────────────────────────────────────────────────────
-- 1. Two more subjects: the script, and the concept
--
-- The script is the obvious one — a successful draft is charged to what it produced.
--
-- The concept is the one that is easy to miss and matters more. A refusal, a truncation
-- and a schema violation are all billed exactly like a success, and none of them produces
-- a scripts row to hang the charge on. Without a second subject the only options are to
-- drop the row, which under-reports the metric the whole project is measured by, or to
-- write a scripts row for a draft that does not exist, which corrupts the originality
-- evidence that table is for (ARCHITECTURE.md §0.2). Both are worse than a column.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column script_id  uuid references scripts(id)  on delete cascade,
  add column concept_id uuid references concepts(id) on delete cascade;

comment on column cost_ledger.script_id is
  'Set on LLM spend that produced this script. Drafting, and later re-drafting, is money '
  'spent before a single shot exists — attributing it to the script is what makes '
  'cost-per-video include the part that happened before any video did.';

comment on column cost_ledger.concept_id is
  'Set on every drafting call, alongside script_id when a script came out of it. Set '
  'alone when one did not: a refused or truncated draft is billed and produced nothing, '
  'and spend with no row is the one accounting failure this project cannot tolerate.';

create index on cost_ledger (script_id)  where script_id  is not null;
create index on cost_ledger (concept_id) where concept_id is not null;

alter table cost_ledger
  drop constraint cost_ledger_has_subject;

alter table cost_ledger
  add constraint cost_ledger_has_subject
  check (generation_id is not null or render_id is not null
         or script_id is not null or concept_id is not null);

-- ─────────────────────────────────────────────────────────────
-- 2. Retries must not double-write here either
--
-- The generation key is (generation_id, entry_kind). This one carries `unit` as well,
-- and the asymmetry is deliberate rather than an oversight: one LLM call is priced at two
-- different rates — input tokens and output tokens are 5× apart — so it writes two rows.
--
-- The alternative, one row with unit='token' and a blended cost, would make
-- quantity × unit_cost ≠ cost_usd on the ledger's own arithmetic. A ledger whose rows do
-- not multiply out is a ledger nobody can check.
-- ─────────────────────────────────────────────────────────────

create unique index cost_ledger_script_entry_key
  on cost_ledger (script_id, entry_kind, unit)
  where script_id is not null;

-- Failed drafts have no such key, and must not get one by concept: two refusals on the
-- same concept are two real charges, not a duplicate. What has to be idempotent is the
-- *retry* of a single task run, so the caller supplies a key derived from the run.
--
-- CLAUDE.md rule 6 already requires this of every generation; the ledger simply had
-- nowhere to record it for spend that is not a generation.
alter table cost_ledger
  add column idempotency_key text;

comment on column cost_ledger.idempotency_key is
  'Caller-supplied, for ledger rows with no natural key — currently failed drafts, which '
  'are charged to a concept and can legitimately recur. Derived from the task run id, '
  'which is stable across attempts, so a retried attempt lands on the same row.';

create unique index cost_ledger_idempotency_key_uniq
  on cost_ledger (idempotency_key)
  where idempotency_key is not null;

-- ─────────────────────────────────────────────────────────────
-- 3. rate_card's key is missing `unit`
--
-- 0002 keyed it (driver, model, effective_from); 0003 added endpoint. Neither includes
-- unit, which was harmless while every rate was priced in exactly one thing — credits per
-- generation, seconds of video. An LLM call is priced in two: input tokens and output
-- tokens, same driver, same model, same endpoint, same date, 5× apart.
--
-- So the two rows below collide, and `on conflict do nothing` silently keeps one of them.
-- Found by inserting them and counting, not by reading the constraint: the failure mode
-- is not an error, it is a rate card that looks populated and prices half the call.
-- ─────────────────────────────────────────────────────────────

drop index rate_card_driver_model_endpoint_effective_key;

-- coalesce for the same reason 0003 used it: endpoint is nullable and NULLs never compare
-- equal, so a plain constraint would permit unlimited duplicate NULL-endpoint rows — the
-- exact case it exists to forbid.
create unique index rate_card_driver_model_endpoint_unit_effective_key
  on rate_card (driver, model, coalesce(endpoint, ''), unit, effective_from);

-- ─────────────────────────────────────────────────────────────
-- 4. Published rates for the drafting model
--
-- In the migration rather than seed.sql on purpose. seed.sql is local-only and explicitly
-- "never runs against production"; that is right for placeholder credit rates that have to
-- be replaced with an observed balance delta, but wrong for these. A published list price
-- is the same number in every environment, and a production database that cannot price a
-- call refuses to make it (rule 5) — so shipping these as data is what lets stage 3 run at
-- all after a deploy.
--
-- These are the only is_verified rows in rate_card, and the reason is narrow: the vendor
-- publishes the number. Every video rate stays unverified until someone watches a credit
-- balance move, because nobody publishes those.
--
-- unit_cost is per single token, not per million — the ledger multiplies quantity by
-- unit_cost and quantity is a token count.
-- ─────────────────────────────────────────────────────────────

insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('anthropic', 'claude-opus-5', '/v1/messages', 'input_token',  0.000005, 'USD', true,
   'Published list price: USD 5.00 per 1M input tokens. Read from Anthropic''s pricing '
   'table on 2026-08-01. effective_from is epoch rather than the date the price took '
   'effect, which is not published — it means "as far back as this project priced '
   'anything", and a later rate supersedes it by inserting a row, never by UPDATE.',
   '1970-01-01T00:00:00Z'),
  ('anthropic', 'claude-opus-5', '/v1/messages', 'output_token', 0.000025, 'USD', true,
   'Published list price: USD 25.00 per 1M output tokens. Read from Anthropic''s pricing '
   'table on 2026-08-01. Same note on effective_from as the input row.',
   '1970-01-01T00:00:00Z')
on conflict (driver, model, coalesce(endpoint, ''), unit, effective_from) do nothing;

-- Cache reads and cache writes are priced differently again, and are deliberately absent.
-- Stage 3 does not use prompt caching, and a rate card row for a call nobody makes is a
-- number waiting to be wrong.

-- ─────────────────────────────────────────────────────────────
-- 5. Fold script spend into the cost views
--
-- Two changes to v_script_cost, both to stop understating:
--
--   The FROM was `shots`, so a script with no shots yet produced no row at all — which is
--   the exact state a script is in the moment after it is drafted and charged. It now
--   starts from `scripts`.
--
--   Drafting cost is added to generation cost. The two are aggregated in separate
--   subqueries rather than in one join: joining shots→generations→cost_ledger and
--   script-attributed cost_ledger rows in a single query fans the rows out and sums the
--   draft cost once per generation.
--
-- The third term is the modelling choice. Draft spend charged to a concept with no script
-- — a refusal, a truncation — belongs to the video that concept eventually became, but
-- there is no row saying which script that is. It is attributed to the *lowest-version*
-- script of the concept, so it is counted exactly once no matter how many redrafts follow.
--
-- That is a decision, not a fact. It makes the first version of a script look more
-- expensive than the second, which is true in the sense that the failures happened on the
-- way to it, and false in the sense that version 2 benefited from them. The alternative —
-- leaving it out of v_script_cost — makes cost-per-video quietly exclude money that was
-- actually spent, and this project's headline metric is the one number that must not
-- flatter itself.
-- ─────────────────────────────────────────────────────────────

drop view if exists v_cost_per_1k_views;
drop view if exists v_render_cost;
drop view if exists v_script_cost;

create view v_script_cost as
select
  sc.id as script_id,
  coalesce(gen.cost_inr, 0) + coalesce(draft.cost_inr, 0)  as cost_inr,
  coalesce(gen.cost_inr, 0)                                as generation_cost_inr,
  coalesce(draft.cost_inr, 0)                              as draft_cost_inr,
  coalesce(gen.generations_used, 0)                        as generations_used,
  coalesce(gen.generations_wasted, 0)                      as generations_wasted
from scripts sc
left join lateral (
  select
    sum(cl.cost_inr)                                        as cost_inr,
    count(distinct g.id)                                    as generations_used,
    count(distinct g.id) filter (where g.status = 'failed') as generations_wasted
  from shots s
  left join generations g  on g.shot_id = s.id
  left join cost_ledger cl on cl.generation_id = g.id
  where s.script_id = sc.id
) gen on true
left join lateral (
  select
    coalesce((
      select sum(cl.cost_inr) from cost_ledger cl where cl.script_id = sc.id
    ), 0)
    + case when sc.version = (
        select min(v.version) from scripts v where v.concept_id = sc.concept_id
      ) then coalesce((
        select sum(cl.cost_inr)
        from cost_ledger cl
        where cl.concept_id = sc.concept_id and cl.script_id is null
      ), 0) else 0 end
    as cost_inr
) draft on true;

comment on view v_script_cost is
  'Everything a script has cost, counted once: the LLM call that drafted it plus every '
  'generation against its shots, including wasted ones. A reshoot that cost money and '
  'produced nothing is part of what the script cost. The two components stay separately '
  'visible because they answer different questions — draft cost is fixed per script, '
  'generation cost is what a longer video buys.';

-- Unchanged from 0003 apart from reading the widened v_script_cost. The divisor and the
-- LEFT JOIN are both load-bearing; see the notes on FIX 4 and FIX 5 there.
create view v_render_cost as
select
  r.id        as render_id,
  r.script_id,
  coalesce(vsc.cost_inr, 0) / nullif(count(*) over (partition by r.script_id), 0)
    + coalesce((select sum(cl.cost_inr) from cost_ledger cl where cl.render_id = r.id), 0)
    as cost_inr,
  coalesce(vsc.generations_used, 0)   as generations_used,
  coalesce(vsc.generations_wasted, 0) as generations_wasted
from renders r
left join v_script_cost vsc on vsc.script_id = r.script_id
where r.kind = 'final';

comment on view v_render_cost is
  'Cost attributable to one final render, now including its share of the drafting call. '
  'Script-level spend is divided across the final renders of the same script because '
  'variants share it; SUM over this column is meaningful, SUM over an undivided one '
  'would not be. Rough cuts are excluded — they are a review artifact, not an output.';

create view v_cost_per_1k_views as
select
  p.id as publication_id,
  vrc.cost_inr,
  ms.views,
  case when ms.views > 0 then vrc.cost_inr / (ms.views / 1000.0) end as cost_per_1k_views
from publications p
join v_render_cost vrc     on vrc.render_id = p.render_id
join metrics_snapshots ms  on ms.publication_id = p.id and ms.age_bucket = '7d';

comment on view v_cost_per_1k_views is
  'The only number that touches the business question.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0006', 'llm_cost_attribution', array['-- applied from a lean bundle; text in supabase/migrations/0006_llm_cost_attribution.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0007_vault_secrets_and_onboarding_progress.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0007 vault_secrets_and_onboarding_progress'; end $kiln_progress$;

-- Migration 0007 — Vault-backed secrets, and onboarding progress that is a set
--
-- Three schema assumptions from 0003 and 0005 do not survive contact with the actual
-- onboarding actions. All three are the same shape as the two 0006 found: a column
-- designed against one case, used by another.
--
--   1. `integrations.vault_secret_id` and `integrations.last_4` are singular. The
--      integration catalogue declares up to three secret fields for one vendor.
--   2. `profiles.onboarding_step` is an int, so it can only describe a line. The wizard's
--      own dependency graph is not a line — 7 is optional and sits between two required
--      steps, and 4 and 5 both depend on 2 rather than on each other.
--   3. Nothing could read or write Vault at all. 0003 says credentials move out of
--      environment variables and into the database; no path existed to put them there.

-- ─────────────────────────────────────────────────────────────
-- 1. One row per secret field, not one per integration
--
-- The video vendor has three: an API key, an API secret, and a webhook secret. They are
-- rotated independently, they fail differently, and "which one is wrong?" is the first
-- question after a 401. A single vault_secret_id cannot answer it, and a single last_4
-- displays one of three keys with no indication which.
-- ─────────────────────────────────────────────────────────────

create table integration_secrets (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  -- Matches SecretFieldDescriptor.key in src/lib/drivers/catalog.ts. Deliberately the
  -- env-var name: the same credential reached the same driver through the environment
  -- before it reached it through here, and one name for one secret is worth more than a
  -- tidier one.
  field_key      text not null,
  vault_secret_id uuid not null,
  -- The only part of a secret that ever leaves the database. Four characters is enough to
  -- answer "is this the key I think it is?" and not enough to be one.
  last_4         text not null,
  configured_at  timestamptz not null default now(),
  rotated_at     timestamptz,
  unique (integration_id, field_key)
);

comment on table integration_secrets is
  'Pointers into Supabase Vault, one per credential field. The plaintext is never a '
  'column here and never crosses to the browser: the settings UI is built from last_4 '
  'and configured_at, which is why the fields are write-only in the interface.';

create index on integration_secrets (integration_id);

-- Superseded, and dropped rather than left in place. Two sources of truth for "which key
-- is configured" is how one of them goes stale silently; nothing reads these yet, so this
-- is the cheapest moment there will ever be to remove them.
alter table integrations
  drop column vault_secret_id,
  drop column last_4;

-- ─────────────────────────────────────────────────────────────
-- 2. Vault access, as two functions and no direct grant
--
-- PostgREST exposes only the `public` schema, so `vault.decrypted_secrets` is unreachable
-- from a client — which is correct and must stay that way. These wrappers are the only
-- door, and they are bolted shut against every role except `service_role`.
--
-- That grant is the whole security model here, so it is worth being explicit about why.
-- Phase 1 has no RLS policies (0003 decision record), which means the anon key — the one
-- inlined into the client bundle and readable in DevTools — can call any `public` function
-- it is granted. A readable-by-default secret reader would put every vendor credential one
-- fetch away from anyone who loaded the page.
--
-- Written with dynamic EXECUTE so the function bodies compile on a plain Postgres where
-- the `vault` schema does not exist — same constraint that kept a hard FK off
-- `profiles.id` in 0005, and the same reason: the migration sequence has to be runnable in
-- CI. The extension is never created here. If it is absent, the call says so and stops.
-- ─────────────────────────────────────────────────────────────

create or replace function public.assert_vault_available()
returns void
language plpgsql
as $$
begin
  if to_regnamespace('vault') is null then
    raise exception
      'Supabase Vault is not installed on this database. Every vendor credential is '
      'stored through it, so nothing can be configured until it exists. Enable the '
      'supabase_vault extension in the dashboard — this migration deliberately does not '
      'enable it for you, because silently turning on an extension that manages '
      'encryption keys is not a decision a migration should make.';
  end if;
end;
$$;

/*
 * Store or rotate one credential field. Returns last_4 — the only thing the caller is
 * allowed to learn about the value it just wrote, which keeps the write path and the read
 * path honest about being different privileges.
 */
create or replace function public.integration_secret_put(
  p_integration_id uuid,
  p_field_key      text,
  p_secret         text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_new      uuid;
  v_name     text;
  v_last4    text;
begin
  perform public.assert_vault_available();

  if p_secret is null or length(trim(p_secret)) = 0 then
    raise exception 'Refusing to store an empty secret for %', p_field_key;
  end if;

  v_name  := format('integration:%s:%s', p_integration_id, p_field_key);
  v_last4 := right(p_secret, 4);

  select s.vault_secret_id into v_existing
  from public.integration_secrets s
  where s.integration_id = p_integration_id and s.field_key = p_field_key;

  if v_existing is null then
    execute 'select vault.create_secret($1, $2, $3)'
      into v_new
      using p_secret, v_name, 'Kiln integration credential';

    insert into public.integration_secrets (integration_id, field_key, vault_secret_id, last_4)
    values (p_integration_id, p_field_key, v_new, v_last4);
  else
    execute 'select vault.update_secret($1, $2, $3, $4)'
      using v_existing, p_secret, v_name, 'Kiln integration credential';

    update public.integration_secrets
    set last_4 = v_last4, rotated_at = now()
    where integration_id = p_integration_id and field_key = p_field_key;
  end if;

  return v_last4;
end;
$$;

/*
 * Read every credential field for one integration, as plaintext.
 *
 * The single most dangerous function in the schema. It exists because a driver has to be
 * constructed from real credentials somewhere, and "somewhere" is a Trigger container or a
 * Server Action holding the service-role key. It is never called from anything a browser
 * can reach.
 */
create or replace function public.integration_secrets_read(p_integration_id uuid)
returns table (field_key text, secret text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_vault_available();

  return query execute $q$
    select s.field_key, d.decrypted_secret
    from public.integration_secrets s
    join vault.decrypted_secrets d on d.id = s.vault_secret_id
    where s.integration_id = $1
  $q$ using p_integration_id;
end;
$$;

/* Forget a credential entirely — rotation's other half. */
create or replace function public.integration_secret_delete(
  p_integration_id uuid,
  p_field_key      text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.assert_vault_available();

  delete from public.integration_secrets
  where integration_id = p_integration_id and field_key = p_field_key
  returning vault_secret_id into v_id;

  if v_id is null then return false; end if;

  execute 'delete from vault.secrets where id = $1' using v_id;
  return true;
end;
$$;

-- The grants. `public` first, because PostgreSQL grants EXECUTE on new functions to
-- PUBLIC by default and a function that is merely undocumented is not a function that is
-- unreachable.
revoke all on function public.integration_secret_put(uuid, text, text)    from public;
revoke all on function public.integration_secrets_read(uuid)              from public;
revoke all on function public.integration_secret_delete(uuid, text)       from public;
revoke all on function public.assert_vault_available()                    from public;

do $$
begin
  -- These roles exist on Supabase and not on a plain Postgres. Guarded rather than
  -- assumed, so the sequence still applies in CI.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.integration_secret_put(uuid, text, text) to service_role';
    execute 'grant execute on function public.integration_secrets_read(uuid) to service_role';
    execute 'grant execute on function public.integration_secret_delete(uuid, text) to service_role';
  end if;

  -- Explicitly not granted to anon or authenticated, and this is the line that matters.
  -- With no RLS in Phase 1, a grant here would make every vendor credential readable by
  -- anyone holding the anon key, which is everyone who loaded the page.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.integration_secrets_read(uuid) from anon';
    execute 'revoke all on function public.integration_secret_put(uuid, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.integration_secrets_read(uuid) from authenticated';
    execute 'revoke all on function public.integration_secret_put(uuid, text, text) from authenticated';
  end if;
end;
$$;

-- Table grants matter for the same reason. The table holds no plaintext, but last_4 and
-- the vault pointer are not public business either.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.integration_secrets to service_role';
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- 3. Onboarding progress is a set, not a number
--
-- `onboarding_step int` describes a line. The wizard is a graph: 4 and 5 both depend on 2
-- and not on each other, 7 is optional and sits between two required steps, and 8 depends
-- only on 1. Someone who passes 1, 2, 3 and 8 but stalls on 4 has completed four steps
-- and has no honest integer to write.
--
-- The array is the truth. `onboarding_step` stays, demoted to a display value and
-- maintained by a trigger so it cannot drift from the array it summarises — the gate now
-- reads the array, so a wrong integer would be a cosmetic bug rather than an unlocked app.
-- ─────────────────────────────────────────────────────────────

alter table profiles
  add column onboarding_completed_steps int[] not null default '{}';

comment on column profiles.onboarding_completed_steps is
  'Which onboarding steps have passed a real verification. The gate compares this against '
  'REQUIRED_STEPS as a set. A failed check writes nothing here — that is the whole '
  'mechanism by which a failed check cannot advance the gate.';

-- Backfill from the integer for any row that predates the array. 1..step, which is what
-- the integer meant when it was written.
update profiles
set onboarding_completed_steps = (
  select coalesce(array_agg(n order by n), '{}') from generate_series(1, onboarding_step) n
)
where onboarding_step > 0;

create or replace function public.sync_onboarding_step()
returns trigger
language plpgsql
as $$
begin
  new.onboarding_step := coalesce(
    (select max(n) from unnest(new.onboarding_completed_steps) n), 0
  );
  return new;
end;
$$;

create trigger profiles_sync_onboarding_step
  before insert or update of onboarding_completed_steps on profiles
  for each row execute function public.sync_onboarding_step();

comment on column profiles.onboarding_step is
  'Highest step completed. DERIVED — maintained by profiles_sync_onboarding_step from '
  'onboarding_completed_steps, which is the actual record. Display only; the gate reads '
  'the array, because an integer cannot express a dependency graph.';

-- ─────────────────────────────────────────────────────────────
-- 4. An integration must be able to say it is unusable
--
-- 0003 gives integrations `last_verified_at` and `last_error`, and comments that a
-- pipeline task must refuse to select one that has never verified. There is nothing
-- recording *when the check was attempted and failed* as distinct from never running —
-- a null last_verified_at means both "never tried" and "tried and failed", and the
-- onboarding UI has to tell those apart because they are different instructions to the
-- person reading it.
-- ─────────────────────────────────────────────────────────────

alter table integrations
  add column last_checked_at timestamptz;

comment on column integrations.last_checked_at is
  'When a check last ran, pass or fail. With last_verified_at this distinguishes the '
  'three states the UI must show: never run (both null), failed (checked but not '
  'verified since), verified. Two booleans would have collapsed into one by now.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0007', 'vault_secrets_and_onboarding_progress', array['-- applied from a lean bundle; text in supabase/migrations/0007_vault_secrets_and_onboarding_progress.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0008_credit_purchases_and_concurrency.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0008 credit_purchases_and_concurrency'; end $kiln_progress$;

-- Migration 0008 — the credit expiry clock, and a concurrency ceiling that admits it is a guess
--
-- Two rulings, both correcting probes that were reporting a permanent failure for something
-- the vendor does not expose.
--
--   1. The credit balance is not readable — the SDK has no account surface — and a
--      permanent red X for something unknowable is noise, not honesty. The balance was
--      never the point anyway: the *expiry clock* was. So it becomes an entry, like the
--      rate card: a number only the account holder can see.
--
--   2. The plan tier read is a guess against documentation. It stops gating step 5, and
--      the concurrency ceiling falls back to a deliberately low default that is labelled
--      as a default rather than presented as a reading.

-- ─────────────────────────────────────────────────────────────
-- 1. Credit purchases
--
-- A table, not two columns on `integrations`, and the reason is the clock itself. Credits
-- expire per *purchase*, roughly 90 days from the day they were bought. Two top-ups are two
-- clocks running at once, and a single `credits_purchased` / `purchased_at` pair silently
-- becomes wrong the second time anyone buys credits — which is the first thing that will
-- happen, and the failure is invisible: the screen shows one confident expiry date that is
-- the wrong one.
--
-- `expiry_days` is per row rather than a constant because "roughly 90 days" is the
-- observed behaviour, not a published term. When a real expiry date is seen on an invoice,
-- correcting that row should not require a migration.
-- ─────────────────────────────────────────────────────────────

create table credit_purchases (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  credits        numeric not null check (credits > 0),
  purchased_at   date not null,
  -- Observed, not published. See the note above.
  expiry_days    int not null default 90 check (expiry_days > 0),
  amount_usd     numeric check (amount_usd is null or amount_usd >= 0),
  note           text,
  created_at     timestamptz not null default now(),

  -- Generated rather than computed in the app: every screen that shows a countdown must
  -- agree with every other, and a date arithmetic helper duplicated across three
  -- components will not.
  -- `date + integer` and not `date + '<n> days'::interval`: the text-to-interval cast is
  -- only STABLE, and Postgres rejects a non-immutable generation expression. Integer
  -- addition on a date is immutable and means exactly the same thing.
  expires_at     date generated always as (purchased_at + expiry_days) stored
);

comment on table credit_purchases is
  'Manual entry. The vendor SDK exposes no balance or account endpoint, and guessing an '
  'undocumented REST path to report a confident-looking number is worse than asking. One '
  'row per purchase because credits expire per purchase — two top-ups are two clocks.';

comment on column credit_purchases.expires_at is
  'Generated. The expiry clock is the whole reason this table exists: nothing is billed at '
  'the moment credits evaporate, so it is a cost the ledger structurally cannot see.';

comment on column credit_purchases.amount_usd is
  'What the credits cost, if known. Optional, and worth filling in — credits ÷ dollars is '
  'the only route to a verified per-credit rate, which is what unblocks onboarding step 6.';

create index on credit_purchases (integration_id, expires_at);

-- Total credits not yet expired, and the soonest clock still running.
create view v_credit_position as
select
  i.id                                       as integration_id,
  i.slug,
  coalesce(sum(cp.credits) filter (where cp.expires_at >= current_date), 0) as credits_unexpired,
  coalesce(sum(cp.credits) filter (where cp.expires_at <  current_date), 0) as credits_expired,
  min(cp.expires_at) filter (where cp.expires_at >= current_date)           as next_expiry,
  min(cp.expires_at) filter (where cp.expires_at >= current_date) - current_date
                                                                           as days_until_expiry,
  max(cp.purchased_at)                                                     as last_purchase_at
from integrations i
left join credit_purchases cp on cp.integration_id = i.id
group by i.id, i.slug;

comment on view v_credit_position is
  'What is left and when the nearest tranche dies. credits_expired is shown too, because '
  '"you lost 400 credits last month" is the number that changes purchasing behaviour and '
  'it never appears in the cost ledger — nothing is billed when credits evaporate.';

-- ─────────────────────────────────────────────────────────────
-- 2. Concurrency ceiling, and whether it was read or assumed
--
-- The queue reads a parallel-request limit. Where that number came from decides how much
-- to trust it, and until now there was nowhere to record the difference between "the
-- vendor told us" and "we picked a safe number".
--
-- Direction of the guess is not symmetric, which is the whole argument for a low default.
-- Guessing high produces a steady failure rate that reads as an unreliable vendor and
-- sends someone debugging the wrong system for a day. Guessing low is just slow.
-- ─────────────────────────────────────────────────────────────

alter table integrations
  add column concurrency_limit    int check (concurrency_limit is null or concurrency_limit > 0),
  add column concurrency_source   text not null default 'default'
    check (concurrency_source in ('default', 'tier', 'manual'));

comment on column integrations.concurrency_limit is
  'Parallel requests the queue may have in flight. Null means nothing has established one '
  'and the caller applies the conservative default.';

comment on column integrations.concurrency_source is
  'default = nobody established it, a safe floor is in use. tier = read from the account '
  'during verification. manual = someone typed it. Recorded because a limit that was '
  'guessed and a limit that was read deserve different confidence, and a screen that '
  'cannot tell them apart will present the guess as fact.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0008', 'credit_purchases_and_concurrency', array['-- applied from a lean bundle; text in supabase/migrations/0008_credit_purchases_and_concurrency.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0009_shot_vo_span_and_compile_state.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0009 shot_vo_span_and_compile_state'; end $kiln_progress$;

-- Migration 0009 — shots need to say which words they cover, and whether they compiled
--
-- Three gaps found while building stage 4. Two are the usual shape — a design correct for
-- the case in front of it, used by a stage that arrived later. Section 1 is not: it is a
-- specification error, of the same class as `cost_ledger_has_subject` in 0006.
--
-- The distinction is worth keeping because the fixes differ. Evolution you absorb;
-- a spec that contradicts itself on its own page you catch by re-reading before writing
-- the schema.

-- ─────────────────────────────────────────────────────────────
-- 1. A shot has to know which speech it covers
--
-- ** A SPECIFICATION ERROR, not an evolution. **
--
-- Addendum 02 §1 specifies that word timings derive shot durations, and the schema it
-- specifies gives `shots` no link to a range of speech. It was uncomputable as written, on
-- the page that wrote it — the same class of mistake as `cost_ledger_has_subject` in 0006,
-- where a constraint was written without checking it against a stage the same document
-- already described.
--
-- Migration 0004 encoded that inversion faithfully: voice runs ahead of video, word timings
-- define the beat boundaries, and those boundaries set `shots.duration_s` with
-- `duration_source = 'derived_from_vo'`. Faithful to a spec that could not be implemented.
--
-- The assumption underneath is that shots and beats are one-to-one. They are not, and stage
-- 4 is where that becomes obvious: a 3-beat script routinely wants 5 or 6 shots, because a
-- beat is an argument and a shot is a camera. The first real run split one beat into a slow
-- wide and a fast cut. As soon as one beat produces two shots, "the beat's word timings set
-- the shot's duration" has no answer for which half of the words belongs to which.
--
-- Character offsets into `scripts.vo_text` rather than a beat index, because `vo_text` is
-- the exact string sent for synthesis and word timings come back aligned to it. A beat
-- index would need re-resolving to characters anyway, through the same joining rules that
-- built vo_text, and any drift there silently mistimes the video.
--
-- Nullable: a shot may deliberately cover no speech — an establishing frame, a cut to a
-- product shot under a pause. Those keep an authored duration and stage 6 leaves them
-- alone rather than deriving zero.
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column vo_char_start int,
  add column vo_char_end   int;

alter table shots
  add constraint shots_vo_span_valid
  check (
    (vo_char_start is null and vo_char_end is null)
    or (vo_char_start is not null and vo_char_end is not null
        and vo_char_start >= 0 and vo_char_end > vo_char_start)
  );

comment on column shots.vo_char_start is
  'Half-open character range [start, end) into scripts.vo_text that this shot is on screen '
  'for. The link stage 6 needs to turn word timings into a real duration. Null means the '
  'shot covers no speech and keeps its authored duration.';

create index on shots (script_id, vo_char_start);

-- ─────────────────────────────────────────────────────────────
-- 2. "Not compiled" and "could not be compiled" are different states
--
-- `prompt_id` and `compiled_params` are both nullable, and null means both "stage 4 has
-- not run" and "stage 4 ran and found no library prompt for this shot". Those are
-- different instructions — wait, versus go and discover a recipe — and a stuck video is
-- exactly when someone needs to know which they are looking at.
--
-- The same distinction `last_checked_at` bought for integrations in 0007. It keeps
-- arriving because a nullable result column can only ever encode two of the three states
-- any attempted operation actually has.
--
-- CLAUDE.md is explicit that production reads the prompt library and never improvises, so
-- "no matching prompt" is a legitimate, expected outcome rather than an error. It has to be
-- recordable without pretending a shot failed.
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column compiled_at    timestamptz,
  add column compile_note   text;

comment on column shots.compiled_at is
  'When compiled_params was last written. With compile_note this separates never-compiled '
  '(both null) from compiled (set) from attempted-and-unresolved (note set, compiled_at '
  'null) — which is the normal state for a shot whose recipe is not in the library yet.';

comment on column shots.compile_note is
  'Why compilation did not produce params: which tags were sought, what the library had. '
  'Production reads the library and never improvises (CLAUDE.md), so an empty library is a '
  'expected outcome with a next action, not a failure.';

-- ─────────────────────────────────────────────────────────────
-- 3. Shots that are ready to generate
--
-- The precondition stage 5 checks, in one place, so it cannot be spelled differently in
-- two. A shot is generatable when a library prompt was resolved and its params compiled.
-- ─────────────────────────────────────────────────────────────

create view v_shot_readiness as
select
  s.id            as shot_id,
  s.script_id,
  s.idx,
  s.status,
  s.duration_s,
  s.duration_source,
  s.prompt_id is not null and s.compiled_params is not null as generatable,
  s.compile_note,
  s.vo_char_start is not null                               as covers_speech
from shots s;

comment on view v_shot_readiness is
  'One row per shot: can stage 5 submit this? Generatable requires a resolved library '
  'prompt and compiled params — never improvised ones.';

-- ─────────────────────────────────────────────────────────────
-- 4. A script is charged by more than one stage
--
-- 0006 keyed LLM spend on (script_id, entry_kind, unit) so a retry could not double-charge
-- a drafting call. That was right for the only stage charging a script at the time.
--
-- Stage 4 charges the same script for the shotlist call, and the key rejects it — the two
-- rows collide with stage 3's. The first workaround was to route stage 4's *successful*
-- charge through the failed-draft path, which has a run-scoped key; that works and is a
-- lie, because a discriminator reading `failed_draft` on a successful call is a trap for
-- whoever queries it next.
--
-- The missing dimension is which stage spent the money. Adding it also makes cost-per-stage
-- answerable, which is a question the headline metric will want long before it is asked:
-- "is drafting or shot-listing the expensive part?" currently has no query.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column stage text;

comment on column cost_ledger.stage is
  'Pipeline stage that spent this, matching the src/trigger/ file name — 03-script, '
  '04-shotlist. Null on spend that is not attributable to a numbered stage. Part of the '
  'idempotency key, because two stages legitimately charge the same script.';

drop index cost_ledger_script_entry_key;

create unique index cost_ledger_script_stage_entry_key
  on cost_ledger (script_id, coalesce(stage, ''), entry_kind, unit)
  where script_id is not null;

create index on cost_ledger (stage) where stage is not null;

-- Existing rows predate the column and all came from stage 3.
update cost_ledger set stage = '03-script' where script_id is not null and stage is null;

create view v_cost_by_stage as
select
  stage,
  count(*)                          as entries,
  sum(cost_usd)                     as cost_usd,
  sum(cost_inr)                     as cost_inr
from cost_ledger
where stage is not null
group by stage;

comment on view v_cost_by_stage is
  'Which stage the money went to. Cheap to add now, and the first thing anyone asks when '
  'cost per video is higher than expected.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0009', 'shot_vo_span_and_compile_state', array['-- applied from a lean bundle; text in supabase/migrations/0009_shot_vo_span_and_compile_state.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0010_prompt_library.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0010 prompt_library'; end $kiln_progress$;

-- Migration 0010 — the prompt library becomes selectable, and shots say what they need
--
-- One finding, and it is the evolution kind rather than the specification kind.
--
-- `shots` was designed before there was a library to select from, so it carries a
-- description and nothing categorical. That was complete for its own purposes and
-- incomplete the moment compilation had more than one recipe to choose between: matching a
-- free-text description against a template is a guess, and the fallback ("first entry for
-- this driver") would compile all six shots of a video to the same camera. Nothing in the
-- spec was wrong; a new consumer needed a signal the producer had no reason to emit.

-- ─────────────────────────────────────────────────────────────
-- 1. A shot says what kind of frame it is
--
-- Closed vocabulary, mirrored in src/lib/shots/kinds.ts and enforced here so the two
-- cannot drift. Editorial rather than technical — what the frame *is*, not how a vendor
-- makes it — which keeps a second vendor's library a set of new rows rather than a new
-- vocabulary.
--
-- Nullable, because shots written before this migration have no kind and inventing one for
-- them would be a guess recorded as a fact. Those rows simply do not match any recipe and
-- appear in v_unresolved_shots saying so.
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column shot_kind text
    check (shot_kind is null or shot_kind in (
      'establishing', 'subject_medium', 'detail_macro', 'action_insert',
      'environment_move', 'abstract', 'graphic_plate'
    ));

comment on column shots.shot_kind is
  'What kind of frame this is, from the closed vocabulary in src/lib/shots/kinds.ts. The '
  'signal compilation matches against prompts.tags. Null on shots written before the '
  'library existed — they match nothing, and say so, rather than being assigned a guess.';

create index on shots (shot_kind) where shot_kind is not null;

-- ─────────────────────────────────────────────────────────────
-- 2. The library gets an identity and a lifecycle
--
-- `prompts` had no key beyond its uuid, so "name X version 2" could exist twice and a
-- lookup would depend on scan order — the same defect 0002 fixed on rate_card, for the
-- same reason: this table decides what gets generated and what it costs.
--
-- Retirement is a flag, never a delete. `shots.prompt_id` references this table with no
-- ON DELETE clause, so Postgres already refuses to remove a referenced recipe — which is
-- correct and is a error message rather than a workflow. A retired recipe stops being
-- selected, keeps its rows, and keeps whatever win_rate it earned.
-- ─────────────────────────────────────────────────────────────

alter table prompts
  add column is_active  boolean not null default true,
  add column retired_at timestamptz,
  add column retired_reason text;

-- One row per (name, version). Editing a recipe adds a version; it never mutates one,
-- because shots.compiled_params snapshots what was used and win_rate is earned by a
-- specific set of parameters. Rewriting a recipe in place would make both meaningless.
create unique index prompts_name_version_key on prompts (name, version);

create index on prompts (driver, is_active) where is_active;
create index on prompts using gin (tags);

comment on column prompts.is_active is
  'False = retired. Not selected by compilation, never deleted. A recipe that produced a '
  'clip you shipped is evidence about how that clip was made.';

comment on column prompts.win_rate is
  'Backfilled from generation success and QA outcomes. Deliberately null until generations '
  'exist — ranking over an all-null column is a coin toss wearing a confident interface, '
  'so compilation orders by it only where it is present.';

-- Provenance. CLAUDE.md: a recipe discovered in an exploratory MCP session is persisted
-- here with discovered_in='claude-code-mcp' and the exact params. Constrained so the field
-- stays groupable — "where did our working recipes come from?" is answerable only if the
-- answer is from a closed set.
alter table prompts
  add constraint prompts_discovered_in_check
  check (discovered_in is null or discovered_in in ('claude-code-mcp', 'manual', 'imported'));

-- A recipe without the parameters it was proven with is worthless: the template alone does
-- not reproduce the clip, and a row that looks like a recipe and cannot reproduce anything
-- is worse than an empty library, because the library is trusted.
alter table prompts
  add constraint prompts_params_not_empty
  check (params is not null and params <> '{}'::jsonb);

comment on column prompts.params is
  'The exact vendor parameters the recipe was proven with, verbatim as submitted. Not a '
  'summary and not defaults — motion, aspect, quality, seed policy, whatever was actually '
  'sent. Enforced non-empty: a recipe that cannot reproduce its own sample is not a recipe.';

-- ─────────────────────────────────────────────────────────────
-- 3. What is blocked, and what would unblock it
--
-- The worklist for an exploratory session: which shot kinds are waiting, how many shots
-- and scripts each is holding up, and whether any active recipe already serves it.
-- ─────────────────────────────────────────────────────────────

create view v_unresolved_shots as
select
  s.id                as shot_id,
  s.script_id,
  s.idx,
  s.shot_kind,
  s.description,
  s.duration_s,
  s.compile_note,
  c.title             as concept_title,
  ch.name             as channel_name,
  (select count(*) from prompts p
    where p.is_active and s.shot_kind is not null and s.shot_kind = any(p.tags))
                      as matching_recipes
from shots s
join scripts sc on sc.id = s.script_id
join concepts c  on c.id = sc.concept_id
join channels ch on ch.id = c.channel_id
where s.compiled_params is null;

comment on view v_unresolved_shots is
  'Every shot that cannot be generated, with what it is asking for. matching_recipes is '
  'zero when nothing in the library serves this kind — which is the queue for an '
  'exploratory session, not an error state.';

create view v_recipe_gaps as
select
  s.shot_kind,
  count(*)                        as shots_waiting,
  count(distinct s.script_id)     as scripts_blocked,
  sum(s.duration_s)               as seconds_waiting,
  (select count(*) from prompts p
    where p.is_active and s.shot_kind = any(p.tags)) as active_recipes
from shots s
where s.compiled_params is null and s.shot_kind is not null
group by s.shot_kind
order by count(*) desc;

comment on view v_recipe_gaps is
  'The exploratory session worklist, ordered by how much is blocked on each kind. A row '
  'with active_recipes = 0 is a kind nobody has a working recipe for yet.';

-- ─────────────────────────────────────────────────────────────
-- 4. v_shot_readiness has to say what the shot was asking for
--
-- 0009 created it one migration before `shot_kind` existed, so it answers "can stage 5
-- submit this?" without saying what would make the answer yes. That is half a view: the
-- reason a shot is not generatable is the actionable part, and having to join back to
-- `shots` for it means two places will spell the readiness rule differently within a month.
-- ─────────────────────────────────────────────────────────────

drop view v_shot_readiness;

create view v_shot_readiness as
select
  s.id            as shot_id,
  s.script_id,
  s.idx,
  s.status,
  s.shot_kind,
  s.duration_s,
  s.duration_source,
  s.prompt_id is not null and s.compiled_params is not null as generatable,
  s.compile_note,
  s.vo_char_start is not null                               as covers_speech,
  (select count(*) from prompts p
    where p.is_active and s.shot_kind is not null and s.shot_kind = any(p.tags))
                                                            as matching_recipes
from shots s;

comment on view v_shot_readiness is
  'One row per shot: can stage 5 submit this, and if not, what is missing. Generatable '
  'requires a resolved library prompt and compiled params — never improvised ones. '
  'matching_recipes = 0 means nothing in the library serves this kind yet.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0010', 'prompt_library', array['-- applied from a lean bundle; text in supabase/migrations/0010_prompt_library.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0011_recipe_usage_and_rotation.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0011 recipe_usage_and_rotation'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0011', 'recipe_usage_and_rotation', array['-- applied from a lean bundle; text in supabase/migrations/0011_recipe_usage_and_rotation.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0012_vo_stitching_and_durations.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0012 vo_stitching_and_durations'; end $kiln_progress$;

-- Migration 0012 — a VO take has to remember its request id, and how long it turned out
--
-- ** SECTION 1 IS A SPECIFICATION ERROR **, the same class as `shots.vo_char_start` in 0009
-- and `cost_ledger_has_subject` in 0006: a document that specifies a mechanism and a schema
-- that cannot carry it, on the same page.

-- ─────────────────────────────────────────────────────────────
-- 1. Stitching needs the request id back
--
-- Addendum 02 §2: *chunk long scripts to 200–500 words and stitch with
-- `previous_request_ids`/`next_request_ids`.* The `vo_takes` table specified in §1 of the
-- same addendum, and implemented faithfully in 0004, has nowhere to put a request id.
--
-- So the stitching is unimplementable as written. Chunk 2 has to send chunk 1's request id
-- to inherit its prosody; nothing recorded chunk 1's request id. Without it every chunk is
-- an independent generation, which is exactly the language-and-accent drift the chunking
-- exists to avoid — and the failure is not an error, it is a voice that changes halfway
-- through and sounds like two people.
--
-- Nullable because a take can predate the column, and because a single-chunk script never
-- stitches to anything.
-- ─────────────────────────────────────────────────────────────

alter table vo_takes
  add column request_id text;

comment on column vo_takes.request_id is
  'Returned by the synthesis call, sent as previous_request_ids on the next chunk so '
  'prosody carries across the seam. Without it each chunk is an independent generation '
  'and the voice drifts mid-script — which is not an error, just two people.';

create index on vo_takes (script_id, chunk_idx) where request_id is not null;

-- ─────────────────────────────────────────────────────────────
-- 2. How long the take actually is
--
-- Derived from the last word timing, stored because it is read constantly — every
-- subsequent chunk's `offset_s` is the running sum of the ones before it, and recomputing
-- that from a jsonb array on every read is both slow and a second place for the arithmetic
-- to be spelled differently.
--
-- This is the evolution kind, not the specification kind: 0004 stored the timings, which is
-- everything needed to *derive* the duration. Storing the derivation is a convenience that
-- only became obvious once something had to sum across chunks.
-- ─────────────────────────────────────────────────────────────

alter table vo_takes
  add column duration_s numeric check (duration_s is null or duration_s >= 0);

comment on column vo_takes.duration_s is
  'Length of this take, from the end of its last word timing. Stored rather than derived '
  'because offset_s of every later chunk is the running sum of these, and two spellings of '
  'that sum is one too many.';

-- The audio the take produced. 0004 wired asset_id but nothing guarantees a take that
-- claims timings also claims audio — and timings without audio is a timeline for a file
-- that does not exist.
alter table vo_takes
  add constraint vo_takes_timings_need_audio
  check (word_timings = '[]'::jsonb or asset_id is not null);

-- ─────────────────────────────────────────────────────────────
-- 3. The voice leg's own view of readiness
--
-- Whether a script's VO is complete, and whether the shot durations were derived from it
-- or are still the shotlist's estimates. Stage 5 must not generate video against an
-- authored duration when a real one is available — that is the whole point of the
-- audio-first inversion.
-- ─────────────────────────────────────────────────────────────

create view v_script_vo_status as
select
  sc.id                                                     as script_id,
  sc.vo_text,
  length(sc.vo_text)                                        as vo_chars,
  count(vt.id)                                              as takes,
  coalesce(sum(vt.duration_s), 0)                           as total_duration_s,
  coalesce(sum(vt.characters_billed), 0)                    as characters_billed,
  bool_and(vt.request_id is not null) filter (where vt.id is not null) as fully_stitched,
  (select count(*) from shots s where s.script_id = sc.id)  as shots,
  (select count(*) from shots s
     where s.script_id = sc.id and s.duration_source = 'derived_from_vo') as shots_timed
from scripts sc
left join vo_takes vt on vt.script_id = sc.id
group by sc.id, sc.vo_text;

comment on view v_script_vo_status is
  'Per script: how much VO exists and how many shots have had their durations derived from '
  'it rather than estimated. shots_timed < shots means video would be generated against a '
  'word-count guess while a real measurement was available.';

-- ─────────────────────────────────────────────────────────────
-- 4. A pronunciation rule is not a pronunciation dictionary
--
-- ** ANOTHER SPECIFICATION ERROR **, third of this class.
--
-- Addendum 02 §2 says both of these on one page: *max 3 dictionary locators per request*,
-- and *this belongs in settings as an editable table* — implemented in 0004 as
-- `pronunciations`, holding grapheme, kind, replacement and alphabet.
--
-- Those are rules. The API takes **locators**: a `pronunciation_dictionary_id` and a
-- `version_id` identifying a dictionary that has been uploaded to the vendor. There is no
-- path from a row of rules to a request, because the rules have to be uploaded *as a set*
-- first and the vendor's returned identifiers recorded. Nothing recorded them, so the
-- locators required by the same paragraph were unobtainable.
--
-- The rules table is right and stays. What was missing is the thing it uploads *to*.
-- ─────────────────────────────────────────────────────────────

create table pronunciation_dictionaries (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  language             text not null default 'en',
  -- Returned by the vendor on upload. Null until a sync has actually happened, which is
  -- the honest state for a dictionary that exists only locally.
  vendor_dictionary_id text,
  vendor_version_id    text,
  synced_at            timestamptz,
  -- Rules change locally; the uploaded copy does not until it is re-synced. This is what
  -- makes "the dictionary is out of date" answerable rather than guessed.
  rules_changed_at     timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  unique (name, language)
);

comment on table pronunciation_dictionaries is
  'A set of rules uploaded to the vendor as one dictionary. The API references dictionaries '
  'by locator, not by rule, so this is what makes the rules in `pronunciations` reachable '
  'from a synthesis request at all.';

comment on column pronunciation_dictionaries.vendor_version_id is
  'Uploading a changed dictionary mints a new version. Both halves of the locator are '
  'required by the API, and sending a stale version silently applies the old rules.';

alter table pronunciations
  add column dictionary_id uuid references pronunciation_dictionaries(id) on delete cascade;

comment on column pronunciations.dictionary_id is
  'Which uploaded set this rule belongs to. Null means the rule exists locally and is in '
  'no dictionary, so it is applied to nothing — visible rather than silently ignored.';

create index on pronunciations (dictionary_id) where dictionary_id is not null;

-- Only a synced dictionary can be sent, and only its most recent sync.
create view v_pronunciation_locators as
select
  d.id,
  d.name,
  d.language,
  d.vendor_dictionary_id,
  d.vendor_version_id,
  d.synced_at,
  (select count(*) from pronunciations p where p.dictionary_id = d.id) as rules,
  d.synced_at is null                                                  as never_synced,
  d.synced_at is not null and d.rules_changed_at > d.synced_at         as stale
from pronunciation_dictionaries d
where d.vendor_dictionary_id is not null and d.vendor_version_id is not null;

comment on view v_pronunciation_locators is
  'Dictionaries that can actually be sent with a request. `stale` means the local rules '
  'have changed since the upload, so the vendor would apply the previous set — which '
  'presents as a fix that did not take rather than as an error.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0012', 'vo_stitching_and_durations', array['-- applied from a lean bundle; text in supabase/migrations/0012_vo_stitching_and_durations.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0013_generation_ingest.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0013 generation_ingest'; end $kiln_progress$;

-- Migration 0013 — what stage 5 needs to ingest a generation honestly
--
-- Two findings, both the evolution kind. Nothing in the spec was wrong; two decisions taken
-- after these columns were written made them unable to say what they now have to say.

-- ─────────────────────────────────────────────────────────────
-- 1. `assets.r2_key` names a vendor that was dropped
--
-- ADR 0007 replaced Cloudflare R2 with Supabase Storage, and the column kept the old name.
-- It is not merely untidy: the storage layer exists so the object store is a config value
-- (CLAUDE.md rule 1), and a column named after one vendor is the exact assumption that
-- layer is built to prevent. Someone reading the schema learns the wrong thing about how
-- swappable storage is.
--
-- Cheap now — the table is empty. It stops being cheap the moment it is not.
-- ─────────────────────────────────────────────────────────────

alter table assets rename column r2_key to storage_key;

comment on column assets.storage_key is
  'Key within the configured bucket. Deliberately not named after a vendor: which object '
  'store is behind the StorageDriver interface is a config value, and this column outlived '
  'the first answer to it.';

-- ─────────────────────────────────────────────────────────────
-- 2. An asset has to say whether it was normalised, and from what
--
-- Addendum 02 §3: normalise on ingest, not at stitch — h264 / yuv420p / 1080x1920 / 30fps.
-- The reason is that a stitch is the wrong place to discover a clip is 24fps: by then every
-- other clip is already in place and the failure is a re-render of the whole timeline
-- rather than one download.
--
-- `assets` records what a file *is* and had no way to record what it *was*, so "did this
-- clip need conversion?" and "did conversion happen?" were both unanswerable. The second
-- matters most: an un-normalised clip that reaches the assembler looks identical to a
-- normalised one until ffmpeg refuses to concatenate it.
--
-- Three states again, from the same shape as everywhere else: never attempted (both null),
-- attempted and failed (`normalize_error` set), succeeded (`normalized_at` set).
-- ─────────────────────────────────────────────────────────────

alter table assets
  add column normalized_at   timestamptz,
  add column normalize_error text,
  add column source_meta     jsonb;

comment on column assets.source_meta is
  'What the vendor actually delivered, probed before conversion: codec, pixel format, '
  'dimensions, frame rate, duration. Kept because "the vendor changed its default output" '
  'is invisible without a record of what it used to send.';

comment on column assets.normalize_error is
  'Set when normalisation was attempted and failed. With normalized_at this separates '
  'never-attempted from failed from done — an un-normalised clip is indistinguishable from '
  'a normalised one until the assembler refuses to concatenate it.';

-- ─────────────────────────────────────────────────────────────
-- 3. A completion that was confirmed, versus one that was merely claimed
--
-- The webhook carries a shared secret, not a signature — there is nothing to verify
-- cryptographically (ADR 0004), so a leaked secret is a forged completion. The receiver
-- therefore confirms against the vendor's own status endpoint before writing anything.
--
-- `webhook_received_at` records that a callback arrived. This records that the vendor
-- independently agreed with it. They are different claims and only the second one licenses
-- writing an asset.
-- ─────────────────────────────────────────────────────────────

alter table generations
  add column confirmed_at timestamptz;

comment on column generations.confirmed_at is
  'When the vendor''s status endpoint independently confirmed the outcome a webhook '
  'claimed. webhook_received_at says a callback arrived; this says it was true. An asset '
  'is only written after this, because the callback carries a bearer secret rather than a '
  'signature and a leaked secret is a forged completion.';

-- Every generation that reached a terminal state without confirmation. Should be empty;
-- a row here is either a bug in the receiver or something writing results it should not.
create view v_unconfirmed_terminal_generations as
select g.id, g.shot_id, g.status, g.webhook_received_at, g.completed_at, g.external_job_id
from generations g
-- The terminal set from the status CHECK in 0001. Written out rather than negated, so a
-- new non-terminal status does not silently start appearing here. `nsfw_blocked` is not
-- one of them: the driver interface has a content-rejected error code, but the column's
-- CHECK does not, so a rejection lands as `failed` with an error_code.
where g.status in ('succeeded', 'failed', 'cancelled', 'timeout')
  and g.completed_at is not null
  and g.confirmed_at is null;

comment on view v_unconfirmed_terminal_generations is
  'Should always be empty. A row is a generation whose outcome was written without the '
  'vendor being asked to confirm it — which is the shape of a forged callback landing.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0013', 'generation_ingest', array['-- applied from a lean bundle; text in supabase/migrations/0013_generation_ingest.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0014_catalogue_rows_are_not_fixtures.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0014 catalogue_rows_are_not_fixtures'; end $kiln_progress$;

-- Migration 0014 — the rows the wizard cannot start without stop being local fixtures
--
-- ** THIS IS THE EVOLUTION KIND **, not the specification kind. Nothing in the addenda
-- specified these rows as seed data and then required them elsewhere on the same page.
-- They were fixture data for a settings screen that rendered fixtures, and they became a
-- precondition the day the onboarding Server Actions started reading them by slug. The
-- second case that tested the original design was a hosted deployment, which is exactly
-- where a decision that only ever ran under `supabase db reset` gets found out.
--
-- ─────────────────────────────────────────────────────────────
-- What went wrong, concretely
--
-- `supabase db push` applies migrations. It does not apply `supabase/seed.sql` — that file
-- runs on `db reset`, and its own first line says it "never runs against production".
--
-- Four of the five catalogue integrations lived only in that file. The app never creates
-- them: `configureAndVerify` (src/lib/onboarding/actions.ts) and `verifyIntegration`
-- (src/lib/integrations/verify.ts) both `select ... eq('slug', …)` and throw when the row
-- is absent. It is a lookup, not an upsert. So a freshly pushed production database
-- produced this, verified by applying 0001–0013 to an empty database with no seed:
--
--     integrations   → elevenlabs only          (from 0004, which used a migration)
--     driver_health  → empty
--     rate_card      → anthropic (0006) + elevenlabs (0004); no video placeholders
--
-- Wizard steps 2 (storage), 3 (LLM) and 4 (video) therefore threw "this database has not
-- been seeded" and could not be walked at all. Step 5 (audio) worked — by the accident of
-- 0004 having put its integration row in a migration while the others went to the seed.
-- That inconsistency is the tell: the right placement was already demonstrated in this
-- repo and not followed for the rest.
--
-- The rule this settles: a row the application requires in order to function belongs in a
-- migration in every environment. `seed.sql` is for data that makes local development
-- convenient — and nothing else. What stays there after this migration is one channel row,
-- and it stays because onboarding step 8 creates a real channel itself; the seeded one only
-- spares a local developer the wizard.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 1. One integrations row per catalogue entry
--
-- Disabled and unverified. A row here is a slot to fill in, not a working credential —
-- `isUsable()` requires is_enabled AND last_verified_at, so creating these grants nothing.
--
-- Kept in sync with INTEGRATION_CATALOG in src/lib/drivers/catalog.ts. That duplication is
-- real and it is what produced this migration, so `pnpm check:catalog` now applies the
-- migrations to a scratch database and fails if a catalogue slug has no row.
--
-- elevenlabs is listed even though 0004 already inserted it. Repeating it costs nothing
-- under ON CONFLICT and makes this file the complete answer to "which integrations must
-- exist", rather than one that is only correct if you also read 0004.
-- ─────────────────────────────────────────────────────────────

insert into integrations (slug, kind, is_enabled) values
  ('supabase-storage', 'storage', false),
  ('anthropic',        'llm',     false),
  ('higgsfield',       'video',   false),
  ('elevenlabs',       'audio',   false),
  ('fal',              'video',   false)
on conflict (slug) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 2. Circuit breaker state, one row per driver that can be broken
--
-- Nothing reads these today — the breaker described in 0002 is not written yet, and
-- `grep -rn driver_health src/` finds no read and no write. They are here anyway, and the
-- reason is this migration's own subject: the breaker will be written as an UPDATE against
-- a driver key (an in-process counter is what 0002 rejected), and leaving the rows in a
-- local-only file would reproduce exactly the failure above the first time it ran in
-- production. Cheaper to be consistent now than to find it twice.
--
-- Only the two video drivers. `driver_health` guards submits that cost credits against an
-- unreliable vendor; the LLM and storage paths fail loudly and immediately.
-- ─────────────────────────────────────────────────────────────

insert into driver_health (driver) values ('higgsfield'), ('fal')
on conflict (driver) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 3. Placeholder rates for the credit-priced drivers
--
-- ⚠️  THE NUMBERS BELOW ARE ZERO AND ARE MARKED UNVERIFIED. ⚠️
--
-- Not required for the wizard: onboarding step 6 already reports a missing row and an
-- unverified row identically, as "still unverified", and blocks either way. They are here
-- so that a pushed database and a locally reset one show the same thing — the divergence
-- between those two is the entire subject of this migration — and because
-- "placeholder — replace with an observed credit delta" tells you what to do next, while
-- "no rate card row" reads like a bug in the wizard.
--
-- Higgsfield prices in credits and publishes no rate table; the real per-endpoint cost has
-- to be read off your own account after a real run. Until then every rupee figure derived
-- from these would be internally consistent and externally meaningless, which is why
-- is_verified is false and the submit path refuses rather than rendering a confident zero.
--
-- Replace by inserting a row with a later effective_from. Do not UPDATE these: the ledger
-- snapshots unit cost per generation, and rewriting history breaks the audit trail that
-- makes cost-per-video defensible.
--
-- ON CONFLICT targets the expression index from 0006, which added `unit` to the key after
-- a call priced in two units collided with itself.
-- ─────────────────────────────────────────────────────────────

insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('higgsfield', 'dop-lite',     '/v1/image2video/dop', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-turbo',    '/v1/image2video/dop', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-standard', '/v1/image2video/dop', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'soul',         '/v1/text2image/soul', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('fal',        'placeholder',  null,                  'second', 0.0, 'USD', false,
   'placeholder — the fal driver exists to prove the interface', '1970-01-01T00:00:00Z')
on conflict (driver, model, coalesce(endpoint, ''), unit, effective_from) do nothing;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0014', 'catalogue_rows_are_not_fixtures', array['-- applied from a lean bundle; text in supabase/migrations/0014_catalogue_rows_are_not_fixtures.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0015_webhook_replay.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0015 webhook_replay'; end $kiln_progress$;

-- Migration 0015 — a replayed callback is a different threat from a forged one
--
-- ** SECTION 1 IS THE EVOLUTION KIND. SECTION 3'S NOTE RECORDS A CARELESSNESS. **
--
-- ─────────────────────────────────────────────────────────────
-- The question this answers
--
-- 0013 added `confirmed_at` and described it as "when the vendor's status endpoint
-- independently confirmed the outcome a webhook claimed". `v_unconfirmed_terminal_
-- generations` then reads it as a *boolean* — null means unconfirmed, which is the shape
-- of a forged callback landing.
--
-- But `confirm.ts` writes it unconditionally on every delivery, and nothing anywhere reads
-- it before acting. So the column is a flag to one reader and a most-recent-timestamp to
-- its only writer, and the second delivery of a genuine callback:
--
--   1. overwrites webhook_received_at, losing when the first one actually arrived
--   2. issues a SECOND status fetch against a vendor with undocumented rate limits that
--      fail silently
--   3. rewrites confirmed_at, destroying the record of when the outcome was really settled
--   4. at Gate 4, re-enqueues the ingest — a second download, normalise and storage write
--
-- None of that needs a leaked secret or a forged body. Anyone who can see the traffic can
-- resend a real delivery verbatim, and the vendor itself will do it on any timeout.
--
-- This is the evolution kind: the design was correct for one delivery, and the second
-- delivery is the case that tested it. It is not a contradiction on the page — nothing
-- specified idempotency and then made it impossible, the way 0009's `vo_char_start` did.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 1. Count deliveries, and keep the first one's timestamp
--
-- `webhook_received_at` becomes what it sounds like — when the FIRST callback arrived —
-- rather than when the most recent one did. That is the useful one: it is the number you
-- subtract from `submitted_at` to learn how long the vendor took.
--
-- The count is the observable part. Idempotency below makes a replay harmless; this makes
-- it *visible*, which is a separate requirement. A silently-tolerated replay and a
-- silently-tolerated forgery look identical from the outside, and one of them means
-- somebody has the secret.
-- ─────────────────────────────────────────────────────────────

alter table generations
  add column webhook_deliveries int not null default 0,
  add column webhook_last_received_at timestamptz;

comment on column generations.webhook_deliveries is
  'How many callbacks named this job. More than one is a vendor retry or a replay — '
  'harmless by construction (see confirm_generation_once) but never silent, because a '
  'replay and a forgery are indistinguishable from the outside and one of them means the '
  'shared secret leaked.';

comment on column generations.webhook_received_at is
  'When the FIRST callback for this job arrived. Not overwritten by later deliveries — '
  'the interesting interval is submitted_at → first callback, and a redelivery an hour '
  'later would otherwise erase it. See webhook_last_received_at for the most recent.';

-- ─────────────────────────────────────────────────────────────
-- 2. Recording a delivery is one atomic statement
--
-- Read-then-write would let two simultaneous deliveries both read 0 and both write 1.
-- Concurrent duplicate delivery is precisely the case being defended against, so the
-- counter cannot itself have a race in it.
-- ─────────────────────────────────────────────────────────────

create function record_webhook_delivery(p_job_id text)
returns table (generation_id uuid, deliveries int, already_confirmed boolean)
language sql
as $$
  update generations
     set webhook_deliveries      = webhook_deliveries + 1,
         webhook_received_at     = coalesce(webhook_received_at, now()),
         webhook_last_received_at = now()
   where external_job_id = p_job_id
  returning id, webhook_deliveries, confirmed_at is not null;
$$;

comment on function record_webhook_delivery is
  'Increments the delivery counter and stamps first/last arrival in one statement. '
  'Returns whether the generation was already confirmed, so the caller can skip a '
  'redundant vendor fetch on a replay without a second round trip.';

-- ─────────────────────────────────────────────────────────────
-- 3. The confirmation itself is compare-and-set
--
-- This is the guarantee. `confirmed_at is null` in the WHERE clause means exactly one
-- caller can ever transition a generation to a terminal state: the first one to get here
-- wins, every later one updates zero rows and is told so.
--
-- Returning the row count is the whole point — the caller must only enqueue the ingest
-- when it won. An application-level `if (row.confirmed_at) return` cannot give this,
-- because two deliveries can both pass that check before either writes.
--
-- ** The runbook was wrong about this, and that part IS the careless kind. ** Step 4 of
-- 0009 says it tests replay protection; what it actually tests is a callback with a wrong
-- secret and a callback with an invented job id. Both are forgery. The genuine-callback-
-- twice case — the one available to anyone who can see the traffic, with no secret needed
-- — was named and not tested. Writing "replay" and testing "forge" is the sort of thing
-- re-reading your own spec catches.
-- ─────────────────────────────────────────────────────────────

create function confirm_generation_once(
  p_generation_id uuid,
  p_status        text,
  p_error_code    text default null,
  p_error_detail  text default null
)
returns boolean
language plpgsql
as $$
declare
  won boolean;
begin
  update generations
     set status       = p_status,
         error_code   = p_error_code,
         error_detail = p_error_detail,
         confirmed_at = now(),
         completed_at = coalesce(completed_at, now())
   where id = p_generation_id
     and confirmed_at is null      -- the compare half of compare-and-set
  returning true into won;

  return coalesce(won, false);
end
$$;

comment on function confirm_generation_once is
  'Terminal transition, exactly once. Returns true to the single caller that won and '
  'false to every replay. Anything with a cost or a side effect — the ingest enqueue '
  'above all — belongs behind a true from this function, not behind an application-level '
  'read of confirmed_at, which two concurrent deliveries can both pass.';

-- ─────────────────────────────────────────────────────────────
-- 4. Replays are visible on their own
--
-- Distinct from v_unconfirmed_terminal_generations, which catches results written without
-- confirmation. This catches confirmation attempted more than once — the same secret
-- arriving twice. Neither implies the other.
-- ─────────────────────────────────────────────────────────────

create view v_replayed_callbacks as
select
  g.id,
  g.shot_id,
  g.external_job_id,
  g.status,
  g.webhook_deliveries,
  g.webhook_received_at,
  g.webhook_last_received_at,
  g.confirmed_at,
  g.webhook_last_received_at - g.webhook_received_at as spread
from generations g
where g.webhook_deliveries > 1;

comment on view v_replayed_callbacks is
  'Generations that received more than one callback. A vendor retry after a timeout is '
  'the ordinary cause and is harmless. A wide `spread` on a job that already succeeded is '
  'not ordinary: it is somebody resending a delivery they captured.';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0015', 'webhook_replay', array['-- applied from a lean bundle; text in supabase/migrations/0015_webhook_replay.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0016_deferred_steps.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0016 deferred_steps'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0016', 'deferred_steps', array['-- applied from a lean bundle; text in supabase/migrations/0016_deferred_steps.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0017_studio_spend_has_a_subject.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0017 studio_spend_has_a_subject'; end $kiln_progress$;

-- Migration 0017 — a Studio session is a thing money can be spent on
--
-- Two changes, one cause. `cost_ledger` cannot record a Studio turn, and
-- `studio_sessions.cost_inr` — the number the spend cap is enforced against — is a
-- free-standing column that nothing keeps honest.
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds this is: EVOLUTION, not a specification error.
--
-- 0006 widened `cost_ledger_has_subject` from (generation, render) to include (script,
-- concept), and its own comment explains why: a refused draft is billed and produces no
-- script, so the charge needs a subject that exists whether or not the call worked. That
-- reasoning was correct and it was complete for the pipeline lane, where every paid call
-- is made *about* a concept.
--
-- The Studio lane is the second case, and it breaks the assumption rather than
-- contradicting it. Addendum 01 §1: a session materialises a `scripts` row *on first
-- generation*. Every turn before that is billed — the brief, the back-and-forth, the
-- refusals — and belongs to no concept and no script, because deciding what to make is
-- precisely the work that happens before either exists. Under the 0006 constraint those
-- charges have nowhere to go, and rule 5 becomes unenforceable for the lane whose whole
-- risk is that it "can burn a lot of tokens on one bad turn" (0003's own comment on
-- spend_cap_inr).
--
-- The addendum does not contradict itself here; it simply never says where the money
-- goes. A gap, found by building against it. Evolution.
--
-- The alternative — materialise a concept and a script at session start so the charge has
-- somewhere to land — was rejected for the same reason 0006 rejected writing a scripts
-- row for a draft that does not exist: it corrupts the originality evidence in
-- ARCHITECTURE.md §0.2 with rows for videos nobody decided to make.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column studio_session_id uuid references studio_sessions(id) on delete cascade;

comment on column cost_ledger.studio_session_id is
  'Set on Messages API spend made inside a Studio session. Set alone on every turn before '
  'the session materialises a script — which is most of them, and all of the ones on a '
  'session that decided not to make anything. Set alongside script_id afterwards, so the '
  'session total and the per-video total both stay answerable from the same rows.';

create index on cost_ledger (studio_session_id) where studio_session_id is not null;

alter table cost_ledger
  drop constraint cost_ledger_has_subject;

alter table cost_ledger
  add constraint cost_ledger_has_subject
  check (generation_id is not null or render_id is not null
         or script_id is not null or concept_id is not null
         or studio_session_id is not null);

-- ─────────────────────────────────────────────────────────────
-- 2. The number the cap is enforced against is derived, not asserted
--
-- 0003 created studio_sessions.cost_inr, input_tokens and output_tokens as plain columns.
-- Nothing stops the agent loop from writing a ledger row and failing before it updates
-- them, or updating them and failing before the ledger row — and the second case is a
-- session that has spent money the cap cannot see.
--
-- A spend cap enforced against a counter the spender maintains is not a control. So the
-- three columns become derived: a trigger recomputes them from cost_ledger, which is the
-- table rule 5 already makes authoritative. The loop now writes exactly one thing per
-- turn, and the cap reads a number it cannot have been wrong about.
--
-- This is 0016's shape reused deliberately — source of truth plus a trigger-derived
-- mirror — because it settled the same argument there and the argument has not changed.
-- ─────────────────────────────────────────────────────────────

create or replace function refresh_studio_session_spend(p_session uuid)
returns void
language sql
as $$
  update studio_sessions s
  set
    cost_inr = coalesce((
      select sum(cl.cost_inr) from cost_ledger cl
      where cl.studio_session_id = s.id and cl.entry_kind <> 'estimate'
    ), 0),
    input_tokens = coalesce((
      select sum(cl.quantity)::bigint from cost_ledger cl
      where cl.studio_session_id = s.id and cl.unit = 'input_token'
    ), 0),
    output_tokens = coalesce((
      select sum(cl.quantity)::bigint from cost_ledger cl
      where cl.studio_session_id = s.id and cl.unit = 'output_token'
    ), 0)
  where s.id = p_session;
$$;

comment on function refresh_studio_session_spend(uuid) is
  'Recomputes a session''s spend from the ledger. Estimate rows are excluded because a '
  'Messages call is priced on tokens that do not exist until it returns — Studio spend is '
  'always written as reconcile, and counting an estimate as well would double it.';

create or replace function studio_session_spend_trigger()
returns trigger
language plpgsql
as $$
begin
  -- Both sides on an UPDATE that moves a row between sessions. It should never happen;
  -- a trigger that is only correct when nothing unexpected does is not a control either.
  if tg_op in ('UPDATE', 'DELETE') and old.studio_session_id is not null then
    perform refresh_studio_session_spend(old.studio_session_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.studio_session_id is not null then
    perform refresh_studio_session_spend(new.studio_session_id);
  end if;
  return null;
end;
$$;

create trigger cost_ledger_studio_spend
after insert or update or delete on cost_ledger
for each row
execute function studio_session_spend_trigger();

-- ─────────────────────────────────────────────────────────────
-- 3. A stopped session says why it stopped
--
-- `status` already has 'capped', which records that the session ended and loses the one
-- fact a person needs: what it was that ran out. A status with no reason is the swallowed
-- exception in table form.
-- ─────────────────────────────────────────────────────────────

alter table studio_sessions
  add column stopped_at     timestamptz,
  add column stopped_reason text;

comment on column studio_sessions.stopped_reason is
  'Why the loop stopped, in a sentence. Written on the same statement as the status '
  'change, so a session can never be capped without saying against which cap and at what '
  'total.';

-- ─────────────────────────────────────────────────────────────
-- 4. Where the session's spend is read back
--
-- The cap is per session; the guardrails also name a per-day and per-month cap. All three
-- are answered from the ledger and none of them from a counter.
-- ─────────────────────────────────────────────────────────────

create view v_studio_session_spend as
select
  s.id                                        as session_id,
  s.title,
  s.status,
  s.stopped_reason,
  s.model,
  s.script_id,
  s.spend_cap_inr,
  s.cost_inr,
  s.input_tokens,
  s.output_tokens,
  jsonb_array_length(s.transcript)            as turns,
  count(cl.id)                                as ledger_rows,
  s.created_at
from studio_sessions s
left join cost_ledger cl on cl.studio_session_id = s.id
group by s.id;

comment on view v_studio_session_spend is
  'One row per session: what it cost, against what ceiling, and how many ledger rows back '
  'that figure. A session whose ledger_rows is zero and whose cost_inr is not is a bug in '
  'the trigger, and this view is where it would be visible.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0017', 'studio_spend_has_a_subject', array['-- applied from a lean bundle; text in supabase/migrations/0017_studio_spend_has_a_subject.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0018_review_trims_and_reorder.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0018 review_trims_and_reorder'; end $kiln_progress$;

-- Migration 0018 — a shot can be trimmed and shots can be reordered
--
-- The review screen's two editing gestures are in/out handles and drag reorder. Neither
-- has anywhere to live, and reorder cannot be done at all with the constraint as written.
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: 1 is EVOLUTION, 2 is a SPECIFICATION ERROR.
--
-- 1 — trims. `shots.duration_s` was correct for its original case: stage 4 authors a
-- duration, stage 6 replaces it with one derived from word timings, and stage 5 generates
-- a clip of that length. Review is the second case and it asks a question the column
-- cannot answer — "use 0.4s to 3.1s of this clip" is not a duration, it is a window, and
-- overwriting duration_s with the window's length would destroy the record of what was
-- generated and paid for. A generated clip is expensive and immutable; the trim is cheap
-- and revisable. They are different facts. Evolution.
--
-- 2 — reorder. `unique (script_id, idx)` is correct and `idx` is the ordering, so the two
-- together make the ordinary reordering operation impossible: swapping two shots requires
-- a moment where both hold the same idx, and a plain UPDATE hits the constraint mid-
-- statement. The schema specifies an ordered collection and forbids reordering it. That is
-- a contradiction on its own page — the constraint and the column disagree about what idx
-- is for — and it is a specification error rather than a gap.
--
-- The fix is not to drop the constraint. Losing it would let two shots share an index, and
-- the concat list is built in idx order, so a duplicate silently produces a cut whose
-- shot order depends on scan order. That is the silent-wrongness failure this whole area
-- keeps producing. The fix is a function that renumbers in two phases inside one
-- statement, which is what the constraint should have shipped with.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 1. In and out points
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column trim_in_s  numeric,
  add column trim_out_s numeric,
  add constraint shots_trim_window_valid
    check (
      (trim_in_s is null and trim_out_s is null)
      or (trim_in_s is not null and trim_out_s is not null
          and trim_in_s >= 0 and trim_out_s > trim_in_s)
    );

comment on column shots.trim_in_s is
  'Seconds into the generated clip where this shot starts. NULL means untrimmed — which '
  'is not the same as 0, because 0 is a decision somebody made and NULL is one nobody has. '
  'Never overwrites duration_s: that records what was generated and billed, this records '
  'what the cut uses, and conflating them loses the ability to say a clip was paid for and '
  'mostly discarded.';

comment on constraint shots_trim_window_valid on shots is
  'Both or neither, and out strictly after in. A half-set window is the state a dragged '
  'handle passes through, and persisting one would produce a zero-length or negative '
  'segment that ffmpeg accepts and renders as nothing.';

-- The effective length of a shot in the cut. Generated so nothing has to remember the
-- rule, and so the assembler and the review screen cannot disagree about it.
alter table shots
  add column effective_duration_s numeric
    generated always as (
      case when trim_in_s is not null and trim_out_s is not null
        then trim_out_s - trim_in_s
        else duration_s
      end
    ) stored;

comment on column shots.effective_duration_s is
  'What this shot contributes to the cut. duration_s when untrimmed, the window otherwise. '
  'Generated rather than computed at each call site because 07-assemble asserts the render '
  'against the sum of these, and a render whose length disagrees with its rows is a failed '
  'render — so two implementations of this arithmetic is two chances to disagree.';

-- ─────────────────────────────────────────────────────────────
-- 2. Reordering, atomically
--
-- Two phases in one statement. The first moves every shot in the script to a negative
-- index, which cannot collide with the positive ones being assigned; the second writes the
-- new order. Both inside one function call, so no other transaction observes the negatives.
--
-- Takes the complete new order and rejects a partial one. A caller that passes three of
-- five ids is holding a stale list — the other two were added since it loaded — and
-- renumbering against it would silently drop them to the end in whatever order the scan
-- returned.
-- ─────────────────────────────────────────────────────────────

create or replace function reorder_shots(p_script_id uuid, p_shot_ids uuid[])
returns int
language plpgsql
as $$
declare
  existing uuid[];
  moved int;
begin
  select array_agg(id order by id) into existing from shots where script_id = p_script_id;

  if existing is null then
    raise exception 'reorder_shots: script % has no shots', p_script_id;
  end if;

  if (select array_agg(id order by id) from unnest(p_shot_ids) as t(id)) is distinct from existing then
    raise exception
      'reorder_shots: the id list is not this script''s shots. Expected % ids, got %. A '
      'partial or stale list would renumber the shots it names and leave the rest wherever '
      'the scan put them.',
      array_length(existing, 1), array_length(p_shot_ids, 1);
  end if;

  -- Phase 1: out of the way. Negative indexes cannot collide with the ones about to be
  -- written, and `unique (script_id, idx)` holds throughout.
  update shots
  set idx = -idx - 1
  where script_id = p_script_id;

  -- Phase 2: the new order.
  update shots s
  set idx = o.position - 1
  from unnest(p_shot_ids) with ordinality as o(id, position)
  where s.id = o.id and s.script_id = p_script_id;

  get diagnostics moved = row_count;
  return moved;
end $$;

comment on function reorder_shots(uuid, uuid[]) is
  'Renumber a script''s shots to the given order. Two phases in one statement so the '
  'unique constraint on (script_id, idx) is never violated mid-way — which is why a plain '
  'UPDATE cannot do this and why the constraint must not be dropped to make it possible.';

-- ─────────────────────────────────────────────────────────────
-- 3. Review needs to know whether the structure is novel
--
-- `reviews.structure_novel` is NOT NULL and nothing computes it. ARCHITECTURE.md §0.2
-- gives it a job — hard-block publish when the last N videos share a beat structure — and
-- a column the reviewer supplies by hand is a column that says whatever makes the review
-- pass.
--
-- A view rather than a trigger: the *threshold* is an editorial judgement and belongs
-- outside SQL, but "how many other scripts share this hash" is arithmetic and belongs here.
-- ─────────────────────────────────────────────────────────────

create view v_script_structure_novelty as
select
  s.id                                          as script_id,
  s.structure_hash,
  count(*) filter (where o.id is not null)      as shared_with,
  -- studio-stub hashes are per-session by construction and can never collide, so they must
  -- not be reported as novel-because-unique. They are novel-because-unmeasured, which is a
  -- different claim and the review screen says so.
  s.structure_hash like 'studio-stub:%'         as unmeasured,
  array_remove(array_agg(o.id), null)           as shared_script_ids
from scripts s
left join scripts o
  on o.structure_hash = s.structure_hash
 and o.id <> s.id
 and o.structure_hash not like 'studio-stub:%'
group by s.id, s.structure_hash;

comment on view v_script_structure_novelty is
  'How many other scripts are built the same way. A collision is not plagiarism and is not '
  'on its own a reason to refuse — the publish threshold is editorial and lives outside '
  'SQL. This is the arithmetic the reviewer should not be doing by hand into a NOT NULL '
  'boolean.';

-- ─────────────────────────────────────────────────────────────
-- 4. A review is about a render, and there can be more than one
--
-- `reviews` already keys on render_id and orders by created_at desc, so re-reviewing is
-- supported. What is missing is which review is the current one: `enforce_review_pass`
-- reads the review named by the publication, so a superseded 'reshoot' can gate a
-- publication forever if somebody points at the wrong row.
-- ─────────────────────────────────────────────────────────────

create view v_current_review as
select distinct on (r.render_id)
  r.render_id,
  r.id           as review_id,
  r.decision,
  r.notes,
  r.reshoot_shot_ids,
  r.structure_novel,
  r.human_edit_count,
  r.created_at
from reviews r
order by r.render_id, r.created_at desc;

comment on view v_current_review is
  'The latest review per render. The publish gate reads whichever review the publication '
  'names, deliberately — this is what the UI should offer so a superseded decision is not '
  'the one that gets cited.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0018', 'review_trims_and_reorder', array['-- applied from a lean bundle; text in supabase/migrations/0018_review_trims_and_reorder.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0019_ui_scale_preference.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0019 ui_scale_preference'; end $kiln_progress$;

-- Migration 0019 — the UI scale is a setting, not a constant
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION.
--
-- `profiles` already holds the workspace settings whose own comment says it best: *"These
-- are settings, not constants: the FX rate in particular decides every rupee figure in the
-- product, and a constant in code cannot be corrected without a deploy."* Display scale is
-- the same argument applied to a different constant. Nothing in 0005 contradicts this; it
-- simply had no reason to consider a display that reports 3840 CSS pixels.
--
-- ─────────────────────────────────────────────────────────────
-- Why this has to be persisted server-side at all
--
-- The obvious cheap version is localStorage. It is wrong here for one specific reason: the
-- value has to be on the *first* paint. Read it on the client and every page load renders
-- once at 100% and then jumps — on a 4K display, where the whole complaint is that the UI
-- is too small, the jump is from unreadable to readable and it happens on every navigation.
--
-- Persisted on the profile, the server can put it on the document element before anything
-- renders. localStorage stays as the fallback for the pre-auth splash, where there is no
-- profile to read.
-- ─────────────────────────────────────────────────────────────

alter table profiles
  add column ui_scale numeric not null default 1.0
    check (ui_scale in (0.9, 1.0, 1.1, 1.25, 1.5));

comment on column profiles.ui_scale is
  'Multiplier applied to every size and space token. A closed set rather than a free '
  'numeric: the steps are the product decision, and an arbitrary 1.37 produces fractional '
  'pixel values that make hairlines and 1px borders render inconsistently across the app. '
  'The same reason VS Code, Figma and Zed all ship a stepper rather than a slider.';

-- ─────────────────────────────────────────────────────────────
-- The floor is a constraint, not a preference
--
-- WCAG 2.5.8 requires a 24px minimum target. At 0.9 a control laid out to exactly 24px
-- would land at 21.6px, so `--hit-min` is deliberately NOT multiplied by --ui-scale in
-- tokens.css. This CHECK is the other half of that: it stops the set of steps growing
-- downward later without someone re-reading why the floor is unscaled.
-- ─────────────────────────────────────────────────────────────

comment on constraint profiles_ui_scale_check on profiles is
  'The smallest step is 0.9. Anything smaller would need --hit-min re-checked against WCAG '
  '2.5.8, which is a 24px floor that must not shrink with a display preference.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0019', 'ui_scale_preference', array['-- applied from a lean bundle; text in supabase/migrations/0019_ui_scale_preference.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0020_onboarding_before_sign_in.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0020 onboarding_before_sign_in'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0020', 'onboarding_before_sign_in', array['-- applied from a lean bundle; text in supabase/migrations/0020_onboarding_before_sign_in.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0021_referral_attribution_and_rollup.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0021 referral_attribution_and_rollup'; end $kiln_progress$;

-- Migration 0021 — referral attribution, and an aggregate a partner conversation can use
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION, and the unusual sort — the schema is not wrong, it
-- simply never had to answer a commercial question before.
--
-- `integrations` records that a vendor is connected and whether it verified. That was the
-- whole job while the only consumer was the pipeline, which needs to know if a credential
-- works and nothing else about where it came from.
--
-- A partnership needs one more fact: whether a signup at the vendor happened *through*
-- Kiln. That fact is only observable at the moment somebody clicks through to create the
-- account — afterwards there is no way to recover it from either side, which is why this
-- is cheap now and impossible later. Nothing else in the schema has that property, and it
-- is the entire argument for doing it before it is needed.
-- ─────────────────────────────────────────────────────────────

alter table integrations
  add column referral_code   text,
  add column referral_source text,
  add column referred_at     timestamptz,
  add constraint integrations_referral_complete
    check (
      (referral_code is null and referred_at is null)
      or (referral_code is not null and referred_at is not null)
    );

comment on column integrations.referral_code is
  'The code Kiln sent the vendor when this account was created through our connect flow. '
  'Null means either the account predates the flow or the person signed up directly — the '
  'two are indistinguishable and must not be guessed apart, because an attribution claim '
  'that cannot be evidenced is worse than no claim in exactly the conversation it exists '
  'for.';

comment on column integrations.referral_source is
  'Where in Kiln the click originated: ''onboarding'', ''settings'', ''refusal''. The third '
  'is the interesting one — a refusal names the missing vendor and offers the connect link, '
  'so it is the highest-intent path in the product and worth being able to count separately.';

comment on constraint integrations_referral_complete on integrations is
  'A code without a timestamp is an attribution nobody can date, which is not evidence. '
  'Both or neither.';

-- ─────────────────────────────────────────────────────────────
-- The aggregate
--
-- Deliberately an aggregate and deliberately anonymised. What a partner conversation needs
-- is volume through Kiln — videos made, credits consumed, over a period. What it must not
-- carry is concept titles, script text, prompts or channel names, because those are the
-- operator's editorial work and are not ours to hand over.
--
-- So this view exposes counts and sums keyed on nothing but a month and a driver. There is
-- no id in it to join back to anything, which is what makes it safe to paste into an email
-- rather than merely intended to be.
-- ─────────────────────────────────────────────────────────────

create view v_partner_rollup as
select
  date_trunc('month', cl.occurred_at)::date            as period,
  cl.driver,
  cl.unit,
  sum(cl.quantity)                                     as units_consumed,
  round(sum(cl.cost_inr), 2)                           as cost_inr,
  count(distinct cl.generation_id)
    filter (where cl.generation_id is not null)        as generations,
  count(distinct r.id)                                 as renders_completed
from cost_ledger cl
left join generations g on g.id = cl.generation_id
left join shots s       on s.id = g.shot_id
left join renders r     on r.script_id = s.script_id and r.status = 'ready'
-- Estimates are excluded: an estimate is a row written before the vendor answered, and
-- counting both it and its reconciliation would double every figure here.
where cl.entry_kind <> 'estimate'
group by 1, 2, 3;

comment on view v_partner_rollup is
  'Volume through Kiln by month and driver. No ids, no titles, no prompts — nothing that '
  'could identify a video or a channel, because this is the shape that gets pasted into an '
  'email and the safety has to be in the view rather than in the discipline of whoever '
  'pastes it. Estimate rows are excluded so reconciled spend is not counted twice.';

create view v_referral_attribution as
select
  i.slug                                          as driver,
  i.referral_source,
  date_trunc('month', i.referred_at)::date        as period,
  count(*)                                        as accounts_connected,
  count(*) filter (where i.last_verified_at is not null) as accounts_verified
from integrations i
where i.referral_code is not null
group by 1, 2, 3;

comment on view v_referral_attribution is
  'Signups attributable to Kiln, by vendor and by where in the product the click came from. '
  'accounts_verified is the honest denominator for any conversion claim: a connected '
  'integration that never verified is a form somebody filled in, not a working account.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0021', 'referral_attribution_and_rollup', array['-- applied from a lean bundle; text in supabase/migrations/0021_referral_attribution_and_rollup.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0022_submitting_is_a_state.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0022 submitting_is_a_state'; end $kiln_progress$;

-- Migration 0022 — a generation that has a row and does not yet have a job
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION.
--
-- `generations.status` was written when the row was created *after* the vendor accepted
-- the call. In that world `queued` is exact: the row exists, the vendor has the job, the
-- id is on the row, and the callback can find it.
--
-- Stage 5 now writes the row *before* the call, and it has to. A crash between the insert
-- and the submit must leave evidence that a submit was attempted — the idempotency key is
-- what stops the retry from becoming a second charge, and a key that was never written
-- protects nothing. So the row goes first.
--
-- That creates a state the original design had no name for: a row with no
-- `external_job_id`, where nobody yet knows whether the vendor has the work. Calling it
-- `queued` would make it indistinguishable from a submitted job whose id failed to write,
-- which is exactly the row an operator needs to be able to find.
--
-- The tested-by-a-second-case shape, precisely: the first design was right for its case,
-- and a second case revealed a state it could not express.
-- ─────────────────────────────────────────────────────────────

alter table generations drop constraint if exists generations_status_check;

alter table generations
  add constraint generations_status_check
  check (status = any (array[
    'submitting'::text,
    'queued'::text,
    'running'::text,
    'succeeded'::text,
    'failed'::text,
    'cancelled'::text,
    'timeout'::text
  ]));

comment on column generations.status is
  'submitting — the row exists and the vendor has not been called yet, or the call is in '
  'flight. queued — the vendor accepted it and external_job_id is set. A row stuck in '
  'submitting is the one an operator must be able to find: it means a submit was attempted '
  'and nobody knows whether it landed, which is the only state in this table where the '
  'money may be spent and the evidence missing.';

-- ─────────────────────────────────────────────────────────────
-- The row that needs a human
--
-- Not an alert, a view. A submit that crashed between the insert and the vendor's reply
-- cannot be resolved automatically: retrying might double-charge, and abandoning it might
-- throw away a generation that succeeded. The only correct response is to look, which
-- means the rows have to be findable.
--
-- The interval is deliberate. A submit in flight is a normal state for a few seconds; one
-- that has been in flight for five minutes is not, because the driver's own timeout is far
-- below that.
-- ─────────────────────────────────────────────────────────────

create view v_stuck_submits as
select
  g.id,
  g.shot_id,
  g.driver,
  g.model,
  g.idempotency_key,
  g.submitted_at,
  now() - g.submitted_at as stuck_for,
  -- The estimate row exists whether or not the call landed, because rule 5 writes it
  -- first. Its presence is what makes this a money question rather than a tidying one.
  exists (
    select 1 from cost_ledger cl
     where cl.idempotency_key = g.idempotency_key || ':estimate'
  ) as charged
from generations g
where g.status = 'submitting'
  and g.external_job_id is null
  and g.submitted_at < now() - interval '5 minutes';

comment on view v_stuck_submits is
  'Generations whose row was written and whose vendor call cannot be accounted for. '
  'Deliberately not auto-resolved: retrying may double-charge and abandoning may discard '
  'a generation that succeeded, so the only correct response is a human looking. `charged` '
  'says whether an estimate row was already written, which is what decides how urgent it is.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0022', 'submitting_is_a_state', array['-- applied from a lean bundle; text in supabase/migrations/0022_submitting_is_a_state.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0023_a_charge_can_belong_to_a_channel.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0023 a_charge_can_belong_to_a_channel'; end $kiln_progress$;

-- Migration 0023 — a cost row whose subject is the channel
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION.
--
-- `cost_ledger_has_subject` lists five subjects — generation, render, script, concept,
-- studio session — and every one of them is an artifact that exists before the money is
-- spent. That was exact for every stage that existed when it was written.
--
-- Stage 2 is the first charge that does not fit. One call proposes five concepts; the
-- concepts do not exist when the call is billed, and when they do exist the charge belongs
-- to all five rather than to any one of them. Attributing it to the first concept would
-- misreport cost-per-concept by 5×, and attributing it after the writes would lose the
-- charge whenever a concept was refused by a constraint.
--
-- What the charge is actually *about* is the channel. So that becomes the sixth subject.
--
-- The tested-by-a-second-case shape again: the original list was right for artifacts, and
-- the second case is a charge that belongs to a set it is about to create.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column channel_id uuid references channels(id) on delete cascade;

alter table cost_ledger drop constraint if exists cost_ledger_has_subject;

alter table cost_ledger
  add constraint cost_ledger_has_subject
  check (
    generation_id is not null
    or render_id is not null
    or script_id is not null
    or concept_id is not null
    or studio_session_id is not null
    or channel_id is not null
  );

create index cost_ledger_channel_id_idx
  on cost_ledger (channel_id)
  where channel_id is not null;

comment on column cost_ledger.channel_id is
  'The subject for a charge that belongs to a set rather than to an artifact — stage 2 '
  'proposes N concepts in one call, and the concepts do not exist when the call is billed. '
  'Not a denormalised convenience field: a row with channel_id and no concept_id is a '
  'batch charge, and cost-per-concept has to divide it rather than attribute it.';

-- ─────────────────────────────────────────────────────────────
-- Cost per concept, with the batch charge divided
--
-- The view exists because the division is easy to get wrong in three different ways and
-- every one of them produces a plausible number. A stage-2 charge covers the concepts that
-- *survived validation and landed*, which is not the same as the number requested and not
-- the same as the number the model returned.
-- ─────────────────────────────────────────────────────────────

create view v_concept_cost as
with batch as (
  select
    cl.channel_id,
    date_trunc('day', cl.occurred_at) as day,
    sum(cl.cost_inr) as batch_inr
  from cost_ledger cl
  where cl.channel_id is not null
    and cl.concept_id is null
    and cl.entry_kind <> 'estimate'
  group by 1, 2
),
landed as (
  select
    c.channel_id,
    date_trunc('day', c.created_at) as day,
    count(*) as n
  from concepts c
  group by 1, 2
)
select
  b.channel_id,
  b.day::date as period,
  b.batch_inr,
  coalesce(l.n, 0) as concepts_landed,
  case
    when coalesce(l.n, 0) = 0 then null
    else round(b.batch_inr / l.n, 4)
  end as inr_per_concept
from batch b
left join landed l on l.channel_id = b.channel_id and l.day = b.day;

comment on view v_concept_cost is
  'Stage 2 spend divided by the concepts that actually landed that day. Null per-concept '
  'when nothing landed, which is a real outcome — a batch can be paid for and rejected '
  'wholesale in validation — and must not read as zero.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0023', 'a_charge_can_belong_to_a_channel', array['-- applied from a lean bundle; text in supabase/migrations/0023_a_charge_can_belong_to_a_channel.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0024_a_channel_has_a_voice.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0024 a_channel_has_a_voice'; end $kiln_progress$;

-- Migration 0024 — the host voice is a setting, not a fixture
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR, of the quiet sort.
--
-- Not a schema that contradicts itself on its own page — a schema that never expressed a
-- fact the pipeline structurally depends on. `vo_takes.voice_id` records which voice *was*
-- used; nothing records which voice *should be* used. The settings screen reads
-- `VOICE_SETTINGS.hostVoice`, which is a constant in a fixtures file.
--
-- The consequence is not cosmetic, and it is why this is a specification error rather than
-- an omission. Stage 6 takes a `voiceId` argument. With nowhere to read one from, stage 6
-- can only be triggered by hand. Stage 5 refuses every shot whose `duration_source` is not
-- `derived_from_vo`, and **only stage 6 sets that value**. So the whole 03 → 04 → 05 chain
-- submits zero shots, always — complete, green, and inert.
--
-- One missing column made four working stages produce nothing, and no test could show it:
-- every stage passes its own harness, and the emptiness only appears end to end.
--
-- ── On the channel, not in a global setting ──────────────────────────────────
--
-- ARCHITECTURE.md §0.1 treats the channel as the unit that accumulates value. Two channels
-- in different niches want different voices, and a workspace-wide host voice would have to
-- be undone the moment a second channel exists. Per-channel is where it belongs even while
-- there is only one.
-- ─────────────────────────────────────────────────────────────

alter table channels
  add column host_voice_id  text,
  add column voice_language text not null default 'en';

comment on column channels.host_voice_id is
  'The voice stage 6 renders this channel''s voiceover with. Null means stage 6 cannot run '
  'unattended, which in turn means stage 5 has nothing to submit — it refuses any shot '
  'whose duration is still the shotlist estimate. Setting this is what makes the pipeline '
  'chain from an approved concept to a submitted generation without a human in the middle.';

comment on column channels.voice_language is
  'BCP-47-ish language tag passed to the voice vendor. Defaulted rather than nullable: '
  'every vendor needs one, and "unset" is not a language.';

-- ─────────────────────────────────────────────────────────────
-- Why a chain would stop, in one place
--
-- The failure this exists to make visible is silence: an approved concept that produces a
-- script, a shotlist, and then nothing at all. Reading it back from four tables is how that
-- goes unnoticed for a week.
-- ─────────────────────────────────────────────────────────────

create view v_pipeline_blockers as
select
  s.id                                as script_id,
  c.id                                as concept_id,
  c.channel_id,
  c.title,
  s.created_at,
  case
    when ch.host_voice_id is null then 'no host voice on the channel — stage 6 cannot run'
    when not exists (select 1 from shots sh where sh.script_id = s.id)
      then 'no shots — stage 4 has not run'
    when exists (
      select 1 from shots sh
       where sh.script_id = s.id and sh.compiled_params is null
    ) then 'some shots have no compiled parameters — no library recipe matched'
    when exists (
      select 1 from shots sh
       where sh.script_id = s.id and sh.duration_source <> 'derived_from_vo'
    ) then 'durations are still estimates — stage 6 has not run'
    else null
  end as blocker
from scripts s
join concepts c on c.id = s.concept_id
join channels ch on ch.id = c.channel_id;

comment on view v_pipeline_blockers is
  'For every script, the first reason it cannot reach a generation — or null when nothing '
  'is blocking it. Ordered by how early the stage sits, so the answer is the *first* thing '
  'to fix rather than a list. Exists because the failure mode of this pipeline is silence: '
  'an approved concept that yields a script, a shotlist, and then nothing.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0024', 'a_channel_has_a_voice', array['-- applied from a lean bundle; text in supabase/migrations/0024_a_channel_has_a_voice.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0025_a_recipe_earns_its_place.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0025 a_recipe_earns_its_place'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0025', 'a_recipe_earns_its_place', array['-- applied from a lean bundle; text in supabase/migrations/0025_a_recipe_earns_its_place.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0026_cost_per_video_is_a_row.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0026 cost_per_video_is_a_row'; end $kiln_progress$;

-- Migration 0026 — cost per video, as rows, with a denominator
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: neither. Nothing here is a correction to a schema that
-- contradicts itself, and nothing is a design outgrowing its first case. `cost_ledger` is
-- already exact; six subjects, an entry_kind that separates committed from actual, and a
-- constraint that refuses a charge with no subject. What was missing was a *reader*.
--
-- CLAUDE.md rule 5 calls cost-per-video the project's headline metric. It has been
-- unanswerable for the whole build, not because the rows are wrong but because turning
-- them into a per-video number requires four joins and a decision about three different
-- ways of being uncertain — which is precisely the condition under which people stop
-- asking and start assuming.
-- ─────────────────────────────────────────────────────────────
--
-- Three things this view refuses to do, each of which produces a plausible number:
--
-- 1. It will not add an estimate to a reconcile. An estimate is money committed at submit
--    before the result exists (rule 5); a reconcile is money actually spent. Summing them
--    double-counts every generation that has completed. Excluding estimates makes a video
--    that is mid-flight look free, which is worse — that is spend the account has already
--    incurred. So both are reported, in separate columns, and nothing here ever merges
--    them. The caller decides, visibly.
--
-- 2. It will not treat an unpriced row as a free one. `cost_ledger.cost_inr` is nullable
--    and the rate card ships with unverified rates whose unit cost is null on purpose. A
--    video with one unpriced call has an *unknown* cost, not a smaller one. `total_inr`
--    goes null the moment any contributing row is null, and `unpriced_rows` says how many.
--    Summing nulls as zero would understate the headline metric in the flattering
--    direction, silently, for ever.
--
-- 3. It will not silently drop spend that belongs to no video. Every charge reachable from
--    a script is attributed here; `v_cost_unattributed` is the complement, and the two are
--    exhaustive by construction. A cost-per-video figure is only honest if you can also
--    say what it excludes — a Studio session that decided not to make anything, a refused
--    draft charged to a concept, a generation whose shot was deleted. Those are real money
--    and they are not part of any video's cost.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- Every ledger row, resolved to the script it belongs to
--
-- Six subjects reach a script by four different paths, and one of them (channel) does not
-- reach one at all. Doing this once, here, is what stops each consumer inventing its own
-- join and getting a different total.
-- ─────────────────────────────────────────────────────────────

create view v_cost_attributed as
select
  cl.id,
  coalesce(
    cl.script_id,                    -- drafting, shotlist, metadata, and settled Studio spend
    s.script_id,                     -- a generation, via its shot
    r.script_id                      -- a render
  ) as script_id,
  case
    when cl.render_id     is not null then 'render'
    when cl.generation_id is not null then coalesce(g.kind, 'generation')
    when cl.script_id     is not null and cl.studio_session_id is not null then 'studio'
    when cl.script_id     is not null then 'llm'
    when cl.studio_session_id is not null then 'studio'
    when cl.concept_id    is not null then 'concept'
    when cl.channel_id    is not null then 'channel'
    else 'unknown'
  end as component,
  cl.entry_kind,
  cl.cost_inr,
  cl.cost_usd,
  cl.driver,
  cl.unit,
  cl.occurred_at,
  -- The subject columns, carried through so an estimate can be matched to its reconcile.
  -- Nothing in the schema pairs those two rows: the idempotency key is
  -- (generation_id, entry_kind), which makes each unique but does not link them.
  cl.generation_id,
  cl.render_id,
  cl.script_id     as subject_script_id,
  cl.studio_session_id,
  cl.concept_id,
  cl.channel_id
from cost_ledger cl
left join generations g on g.id = cl.generation_id
left join shots       s on s.id = g.shot_id
left join renders     r on r.id = cl.render_id;

comment on view v_cost_attributed is
  'Every cost_ledger row with the script it belongs to resolved once, by the four paths '
  'that reach one. script_id is null for spend that belongs to no video — that is a real '
  'category, not a join failure, and v_cost_unattributed is where it goes.';

-- ─────────────────────────────────────────────────────────────
-- Cost per video
--
-- One row per script that has either incurred spend or been rendered. Not one row per
-- render: a script with two hook variants is one video's worth of drafting, shots and
-- voice, and the variants share all of it. `renders` says how many came out.
-- ─────────────────────────────────────────────────────────────

create view v_video_cost as
with attributed as (
  select * from v_cost_attributed where script_id is not null
),
-- A reconcile supersedes the estimate for the same subject. Rather than model that per
-- subject, take it per script and per component: if anything settled, the open estimates
-- for that component are the ones still outstanding. This is the honest granularity —
-- the ledger's own idempotency key is (generation_id, entry_kind), so an estimate and its
-- reconcile are two rows about one charge and nothing in the schema pairs them further.
settled as (
  select
    script_id,
    sum(cost_inr)                          as settled_inr,
    count(*) filter (where cost_inr is null) as unpriced,
    count(*)                               as rows_n
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1
),
open_est as (
  select
    a.script_id,
    sum(a.cost_inr)                          as open_inr,
    count(*) filter (where a.cost_inr is null) as unpriced,
    count(*)                                 as rows_n
  from attributed a
  where a.entry_kind = 'estimate'
    -- Outstanding only. A charge that has reconciled is no longer committed-and-unknown;
    -- counting it in both columns would double it in any caller that adds them. Matched on
    -- the whole subject plus unit, because one LLM call is billed at two rates and writes
    -- two rows — `is not distinct from` so a null subject matches a null subject rather
    -- than matching nothing.
    and not exists (
      select 1 from cost_ledger r
      where r.entry_kind = 'reconcile'
        and r.generation_id     is not distinct from a.generation_id
        and r.render_id         is not distinct from a.render_id
        and r.script_id         is not distinct from a.subject_script_id
        and r.studio_session_id is not distinct from a.studio_session_id
        and r.concept_id        is not distinct from a.concept_id
        and r.channel_id        is not distinct from a.channel_id
        and r.unit              is not distinct from a.unit
    )
  group by 1
),
-- Every attributed row, counted regardless of entry kind. Deliberately not
-- settled.rows_n + open_est.rows_n: an estimate superseded by its reconcile is correctly
-- excluded from both figures, so that sum under-counts by one row per completed
-- generation. This column is what makes v_video_cost and v_cost_unattributed exhaustive
-- over cost_ledger, which is the only assertion that can catch a quietly narrowed
-- denominator — the way a headline metric actually goes wrong.
all_rows as (
  select script_id, count(*) as rows_n from attributed group by 1
),
by_component as (
  select
    script_id,
    component,
    sum(cost_inr) as inr,
    count(*) filter (where cost_inr is null) as unpriced
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1, 2
),
components as (
  select
    script_id,
    jsonb_object_agg(
      component,
      jsonb_build_object('inr', inr, 'unpriced', unpriced)
    ) as component_inr
  from by_component
  group by 1
),
rendered as (
  select script_id, count(*) as renders, count(*) filter (where status = 'ready') as renders_ready
  from renders group by 1
),
published as (
  select r.script_id, count(*) filter (where p.status = 'live') as live
  from publications p join renders r on r.id = p.render_id
  group by 1
)
select
  sc.id                                    as script_id,
  sc.concept_id,
  c.channel_id,
  c.title,
  sc.created_at,

  -- Money actually spent. Null when any contributing row is unpriced — an unknown cost is
  -- not a smaller cost, and this is the column a headline number would be built on.
  case when coalesce(st.unpriced, 0) > 0 then null else st.settled_inr end as settled_inr,
  coalesce(st.unpriced, 0)                 as unpriced_settled_rows,

  -- Money committed at submit and not yet reconciled. Reported beside the settled figure,
  -- never added into it: adding them double-counts anything that has completed.
  case when coalesce(oe.unpriced, 0) > 0 then null else oe.open_inr end as open_estimate_inr,
  coalesce(oe.unpriced, 0)                 as unpriced_open_rows,

  coalesce(ar.rows_n, 0)                   as ledger_rows,
  cm.component_inr,

  coalesce(rd.renders, 0)                  as renders,
  coalesce(rd.renders_ready, 0)            as renders_ready,
  coalesce(pb.live, 0)                     as publications_live,

  -- The denominator question, as a column rather than as a caller's guess. A video counts
  -- towards cost-per-video only when it exists (something rendered) and its cost is fully
  -- known. Everything else is named and excluded rather than averaged in.
  case
    when coalesce(rd.renders_ready, 0) = 0 then 'not_rendered'
    when coalesce(st.unpriced, 0) > 0      then 'unpriced'
    when st.settled_inr is null            then 'nothing_settled'
    else 'countable'
  end                                      as denominator_state
from scripts sc
join concepts c on c.id = sc.concept_id
left join settled   st on st.script_id = sc.id
left join open_est  oe on oe.script_id = sc.id
left join all_rows  ar on ar.script_id = sc.id
left join components cm on cm.script_id = sc.id
left join rendered  rd on rd.script_id = sc.id
left join published pb on pb.script_id = sc.id
where st.script_id is not null
   or oe.script_id is not null
   or rd.script_id is not null;

comment on view v_video_cost is
  'Cost per video, one row per script, with settled and committed spend kept apart and '
  'an unknown cost represented as null rather than as zero. denominator_state says '
  'whether the row may be averaged into a headline figure and, when not, why — so the '
  'excluded rows stay visible instead of being dropped by a where clause upstream.';

-- ─────────────────────────────────────────────────────────────
-- The complement
--
-- Without this the per-video totals look complete and are not. Spend lands here when the
-- thing it was about never became a video: a Studio session that decided not to make
-- anything, a draft the model refused, a stage-2 batch charged to the channel.
-- ─────────────────────────────────────────────────────────────

create view v_cost_unattributed as
select
  component,
  entry_kind,
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
  'exhaustive with it: a cost-per-video figure is only honest alongside what it excludes.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0026', 'cost_per_video_is_a_row', array['-- applied from a lean bundle; text in supabase/migrations/0026_cost_per_video_is_a_row.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0027_studio_spend_reaches_its_video.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0027 studio_spend_reaches_its_video'; end $kiln_progress$;

-- Migration 0027 — Studio spend reaches the video it produced
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR, and mine, from three days ago.
--
-- 0017's comment on `cost_ledger.studio_session_id` says the column is "set alongside
-- script_id afterwards, so the session total and the per-video total both stay answerable
-- from the same rows." That sentence describes a mechanism the schema on the same page
-- forbids: `cost_ledger_script_stage_entry_key` is unique on
-- `(script_id, coalesce(stage,''), entry_kind, unit)` where script_id is not null, and
-- every Studio turn carries `stage = 'studio'`. The second turn on a materialised session
-- would collide with the first and be swallowed as a retry — money moving with no row,
-- which is the exact failure 0017 was written to prevent.
--
-- So the row cannot carry both. 0026 then inherited the mistake in the other direction: it
-- resolved a script from four paths and none of them was a Studio session, so a session
-- that *did* materialise a script had its whole spend land in `v_cost_unattributed` for
-- ever. Both halves of the same wrong assumption.
--
-- The attribution belongs in the view, where it costs nothing and collides with nothing.
-- `studio_sessions.script_id` already exists and is already materialised on first
-- generation; this reads it.
-- ─────────────────────────────────────────────────────────────

drop view v_cost_unattributed;
drop view v_video_cost;
drop view v_cost_attributed;

create view v_cost_attributed as
select
  cl.id,
  coalesce(
    cl.script_id,                    -- drafting, shotlist, metadata
    s.script_id,                     -- a generation, via its shot
    r.script_id,                     -- a render
    ss.script_id                     -- a Studio session that went on to materialise one
  ) as script_id,
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
  cl.cost_inr,
  cl.cost_usd,
  cl.driver,
  cl.unit,
  cl.occurred_at,
  -- The subject columns, carried through so an estimate can be matched to its reconcile.
  -- Nothing in the schema pairs those two rows: the idempotency key is
  -- (generation_id, entry_kind), which makes each unique but does not link them.
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
  'Every cost_ledger row with the script it belongs to resolved once, by the four paths '
  'that reach one — including a Studio session, whose script_id is materialised on first '
  'generation and is the only place that link exists. A charge cannot carry both '
  'studio_session_id and script_id: the (script_id, stage, entry_kind, unit) unique index '
  'would collide on the second turn of a session and swallow it as a retry. script_id null '
  'here is spend that belongs to no video, which is a real category rather than a join '
  'failure, and v_cost_unattributed is where it goes.';

-- ─────────────────────────────────────────────────────────────
-- Unchanged from 0026 below this line, recreated because the views were dropped.
-- ─────────────────────────────────────────────────────────────

create view v_video_cost as
with attributed as (
  select * from v_cost_attributed where script_id is not null
),
settled as (
  select
    script_id,
    sum(cost_inr)                            as settled_inr,
    count(*) filter (where cost_inr is null) as unpriced,
    count(*)                                 as rows_n
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1
),
open_est as (
  select
    a.script_id,
    sum(a.cost_inr)                            as open_inr,
    count(*) filter (where a.cost_inr is null) as unpriced,
    count(*)                                   as rows_n
  from attributed a
  where a.entry_kind = 'estimate'
    -- Outstanding only. A charge that has reconciled is no longer committed-and-unknown;
    -- counting it in both columns would double it in any caller that adds them. Matched on
    -- the whole subject plus unit, because one LLM call is billed at two rates and writes
    -- two rows — `is not distinct from` so a null subject matches a null subject rather
    -- than matching nothing.
    and not exists (
      select 1 from cost_ledger r
      where r.entry_kind = 'reconcile'
        and r.generation_id     is not distinct from a.generation_id
        and r.render_id         is not distinct from a.render_id
        and r.script_id         is not distinct from a.subject_script_id
        and r.studio_session_id is not distinct from a.studio_session_id
        and r.concept_id        is not distinct from a.concept_id
        and r.channel_id        is not distinct from a.channel_id
        and r.unit              is not distinct from a.unit
    )
  group by 1
),
-- Every attributed row, counted regardless of entry kind. Deliberately not
-- settled.rows_n + open_est.rows_n: an estimate superseded by its reconcile is correctly
-- excluded from both figures, so that sum under-counts by one row per completed
-- generation. This column is what makes v_video_cost and v_cost_unattributed exhaustive
-- over cost_ledger, which is the only assertion that can catch a quietly narrowed
-- denominator — the way a headline metric actually goes wrong.
all_rows as (
  select script_id, count(*) as rows_n from attributed group by 1
),
by_component as (
  select
    script_id,
    component,
    sum(cost_inr)                            as inr,
    count(*) filter (where cost_inr is null) as unpriced
  from attributed
  where entry_kind in ('reconcile', 'refund')
  group by 1, 2
),
components as (
  select
    script_id,
    jsonb_object_agg(component, jsonb_build_object('inr', inr, 'unpriced', unpriced)) as component_inr
  from by_component
  group by 1
),
rendered as (
  select script_id, count(*) as renders, count(*) filter (where status = 'ready') as renders_ready
  from renders group by 1
),
published as (
  select r.script_id, count(*) filter (where p.status = 'live') as live
  from publications p join renders r on r.id = p.render_id
  group by 1
)
select
  sc.id                                    as script_id,
  sc.concept_id,
  c.channel_id,
  c.title,
  sc.created_at,

  case when coalesce(st.unpriced, 0) > 0 then null else st.settled_inr end as settled_inr,
  coalesce(st.unpriced, 0)                 as unpriced_settled_rows,

  case when coalesce(oe.unpriced, 0) > 0 then null else oe.open_inr end as open_estimate_inr,
  coalesce(oe.unpriced, 0)                 as unpriced_open_rows,

  coalesce(ar.rows_n, 0)                   as ledger_rows,
  cm.component_inr,

  coalesce(rd.renders, 0)                  as renders,
  coalesce(rd.renders_ready, 0)            as renders_ready,
  coalesce(pb.live, 0)                     as publications_live,

  case
    when coalesce(rd.renders_ready, 0) = 0 then 'not_rendered'
    when coalesce(st.unpriced, 0) > 0      then 'unpriced'
    when st.settled_inr is null            then 'nothing_settled'
    else 'countable'
  end                                      as denominator_state
from scripts sc
join concepts c on c.id = sc.concept_id
left join settled    st on st.script_id = sc.id
left join open_est   oe on oe.script_id = sc.id
left join all_rows   ar on ar.script_id = sc.id
left join components cm on cm.script_id = sc.id
left join rendered   rd on rd.script_id = sc.id
left join published  pb on pb.script_id = sc.id
where st.script_id is not null
   or oe.script_id is not null
   or rd.script_id is not null;

comment on view v_video_cost is
  'Cost per video, one row per script, with settled and committed spend kept apart and '
  'an unknown cost represented as null rather than as zero. denominator_state says '
  'whether the row may be averaged into a headline figure and, when not, why — so the '
  'excluded rows stay visible instead of being dropped by a where clause upstream.';

create view v_cost_unattributed as
select
  component,
  entry_kind,
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
  'exhaustive with it: a cost-per-video figure is only honest alongside what it excludes.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0027', 'studio_spend_reaches_its_video', array['-- applied from a lean bundle; text in supabase/migrations/0027_studio_spend_reaches_its_video.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0028_the_blocker_view_could_not_see_the_workspace.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0028 the_blocker_view_could_not_see_the_workspace'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0028', 'the_blocker_view_could_not_see_the_workspace', array['-- applied from a lean bundle; text in supabase/migrations/0028_the_blocker_view_could_not_see_the_workspace.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0029_a_blocker_that_was_not_blocking.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0029 a_blocker_that_was_not_blocking'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0029', 'a_blocker_that_was_not_blocking', array['-- applied from a lean bundle; text in supabase/migrations/0029_a_blocker_that_was_not_blocking.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0030_two_views_that_could_not_answer_their_own_question.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0030 two_views_that_could_not_answer_their_own_question'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0030', 'two_views_that_could_not_answer_their_own_question', array['-- applied from a lean bundle; text in supabase/migrations/0030_two_views_that_could_not_answer_their_own_question.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
commit;

-- ── Tell PostgREST the schema changed ───────────────────────────────────────
--
-- Outside the transaction, and not optional.
--
-- Supabase serves the app through PostgREST, which caches the schema in memory. The CLI
-- reloads that cache after a push; pasting SQL into the editor does not. So every table,
-- view and function this file created exists in the database and is invisible to the app
-- until this fires — and the error you get is "Could not find the table 'public.X' in the
-- schema cache", which reads exactly like the migration never ran.
--
-- That sentence cost an evening. It is in the file now so it cannot be forgotten.
notify pgrst, 'reload schema';

-- Confirm from the editor:
--   select version, name from supabase_migrations.schema_migrations order by version;
--   select slug, kind, is_enabled from integrations order by slug;
