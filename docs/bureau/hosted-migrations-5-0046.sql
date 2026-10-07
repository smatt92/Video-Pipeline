-- Kiln — migrations 0046 to 0046, bundled for the Supabase SQL editor.
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
--   0046  multichannel

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
  where version in ('0046');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0046_multichannel.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0046 multichannel'; end $kiln_progress$;

-- 0046 — Several channels, two publish targets each, trends per channel, voice overrides,
-- music beds.
--
-- Forward-only. Four new tables and one nullable column. No DROP, no rewrite of an existing
-- row. Every reader of these tables in src/ tolerates them being absent (the bundle may not be
-- pasted yet): a missing table reads as "no rows", never as an error that blocks a screen.
--
-- ── Why publish targets are a table and not channels.platform ─────────────────
--
-- `channels.platform` is one value, and a channel now publishes the same cut to YouTube AND
-- Instagram. Rewriting that column would break every reader that treats it as "the
-- platform"; a child table keyed (channel, platform) adds the second target without moving
-- the first. The existing value is copied in as that channel's first target.

create table channel_publish_targets (
  channel_id  uuid not null references channels(id) on delete cascade,
  platform    text not null check (platform in ('youtube', 'instagram')),
  enabled     boolean not null default true,
  handle      text,
  external_id text,
  created_at  timestamptz not null default now(),
  primary key (channel_id, platform)
);

comment on table channel_publish_targets is
  'Where a channel publishes. One row per (channel, platform). Instagram is manual (download, '
  'copy, mark posted) until Meta app review clears — decision 0020.';

insert into channel_publish_targets (channel_id, platform, handle, external_id)
select id, platform, handle, external_id from channels
on conflict do nothing;

-- The Bureau publishes Reels too (Sahil, 07-Oct-2026). Its account id is filled in from the
-- Add channel / channel settings form; null here means "not linked yet", not "no target".
insert into channel_publish_targets (channel_id, platform)
select id, 'instagram' from channels where id = 'b0000000-0000-4000-8000-000000000001'
on conflict do nothing;

-- ── Voice overrides ──────────────────────────────────────────────────────────
--
-- The bible's locked voice is a commit; Vercel cannot commit. A row here wins over the bible
-- for that (channel, character) and is read by the same routing predicate. Vendor-neutral
-- column names on purpose: the generated DB types live outside the driver layer (rule 1).

create table channel_voice_overrides (
  channel_id     uuid not null references channels(id) on delete cascade,
  character_slug text not null check (character_slug ~ '^[a-z_]+$'),
  voice_provider text not null,
  voice_id       text not null check (length(voice_id) > 0),
  note           text,
  set_by         uuid,
  set_at         timestamptz not null default now(),
  primary key (channel_id, character_slug)
);

comment on table channel_voice_overrides is
  'A voice chosen on the Voices screen. Wins over channels/<slug>/characters.json for that '
  'character; deleting the row falls back to the bible.';

-- ── Trends per channel ───────────────────────────────────────────────────────
--
-- Nullable: rows captured before this migration belong to no channel, and stay readable as
-- workspace-wide signals rather than being guessed into one.

alter table trend_signals add column channel_id uuid references channels(id) on delete cascade;
create index trend_signals_channel_captured_idx on trend_signals (channel_id, captured_at desc);

-- ── Music beds ───────────────────────────────────────────────────────────────
--
-- The bed ids (bed_*) are named in each series file. A row here is the audio uploaded for one
-- of them; the bytes go browser → bucket by presigned PUT (rule 2), never through Vercel.

create table music_beds (
  channel_id   uuid not null references channels(id) on delete cascade,
  bed_id       text not null check (bed_id ~ '^bed_[a-z0-9_]+$'),
  storage_key  text not null,
  content_type text not null,
  bytes        bigint check (bytes is null or bytes > 0),
  uploaded_at  timestamptz not null default now(),
  primary key (channel_id, bed_id)
);

create table music_bed_defaults (
  channel_id uuid not null,
  series     text not null,
  bed_id     text not null,
  set_at     timestamptz not null default now(),
  primary key (channel_id, series),
  foreign key (channel_id, bed_id) references music_beds (channel_id, bed_id) on delete cascade
);

comment on table music_bed_defaults is
  'The bed a series uses when a brief does not pick one. Must be an uploaded bed.';

