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
