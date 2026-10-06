-- Kiln — migrations 0045 to 0045, bundled for the Supabase SQL editor.
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
--   0045  mcp_oauth

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
  where version in ('0045');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0045_mcp_oauth.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0045 mcp_oauth'; end $kiln_progress$;

-- 0045 — OAuth 2.1 for /api/mcp (decision 0016), and two onboarding ticks that lost their meaning.
--
-- Forward-only. Four columns on mcp_tokens, three new tables, one `create or replace` of the
-- scope check, and one UPDATE of onboarding progress. No DROP.
--
-- ── Why an OAuth access token is an mcp_tokens row ─────────────────────────────
--
-- Settings → MCP tokens revokes by setting mcp_tokens.revoked_at, and every Bureau decision
-- function re-checks it in the database. If an OAuth connection lived anywhere else it would
-- need its own revoke button, its own scope column and its own copy of that check, and the
-- first one somebody forgot would be the one that kept working. So a *connection* (one
-- consent, one grant) is one mcp_tokens row: `token_hash` holds the SHA-256 of the current
-- access token and is replaced on every refresh, `expires_at` is when that access token
-- stops, and the refresh tokens hang off the row. Revoking the row ends the access token now
-- and refuses every refresh after it.
--
-- A static kb_ token is `kind = 'static'` and never expires, exactly as before (0012 #2).

alter table mcp_tokens
  add column kind text not null default 'static' check (kind in ('static', 'oauth')),
  add column expires_at timestamptz,
  add column oauth_client_id text,
  add column oauth_redirect_uri text;

alter table mcp_tokens add constraint mcp_tokens_kind_shape check (
  (kind = 'static' and expires_at is null and oauth_client_id is null and oauth_redirect_uri is null)
  or
  (kind = 'oauth' and expires_at is not null and oauth_client_id is not null and oauth_redirect_uri is not null)
);

comment on column mcp_tokens.kind is
  'static: minted on Settings, shown once, never expires. oauth: one consented connection from '
  'a Claude connector; token_hash is the current access token and rotates on refresh.';
comment on column mcp_tokens.expires_at is
  'When the current OAuth access token stops working. Null for static tokens, which do not expire.';

-- ── Clients ──────────────────────────────────────────────────────────────────
-- Two ways in. A Client ID Metadata Document: client_id IS an https URL the client publishes,
-- fetched at authorize time and cached here. Dynamic Client Registration: the client POSTs
-- its metadata and gets a kiln_dcr_ id. Either way the redirect URIs must be on the
-- allow-list in src/lib/oauth/policy.ts; this table never widens it.
create table oauth_clients (
  client_id     text primary key,
  registration  text not null check (registration in ('metadata_document', 'dynamic')),
  client_name   text not null,
  redirect_uris text[] not null check (cardinality(redirect_uris) > 0),
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table oauth_clients is
  'OAuth clients of /api/mcp: metadata-document clients cached on fetch, dynamic registrations '
  'stored on POST. Redirect URIs here are a subset of the code allow-list, never a widening.';

-- ── Authorization codes ──────────────────────────────────────────────────────
-- Hashed like every other credential here. Single use is a column, not a delete: a code
-- presented twice must be *recognised* as a replay so the connection it minted can be
-- revoked (OAuth 2.1 §4.1.3), and a deleted row cannot be recognised.
create table oauth_codes (
  code_hash      text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  client_id      text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope          text not null check (scope in ('approver', 'agent')),
  resource       text not null,
  profile_id     uuid not null references profiles(id) on delete cascade,
  channel_id     uuid not null references channels(id) on delete cascade,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  grant_id       uuid references mcp_tokens(id) on delete set null
);

comment on table oauth_codes is
  'Authorization codes, SHA-256 only. consumed_at makes them single-use and lets a replay be '
  'detected; grant_id is the connection the code minted, revoked if the code comes back.';

-- ── Refresh tokens ───────────────────────────────────────────────────────────
-- Rotated: each use marks the row rotated and issues a new one. A rotated token presented
-- again means two parties hold it, so the whole connection is revoked.
create table oauth_refresh_tokens (
  token_hash  text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id    uuid not null references mcp_tokens(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  rotated_at  timestamptz
);
create index on oauth_refresh_tokens (grant_id);

comment on table oauth_refresh_tokens is
  'Refresh tokens for OAuth connections (mcp_tokens rows of kind oauth), SHA-256 only. '
  'Single use: a rotated token presented again revokes the connection.';

-- Deny by default, as 0039 does for every table. The event trigger would do this where it
-- exists; it does not exist on a project whose migrations ran without superuser.
alter table oauth_clients        enable row level security;
alter table oauth_codes          enable row level security;
alter table oauth_refresh_tokens enable row level security;

-- ── The scope check learns expiry ────────────────────────────────────────────
-- TypeScript refuses an expired access token before any tool runs. This is the second
-- check, in the place every decision already passes through, for the same reason
-- revoked_at is checked twice: a decision function is callable by anything holding the
-- service role, not only by /api/mcp.
create or replace function bureau_require_scope(p_token uuid, p_scope text) returns mcp_tokens
language plpgsql as $$
declare t mcp_tokens;
begin
  select * into t from mcp_tokens where id = p_token;
  if not found or t.revoked_at is not null then
    raise exception 'token_invalid: token % is unknown or revoked', p_token;
  end if;
  if t.expires_at is not null and t.expires_at <= now() then
    raise exception 'token_invalid: token % has expired', p_token;
  end if;
  if p_scope = 'approver' and t.scope <> 'approver' then
    raise exception 'scope_denied: this action needs the approver scope; token % is %', p_token, t.scope;
  end if;
  return t;
end $$;

-- ── Onboarding: steps 4 and 5 changed meaning in 0044 ────────────────────────
-- Prompt I re-pointed steps 4 (generation) and 5 (voice) at one vendor and kept their
-- numbers. A profile that passed either under the old vendors still shows a tick for a key
-- that has never been checked. Remove the tick unless the integration those steps now
-- configure has actually verified; the step re-earns it with one real call.
update profiles
set onboarding_completed_steps = array_remove(array_remove(onboarding_completed_steps, 4), 5)
where (4 = any(onboarding_completed_steps) or 5 = any(onboarding_completed_steps))
  and not exists (
    select 1 from integrations where slug = 'runway' and last_verified_at is not null
  );

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0045', 'mcp_oauth', array[$kiln_0045$-- 0045 — OAuth 2.1 for /api/mcp (decision 0016), and two onboarding ticks that lost their meaning.
--
-- Forward-only. Four columns on mcp_tokens, three new tables, one `create or replace` of the
-- scope check, and one UPDATE of onboarding progress. No DROP.
--
-- ── Why an OAuth access token is an mcp_tokens row ─────────────────────────────
--
-- Settings → MCP tokens revokes by setting mcp_tokens.revoked_at, and every Bureau decision
-- function re-checks it in the database. If an OAuth connection lived anywhere else it would
-- need its own revoke button, its own scope column and its own copy of that check, and the
-- first one somebody forgot would be the one that kept working. So a *connection* (one
-- consent, one grant) is one mcp_tokens row: `token_hash` holds the SHA-256 of the current
-- access token and is replaced on every refresh, `expires_at` is when that access token
-- stops, and the refresh tokens hang off the row. Revoking the row ends the access token now
-- and refuses every refresh after it.
--
-- A static kb_ token is `kind = 'static'` and never expires, exactly as before (0012 #2).

alter table mcp_tokens
  add column kind text not null default 'static' check (kind in ('static', 'oauth')),
  add column expires_at timestamptz,
  add column oauth_client_id text,
  add column oauth_redirect_uri text;

alter table mcp_tokens add constraint mcp_tokens_kind_shape check (
  (kind = 'static' and expires_at is null and oauth_client_id is null and oauth_redirect_uri is null)
  or
  (kind = 'oauth' and expires_at is not null and oauth_client_id is not null and oauth_redirect_uri is not null)
);

comment on column mcp_tokens.kind is
  'static: minted on Settings, shown once, never expires. oauth: one consented connection from '
  'a Claude connector; token_hash is the current access token and rotates on refresh.';
comment on column mcp_tokens.expires_at is
  'When the current OAuth access token stops working. Null for static tokens, which do not expire.';

-- ── Clients ──────────────────────────────────────────────────────────────────
-- Two ways in. A Client ID Metadata Document: client_id IS an https URL the client publishes,
-- fetched at authorize time and cached here. Dynamic Client Registration: the client POSTs
-- its metadata and gets a kiln_dcr_ id. Either way the redirect URIs must be on the
-- allow-list in src/lib/oauth/policy.ts; this table never widens it.
create table oauth_clients (
  client_id     text primary key,
  registration  text not null check (registration in ('metadata_document', 'dynamic')),
  client_name   text not null,
  redirect_uris text[] not null check (cardinality(redirect_uris) > 0),
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table oauth_clients is
  'OAuth clients of /api/mcp: metadata-document clients cached on fetch, dynamic registrations '
  'stored on POST. Redirect URIs here are a subset of the code allow-list, never a widening.';

-- ── Authorization codes ──────────────────────────────────────────────────────
-- Hashed like every other credential here. Single use is a column, not a delete: a code
-- presented twice must be *recognised* as a replay so the connection it minted can be
-- revoked (OAuth 2.1 §4.1.3), and a deleted row cannot be recognised.
create table oauth_codes (
  code_hash      text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  client_id      text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope          text not null check (scope in ('approver', 'agent')),
  resource       text not null,
  profile_id     uuid not null references profiles(id) on delete cascade,
  channel_id     uuid not null references channels(id) on delete cascade,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  grant_id       uuid references mcp_tokens(id) on delete set null
);

comment on table oauth_codes is
  'Authorization codes, SHA-256 only. consumed_at makes them single-use and lets a replay be '
  'detected; grant_id is the connection the code minted, revoked if the code comes back.';

-- ── Refresh tokens ───────────────────────────────────────────────────────────
-- Rotated: each use marks the row rotated and issues a new one. A rotated token presented
-- again means two parties hold it, so the whole connection is revoked.
create table oauth_refresh_tokens (
  token_hash  text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id    uuid not null references mcp_tokens(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  rotated_at  timestamptz
);
create index on oauth_refresh_tokens (grant_id);

comment on table oauth_refresh_tokens is
  'Refresh tokens for OAuth connections (mcp_tokens rows of kind oauth), SHA-256 only. '
  'Single use: a rotated token presented again revokes the connection.';

-- Deny by default, as 0039 does for every table. The event trigger would do this where it
-- exists; it does not exist on a project whose migrations ran without superuser.
alter table oauth_clients        enable row level security;
alter table oauth_codes          enable row level security;
alter table oauth_refresh_tokens enable row level security;

-- ── The scope check learns expiry ────────────────────────────────────────────
-- TypeScript refuses an expired access token before any tool runs. This is the second
-- check, in the place every decision already passes through, for the same reason
-- revoked_at is checked twice: a decision function is callable by anything holding the
-- service role, not only by /api/mcp.
create or replace function bureau_require_scope(p_token uuid, p_scope text) returns mcp_tokens
language plpgsql as $$
declare t mcp_tokens;
begin
  select * into t from mcp_tokens where id = p_token;
  if not found or t.revoked_at is not null then
    raise exception 'token_invalid: token % is unknown or revoked', p_token;
  end if;
  if t.expires_at is not null and t.expires_at <= now() then
    raise exception 'token_invalid: token % has expired', p_token;
  end if;
  if p_scope = 'approver' and t.scope <> 'approver' then
    raise exception 'scope_denied: this action needs the approver scope; token % is %', p_token, t.scope;
  end if;
  return t;
end $$;

-- ── Onboarding: steps 4 and 5 changed meaning in 0044 ────────────────────────
-- Prompt I re-pointed steps 4 (generation) and 5 (voice) at one vendor and kept their
-- numbers. A profile that passed either under the old vendors still shows a tick for a key
-- that has never been checked. Remove the tick unless the integration those steps now
-- configure has actually verified; the step re-earns it with one real call.
update profiles
set onboarding_completed_steps = array_remove(array_remove(onboarding_completed_steps, 4), 5)
where (4 = any(onboarding_completed_steps) or 5 = any(onboarding_completed_steps))
  and not exists (
    select 1 from integrations where slug = 'runway' and last_verified_at is not null
  );
$kiln_0045$])
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
