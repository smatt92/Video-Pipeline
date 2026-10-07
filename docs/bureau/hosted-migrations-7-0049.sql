-- Kiln — migrations 0049 to 0049, bundled for the Supabase SQL editor.
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
-- Migrations included (1):
--   0049  settings_and_trend_runs

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
  where version in ('0049');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0049_settings_and_trend_runs.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0049 settings_and_trend_runs'; end $kiln_progress$;

-- 0049 — Settings for generation, assembly and publishing; and a record of every trend run.
--
-- Forward-only. Ten columns added to channel_policy and one new table. No row is rewritten:
-- every default below is exactly the constant the code used before this migration, so a
-- channel's next render is identical until somebody changes a value on /settings.
--
-- ── Why columns, not constants ───────────────────────────────────────────────
--
-- src/lib/settings/sections.ts: anything that would otherwise be a magic number lives in
-- Settings, changeable without a deploy. Each column is read through ONE function,
-- `readTuning` (src/lib/settings/tuning.ts), by every code path that used the constant — the
-- estimate, the stills step and the assembler for pictures; the voice stage for the gaps;
-- the assembler for loudness, text sizes and the hook. Until this file is pasted, that
-- function falls back to the same constants and every Settings screen says so.
--
-- ── Ranges ───────────────────────────────────────────────────────────────────
--
-- The CHECKs equal the Zod ranges in tuning.ts (TuningSchema). The database refusing what
-- the form also refuses is the point: a value written by SQL or by a future caller that
-- skips the schema cannot reach a render.

alter table channel_policy
  add column seconds_per_picture   numeric not null default 6     check (seconds_per_picture between 2 and 30),
  add column max_pictures_per_shot int     not null default 4     check (max_pictures_per_shot between 1 and 12),
  add column line_gap_s            numeric not null default 0.18  check (line_gap_s between 0 and 2),
  add column tail_s                numeric not null default 0.6   check (tail_s between 0 and 5),
  add column loudness_target_lufs  numeric not null default -14   check (loudness_target_lufs between -24 and -9),
  add column caption_scale         numeric not null default 0.032 check (caption_scale between 0.016 and 0.08),
  add column hook_scale            numeric not null default 0.05  check (hook_scale between 0.02 and 0.12),
  add column hook_s                numeric not null default 2     check (hook_s between 0 and 6),
  add column made_for_kids_default boolean not null default false,
  add column synthetic_disclosure  text    not null default 'auto' check (synthetic_disclosure in ('auto', 'always'));

comment on column channel_policy.seconds_per_picture is
  'Illustrated shots: narration seconds each generated picture covers (was SECONDS_PER_PICTURE). '
  'Read by the estimate, the stills step and the assembler through readTuning, so they agree.';
comment on column channel_policy.max_pictures_per_shot is
  'Illustrated shots: the most pictures one shot gets, however long it runs (was MAX_PICTURES_PER_SHOT).';
comment on column channel_policy.line_gap_s is 'Voice: silence between lines, seconds (was LINE_GAP_S).';
comment on column channel_policy.tail_s is 'Voice: hold after the last word, seconds (was TAIL_S).';
comment on column channel_policy.loudness_target_lufs is
  'Assembly: integrated loudness the VO is normalised to before the render (was LOUDNESS_TARGET).';
comment on column channel_policy.caption_scale is 'Assembly: caption font size as a fraction of frame height (was 0.032).';
comment on column channel_policy.hook_scale is 'Assembly: hook title font size as a fraction of frame height (was 0.05).';
comment on column channel_policy.hook_s is 'Assembly: seconds the hook title holds at the start (was 2).';
comment on column channel_policy.made_for_kids_default is
  'Publishing: the madeForKids value every bundle carries. false for a channel not made for children.';
comment on column channel_policy.synthetic_disclosure is
  'Publishing: auto = the altered/synthetic flag is set when any shot is realistic (the '
  'platform''s own definition); always = set on every bundle. There is no "never".';

-- ═════════════════════════════════════════════════════════════════════════════
-- trend_runs — what every source said on every run
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Hosted trend_signals held 50 rows, all from one source, and nothing said why the others
-- were silent: Reddit had started refusing unauthenticated reads, and an empty list from a
-- refusing source looks exactly like a quiet day. A run is now a row, and each source's
-- answer ({source, ok, count, detail}) is in it, so /trends can say "Reddit: refused 403"
-- instead of saying nothing.

create table trend_runs (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid references channels(id) on delete cascade,
  trigger     text not null check (trigger in ('schedule', 'now', 'harness')),
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  inserted    int not null check (inserted >= 0),
  updated     int not null check (updated >= 0),
  sources     jsonb not null check (jsonb_typeof(sources) = 'array')
);
create index on trend_runs (channel_id, finished_at desc);

