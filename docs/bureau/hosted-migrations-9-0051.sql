-- Kiln — migrations 0051 to 0051, bundled for the Supabase SQL editor.
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
--   0051  trend_relevance_voice_overflow

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
  where version in ('0051');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0051_trend_relevance_voice_overflow.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0051 trend_relevance_voice_overflow'; end $kiln_progress$;

-- 0051 — Trend relevance for a channel, and the voice overflow switch.
--
-- Forward-only. Two columns on trend_signals, two on channel_policy, two new tables. No row is
-- rewritten: relevance starts NULL everywhere (never scored — not "irrelevant"), and
-- voice_overflow defaults to false, which is exactly today's behaviour (wait out the limit).
--
-- ── Relevance (Prompt O5 B) ──────────────────────────────────────────────────
--
-- /trends listed raw signals — celebrities, stock tickers, phone unboxings — none of which a
-- science-explainer channel can use. Each term is now embedded ONCE (trend_term_embeddings,
-- keyed by the term's text, so the same headline seen by two channels or on four runs a day
-- is one embedding) and scored by cosine similarity against the channel's niche vector
-- (channel_niche_vectors: the bible premise + its series + the topic calendar's topics,
-- re-embedded only when that text changes, never per page view).
--
-- NULL relevance means the term could not be scored (no embedder, the vendor refused, the
-- niche could not be built) and is never written as 0 — 0 is a measurement ("orthogonal to
-- the niche"), NULL is its absence. The CHECK keeps the value a cosine.
--
-- ── Voice overflow (Prompt O5 D) ─────────────────────────────────────────────
--
-- When the main voice model's daily limit is reached, re-voice the WHOLE episode on the
-- second model instead of waiting. Per channel, off by default.

alter table trend_signals
  add column relevance           numeric check (relevance between -1 and 1),
  add column relevance_scored_at timestamptz;

comment on column trend_signals.relevance is
  'Cosine similarity of this term''s embedding to the channel''s niche vector (channel_niche_vectors), '
  'written by runTrends. NULL = not scored (no embedder / vendor refused / no niche vector) — never 0.';

create index trend_signals_channel_relevance on trend_signals (channel_id, relevance desc nulls last);

create table trend_term_embeddings (
  term       text primary key,
  model      text not null,
  embedding  extensions.vector(768) not null,
  created_at timestamptz not null default now()
);
comment on table trend_term_embeddings is
  'One embedding per distinct trend term text, so a term is embedded once however many runs '
  'and channels see it. Written by runTrends; service role only.';
alter table trend_term_embeddings enable row level security;

create table channel_niche_vectors (
  channel_id   uuid primary key references channels(id) on delete cascade,
  model        text not null,
  embedding    extensions.vector(768) not null,
  -- sha256 of the texts the vector was built from; a run rebuilds only when it changes.
  source_hash  text not null,
  source_count int  not null check (source_count > 0),
  source_texts jsonb not null check (jsonb_typeof(source_texts) = 'array'),
  built_at     timestamptz not null default now()
);
comment on table channel_niche_vectors is
  'The channel''s niche as one unit vector: the normalised mean of the embeddings of its bible '
  'premise, its series and its topic calendar''s topics. Rebuilt by runTrends when source_hash '
  'changes; read by runTrends to score signals. Service role only.';
alter table channel_niche_vectors enable row level security;

alter table channel_policy
  add column relevance_threshold numeric not null default 0.65 check (relevance_threshold between 0 and 1),
  add column voice_overflow      boolean not null default false;

comment on column channel_policy.relevance_threshold is
  'Trends: a signal at or above this relevance is "for this channel" on /trends and is shown to '
  'stage 2 first. Settings → Generation.';
comment on column channel_policy.voice_overflow is
  'Voice: when the main TTS model''s daily limit is reached, re-voice the whole episode on the '
  'second model instead of waiting (never mixed within an episode). Settings → Generation.';

-- What the relevance pass said on each run ({scored, unscored, detail, embedded, nicheRebuilt}),
-- so /trends can say "not scored: the vendor refused" rather than showing blank scores.
alter table trend_runs add column relevance jsonb;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0051', 'trend_relevance_voice_overflow', array[$kiln_0051$-- 0051 — Trend relevance for a channel, and the voice overflow switch.
--
-- Forward-only. Two columns on trend_signals, two on channel_policy, two new tables. No row is
-- rewritten: relevance starts NULL everywhere (never scored — not "irrelevant"), and
-- voice_overflow defaults to false, which is exactly today's behaviour (wait out the limit).
--
-- ── Relevance (Prompt O5 B) ──────────────────────────────────────────────────
--
-- /trends listed raw signals — celebrities, stock tickers, phone unboxings — none of which a
-- science-explainer channel can use. Each term is now embedded ONCE (trend_term_embeddings,
-- keyed by the term's text, so the same headline seen by two channels or on four runs a day
-- is one embedding) and scored by cosine similarity against the channel's niche vector
-- (channel_niche_vectors: the bible premise + its series + the topic calendar's topics,
-- re-embedded only when that text changes, never per page view).
--
-- NULL relevance means the term could not be scored (no embedder, the vendor refused, the
-- niche could not be built) and is never written as 0 — 0 is a measurement ("orthogonal to
-- the niche"), NULL is its absence. The CHECK keeps the value a cosine.
--
-- ── Voice overflow (Prompt O5 D) ─────────────────────────────────────────────
--
-- When the main voice model's daily limit is reached, re-voice the WHOLE episode on the
-- second model instead of waiting. Per channel, off by default.

alter table trend_signals
  add column relevance           numeric check (relevance between -1 and 1),
  add column relevance_scored_at timestamptz;

comment on column trend_signals.relevance is
  'Cosine similarity of this term''s embedding to the channel''s niche vector (channel_niche_vectors), '
  'written by runTrends. NULL = not scored (no embedder / vendor refused / no niche vector) — never 0.';

create index trend_signals_channel_relevance on trend_signals (channel_id, relevance desc nulls last);

create table trend_term_embeddings (
  term       text primary key,
  model      text not null,
  embedding  extensions.vector(768) not null,
  created_at timestamptz not null default now()
);
comment on table trend_term_embeddings is
  'One embedding per distinct trend term text, so a term is embedded once however many runs '
  'and channels see it. Written by runTrends; service role only.';
alter table trend_term_embeddings enable row level security;

create table channel_niche_vectors (
  channel_id   uuid primary key references channels(id) on delete cascade,
  model        text not null,
  embedding    extensions.vector(768) not null,
  -- sha256 of the texts the vector was built from; a run rebuilds only when it changes.
  source_hash  text not null,
  source_count int  not null check (source_count > 0),
  source_texts jsonb not null check (jsonb_typeof(source_texts) = 'array'),
  built_at     timestamptz not null default now()
);
comment on table channel_niche_vectors is
  'The channel''s niche as one unit vector: the normalised mean of the embeddings of its bible '
  'premise, its series and its topic calendar''s topics. Rebuilt by runTrends when source_hash '
  'changes; read by runTrends to score signals. Service role only.';
alter table channel_niche_vectors enable row level security;

alter table channel_policy
  add column relevance_threshold numeric not null default 0.65 check (relevance_threshold between 0 and 1),
  add column voice_overflow      boolean not null default false;

comment on column channel_policy.relevance_threshold is
  'Trends: a signal at or above this relevance is "for this channel" on /trends and is shown to '
  'stage 2 first. Settings → Generation.';
comment on column channel_policy.voice_overflow is
  'Voice: when the main TTS model''s daily limit is reached, re-voice the whole episode on the '
  'second model instead of waiting (never mixed within an episode). Settings → Generation.';

-- What the relevance pass said on each run ({scored, unscored, detail, embedded, nicheRebuilt}),
-- so /trends can say "not scored: the vendor refused" rather than showing blank scores.
alter table trend_runs add column relevance jsonb;
$kiln_0051$])
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
