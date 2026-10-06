-- Kiln — migrations 0043 to 0043, bundled for the Supabase SQL editor.
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
--   0043  close_secret_delete_to_anon

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
  where version in ('0043');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0043_close_secret_delete_to_anon.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0043 close_secret_delete_to_anon'; end $kiln_progress$;

-- 0043 — Close two SECURITY DEFINER functions to anon and authenticated.
--
-- Found by the Supabase security advisor on the hosted project, 2026-10-06, minutes after
-- 0003–0042 were applied:
--
--   public.integration_secret_delete(uuid, text)  executable by anon and authenticated
--   public.rls_auto_enable()                      executable by anon and authenticated
--
-- The first is a defect in 0007. That migration revoked `public` from all three Vault
-- functions and then revoked anon and authenticated from `integration_secrets_read` and
-- `integration_secret_put` — and not from `integration_secret_delete`. Revoking `public`
-- is not enough on Supabase: its default privileges grant EXECUTE on every new function in
-- `public` to anon and authenticated *by name*, so a role-specific grant survives a revoke
-- from PUBLIC. The result was that anyone holding the anon key — every visitor to the app —
-- could call /rest/v1/rpc/integration_secret_delete and delete a stored vendor credential.
-- Nothing was stored when this was found, so nothing was exposed; it would have been the
-- moment the first key was saved under Settings → Integrations.
--
-- The second, rls_auto_enable(), is not defined anywhere in supabase/migrations/ — the
-- platform installs it (its event trigger turns RLS on for new tables). It is guarded by
-- existence rather than assumed. Revoking EXECUTE does not stop an event trigger firing:
-- PostgreSQL does not check EXECUTE on an event trigger's function.
--
-- The only legitimate caller of integration_secret_delete is src/lib/integrations/vault.ts,
-- which runs with the service role; its grant is restated so this migration cannot narrow
-- it by accident.
--
-- Forward-only, no DROP. Roles are guarded so the sequence still applies on plain Postgres
-- in CI, the same pattern 0007 uses.

-- Restated rather than assumed from 0007: this migration's claim is "no role but the
-- service role can call it", and that claim should not depend on an earlier file.
revoke all on function public.integration_secret_delete(uuid, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.integration_secret_delete(uuid, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.integration_secret_delete(uuid, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.integration_secret_delete(uuid, text) to service_role';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0
  ) then
    execute 'revoke all on function public.rls_auto_enable() from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'revoke all on function public.rls_auto_enable() from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke all on function public.rls_auto_enable() from authenticated';
    end if;
  end if;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0043', 'close_secret_delete_to_anon', array[$kiln_0043$-- 0043 — Close two SECURITY DEFINER functions to anon and authenticated.
--
-- Found by the Supabase security advisor on the hosted project, 2026-10-06, minutes after
-- 0003–0042 were applied:
--
--   public.integration_secret_delete(uuid, text)  executable by anon and authenticated
--   public.rls_auto_enable()                      executable by anon and authenticated
--
-- The first is a defect in 0007. That migration revoked `public` from all three Vault
-- functions and then revoked anon and authenticated from `integration_secrets_read` and
-- `integration_secret_put` — and not from `integration_secret_delete`. Revoking `public`
-- is not enough on Supabase: its default privileges grant EXECUTE on every new function in
-- `public` to anon and authenticated *by name*, so a role-specific grant survives a revoke
-- from PUBLIC. The result was that anyone holding the anon key — every visitor to the app —
-- could call /rest/v1/rpc/integration_secret_delete and delete a stored vendor credential.
-- Nothing was stored when this was found, so nothing was exposed; it would have been the
-- moment the first key was saved under Settings → Integrations.
--
-- The second, rls_auto_enable(), is not defined anywhere in supabase/migrations/ — the
-- platform installs it (its event trigger turns RLS on for new tables). It is guarded by
-- existence rather than assumed. Revoking EXECUTE does not stop an event trigger firing:
-- PostgreSQL does not check EXECUTE on an event trigger's function.
--
-- The only legitimate caller of integration_secret_delete is src/lib/integrations/vault.ts,
-- which runs with the service role; its grant is restated so this migration cannot narrow
-- it by accident.
--
-- Forward-only, no DROP. Roles are guarded so the sequence still applies on plain Postgres
-- in CI, the same pattern 0007 uses.

-- Restated rather than assumed from 0007: this migration's claim is "no role but the
-- service role can call it", and that claim should not depend on an earlier file.
revoke all on function public.integration_secret_delete(uuid, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.integration_secret_delete(uuid, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.integration_secret_delete(uuid, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.integration_secret_delete(uuid, text) to service_role';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0
  ) then
    execute 'revoke all on function public.rls_auto_enable() from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'revoke all on function public.rls_auto_enable() from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke all on function public.rls_auto_enable() from authenticated';
    end if;
  end if;
end;
$$;
$kiln_0043$])
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