alter table channel_publish_targets  enable row level security;
alter table channel_voice_overrides  enable row level security;
alter table music_beds               enable row level security;
alter table music_bed_defaults       enable row level security;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0046', 'multichannel', array[$kiln_0046$-- 0046 — Several channels, two publish targets each, trends per channel, voice overrides,
-- music beds.
--
-- Forward-only. Four new tables and one nullable column. No DROP, no rewrite of an existing
-- row. Every reader of these tables in src/ tolerates them being absent (the bundle may not be
-- pasted yet): a missing table reads as "no rows", never as an error that blocks a screen.
--
-- ── Why publish targets are a table and not channels.platform ─────────────────
--
-- `channels.platform` is one value, and a channel now publishes the same cut to YouTube AND
-- Instagram. Rewriting that column would break every reader that treats it as "the
-- platform"; a child table keyed (channel, platform) adds the second target without moving
-- the first. The existing value is copied in as that channel's first target.

create table channel_publish_targets (
  channel_id  uuid not null references channels(id) on delete cascade,
  platform    text not null check (platform in ('youtube', 'instagram')),
  enabled     boolean not null default true,
  handle      text,
  external_id text,
  created_at  timestamptz not null default now(),
  primary key (channel_id, platform)
);

comment on table channel_publish_targets is
  'Where a channel publishes. One row per (channel, platform). Instagram is manual (download, '
  'copy, mark posted) until Meta app review clears — decision 0020.';

insert into channel_publish_targets (channel_id, platform, handle, external_id)
select id, platform, handle, external_id from channels
on conflict do nothing;

-- The Bureau publishes Reels too (Sahil, 07-Oct-2026). Its account id is filled in from the
-- Add channel / channel settings form; null here means "not linked yet", not "no target".
insert into channel_publish_targets (channel_id, platform)
select id, 'instagram' from channels where id = 'b0000000-0000-4000-8000-000000000001'
on conflict do nothing;

-- ── Voice overrides ──────────────────────────────────────────────────────────
--
-- The bible's locked voice is a commit; Vercel cannot commit. A row here wins over the bible
-- for that (channel, character) and is read by the same routing predicate. Vendor-neutral
-- column names on purpose: the generated DB types live outside the driver layer (rule 1).

create table channel_voice_overrides (
  channel_id     uuid not null references channels(id) on delete cascade,
  character_slug text not null check (character_slug ~ '^[a-z_]+$'),
  voice_provider text not null,
  voice_id       text not null check (length(voice_id) > 0),
  note           text,
  set_by         uuid,
  set_at         timestamptz not null default now(),
  primary key (channel_id, character_slug)
);

comment on table channel_voice_overrides is
  'A voice chosen on the Voices screen. Wins over channels/<slug>/characters.json for that '
  'character; deleting the row falls back to the bible.';

-- ── Trends per channel ───────────────────────────────────────────────────────
--
-- Nullable: rows captured before this migration belong to no channel, and stay readable as
-- workspace-wide signals rather than being guessed into one.

alter table trend_signals add column channel_id uuid references channels(id) on delete cascade;
create index trend_signals_channel_captured_idx on trend_signals (channel_id, captured_at desc);

-- ── Music beds ───────────────────────────────────────────────────────────────
--
-- The bed ids (bed_*) are named in each series file. A row here is the audio uploaded for one
-- of them; the bytes go browser → bucket by presigned PUT (rule 2), never through Vercel.

create table music_beds (
  channel_id   uuid not null references channels(id) on delete cascade,
  bed_id       text not null check (bed_id ~ '^bed_[a-z0-9_]+$'),
  storage_key  text not null,
  content_type text not null,
  bytes        bigint check (bytes is null or bytes > 0),
  uploaded_at  timestamptz not null default now(),
  primary key (channel_id, bed_id)
);

create table music_bed_defaults (
  channel_id uuid not null,
  series     text not null,
  bed_id     text not null,
  set_at     timestamptz not null default now(),
  primary key (channel_id, series),
  foreign key (channel_id, bed_id) references music_beds (channel_id, bed_id) on delete cascade
);

comment on table music_bed_defaults is
  'The bed a series uses when a brief does not pick one. Must be an uploaded bed.';

alter table channel_publish_targets  enable row level security;
alter table channel_voice_overrides  enable row level security;
alter table music_beds               enable row level security;
alter table music_bed_defaults       enable row level security;
$kiln_0046$])
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
