-- 0039 — Row-level security on every table, and no anonymous reads of any view.
--
-- Supersedes decision 0003 ("no RLS in phase 1"), whose own consequences section made RLS a
-- hard prerequisite of real publishing authority and channel tokens. Both arrive with the
-- Bureau: mcp_tokens, publish bundles, an approver scope. Decision 0012 records the switch.
--
-- The shape is deny-by-default, not permissive policies (0003 rejected those, correctly: a
-- policy that allows everything looks like a control and is not one):
--
--   • every public table: RLS enabled, NO policy → anon and authenticated read nothing;
--   • the one exception: a signed-in user may read and update their own profiles row, which
--     the middleware does with the user's session (src/middleware.ts) — nothing else does;
--   • views run as their owner and would bypass RLS, so anon/authenticated lose SELECT on
--     every view instead;
--   • the service role (server components, Trigger tasks, /api/mcp) bypasses RLS as before.
--
-- Written to apply on a plain Postgres too (the harnesses' scratch databases have no auth
-- schema and no anon role), so the Supabase-only parts are guarded.

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

do $$
begin
  if to_regprocedure('auth.uid()') is not null and to_regrole('authenticated') is not null then
    execute $p$create policy profiles_self_read on public.profiles
               for select to authenticated using (id = auth.uid())$p$;
    execute $p$create policy profiles_self_update on public.profiles
               for update to authenticated using (id = auth.uid()) with check (id = auth.uid())$p$;
  end if;
end $$;

do $$
declare v record;
begin
  if to_regrole('anon') is null then
    return;
  end if;
  for v in select viewname from pg_views where schemaname = 'public' loop
    execute format('revoke all on public.%I from anon, authenticated', v.viewname);
  end loop;
end $$;

-- New tables get RLS too: an event trigger rather than a convention, because a convention is
-- what the next migration forgets. Requires superuser; on a role without it the DO block
-- reports and continues, and check:rls (verify:bureau §0) still catches a table without it.
create or replace function public.rls_on_new_tables() returns event_trigger
language plpgsql as $$
declare obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' loop
    if obj.schema_name = 'public' then
      execute format('alter table %s enable row level security', obj.object_identity);
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'kiln_rls_on_new_tables') then
    create event trigger kiln_rls_on_new_tables on ddl_command_end
      when tag in ('CREATE TABLE') execute function public.rls_on_new_tables();
  end if;
exception when insufficient_privilege then
  raise notice 'event trigger not created (needs superuser); check:rls still guards new tables';
end $$;
