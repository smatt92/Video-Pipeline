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