comment on table trend_runs is
  'One row per stage-1 run per channel: each source''s ok/count/detail. Written by runTrends; '
  'read by /trends. Service role only.';

alter table trend_runs enable row level security;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0049', 'settings_and_trend_runs', array[$kiln_0049$-- 0049 — Settings for generation, assembly and publishing; and a record of every trend run.
--
-- Forward-only. Ten columns added to channel_policy and one new table. No row is rewritten:
-- every default below is exactly the constant the code used before this migration, so a
-- channel's next render is identical until somebody changes a value on /settings.
--
-- ── Why columns, not constants ───────────────────────────────────────────────
--
-- src/lib/settings/sections.ts: anything that would otherwise be a magic number lives in
-- Settings, changeable without a deploy. Each column is read through ONE function,
-- `readTuning` (src/lib/settings/tuning.ts), by every code path that used the constant — the
-- estimate, the stills step and the assembler for pictures; the voice stage for the gaps;
-- the assembler for loudness, text sizes and the hook. Until this file is pasted, that
-- function falls back to the same constants and every Settings screen says so.
--
-- ── Ranges ───────────────────────────────────────────────────────────────────
--
-- The CHECKs equal the Zod ranges in tuning.ts (TuningSchema). The database refusing what
-- the form also refuses is the point: a value written by SQL or by a future caller that
-- skips the schema cannot reach a render.

alter table channel_policy
  add column seconds_per_picture   numeric not null default 6     check (seconds_per_picture between 2 and 30),
  add column max_pictures_per_shot int     not null default 4     check (max_pictures_per_shot between 1 and 12),
  add column line_gap_s            numeric not null default 0.18  check (line_gap_s between 0 and 2),
  add column tail_s                numeric not null default 0.6   check (tail_s between 0 and 5),
  add column loudness_target_lufs  numeric not null default -14   check (loudness_target_lufs between -24 and -9),
  add column caption_scale         numeric not null default 0.032 check (caption_scale between 0.016 and 0.08),
  add column hook_scale            numeric not null default 0.05  check (hook_scale between 0.02 and 0.12),
  add column hook_s                numeric not null default 2     check (hook_s between 0 and 6),
  add column made_for_kids_default boolean not null default false,
  add column synthetic_disclosure  text    not null default 'auto' check (synthetic_disclosure in ('auto', 'always'));

comment on column channel_policy.seconds_per_picture is
  'Illustrated shots: narration seconds each generated picture covers (was SECONDS_PER_PICTURE). '
  'Read by the estimate, the stills step and the assembler through readTuning, so they agree.';
comment on column channel_policy.max_pictures_per_shot is
  'Illustrated shots: the most pictures one shot gets, however long it runs (was MAX_PICTURES_PER_SHOT).';
comment on column channel_policy.line_gap_s is 'Voice: silence between lines, seconds (was LINE_GAP_S).';
comment on column channel_policy.tail_s is 'Voice: hold after the last word, seconds (was TAIL_S).';
comment on column channel_policy.loudness_target_lufs is
  'Assembly: integrated loudness the VO is normalised to before the render (was LOUDNESS_TARGET).';
comment on column channel_policy.caption_scale is 'Assembly: caption font size as a fraction of frame height (was 0.032).';
comment on column channel_policy.hook_scale is 'Assembly: hook title font size as a fraction of frame height (was 0.05).';
comment on column channel_policy.hook_s is 'Assembly: seconds the hook title holds at the start (was 2).';
comment on column channel_policy.made_for_kids_default is
  'Publishing: the madeForKids value every bundle carries. false for a channel not made for children.';
comment on column channel_policy.synthetic_disclosure is
  'Publishing: auto = the altered/synthetic flag is set when any shot is realistic (the '
  'platform''s own definition); always = set on every bundle. There is no "never".';

-- ═════════════════════════════════════════════════════════════════════════════
-- trend_runs — what every source said on every run
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Hosted trend_signals held 50 rows, all from one source, and nothing said why the others
-- were silent: Reddit had started refusing unauthenticated reads, and an empty list from a
-- refusing source looks exactly like a quiet day. A run is now a row, and each source's
-- answer ({source, ok, count, detail}) is in it, so /trends can say "Reddit: refused 403"
-- instead of saying nothing.

create table trend_runs (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid references channels(id) on delete cascade,
  trigger     text not null check (trigger in ('schedule', 'now', 'harness')),
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  inserted    int not null check (inserted >= 0),
  updated     int not null check (updated >= 0),
  sources     jsonb not null check (jsonb_typeof(sources) = 'array')
);
create index on trend_runs (channel_id, finished_at desc);

comment on table trend_runs is
  'One row per stage-1 run per channel: each source''s ok/count/detail. Written by runTrends; '
  'read by /trends. Service role only.';

alter table trend_runs enable row level security;
$kiln_0049$])
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
