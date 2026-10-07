-- Kiln — migrations 0050 to 0050, bundled for the Supabase SQL editor.
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
--   0050  redraw_holds_the_cut

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
  where version in ('0050');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0050_redraw_holds_the_cut.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0050 redraw_holds_the_cut'; end $kiln_progress$;

-- 0050 — A cut cannot be decided while one of its pictures is being redrawn.
--
-- "Redraw this picture" on Cuts (src/lib/bureau/redraw.ts) replaces one scene still of a cut
-- that is awaiting the approver's call, then re-renders the composite. Approving in between
-- would approve a composite nobody watched and master a picture nobody approved. decideCut
-- refuses in TypeScript; this is the same refusal for every caller, the Kiln MCP connector
-- included — the database decides, as for every other gate in 0040.
--
-- `create or replace` of bureau_cut_decide, identical to 0040 except the one refusal below.
-- The in-flight record is `episodes.qc.redraws` (jsonb, no new column), so the code works
-- before this is pasted — only the database-side half of the refusal waits on it.
--
-- And bureau_caps_set learns one key, `instagram_publish_enabled` (decision 0023): the switch
-- for posting Reels from Kiln to the channel's own account. 0020 said caps_set flips it; the
-- allowed list never had it, so no write path could turn it on. Approver only, logged, as
-- every other key. Identical to 0040 otherwise.
--
-- Forward-only; no row is rewritten.

create or replace function bureau_cut_decide(p_token uuid, p_episode uuid, p_approve boolean, p_note text)
returns jsonb
language plpgsql as $$
declare t mcp_tokens; e episodes; b briefs; rv uuid;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into e from episodes where id = p_episode for update;
  if not found or e.channel_id <> t.channel_id then
    raise exception 'not_found: episode % does not exist on this channel', p_episode;
  end if;
  if e.status <> 'awaiting_cut' then
    raise exception 'conflict: episode % is %, not awaiting_cut', p_episode, e.status;
  end if;
  if e.final_render_id is null then
    raise exception 'conflict: episode % has no final render to review', p_episode;
  end if;
  -- 0050: a picture of this cut is being redrawn (src/lib/bureau/redraw.ts). The cut is about
  -- to change; neither decision can be made on it. An entry older than two hours no longer
  -- counts (REDRAW_STALE_MS), so a redraw that died cannot hold the cut for ever.
  if exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(e.qc->'redraws') = 'array' then e.qc->'redraws' else '[]'::jsonb end) r
    where r->>'state' in ('queued','drawing','rendering')
      and (r->>'requested_at')::timestamptz > now() - interval '2 hours'
  ) then
    raise exception 'conflict: a picture in episode % is being redrawn; decide the cut once the new composite is in', p_episode;
  end if;
  if not p_approve and (p_note is null or length(trim(p_note)) = 0) then
    raise exception 'invalid: a rejection needs a note';
  end if;
  select * into b from briefs where id = e.brief_id;

  -- reviews.reviewer_id is a person; an approver token always names one (mcp_tokens check).
  insert into reviews (render_id, reviewer_id, decision, notes, structure_novel)
  values (e.final_render_id, t.profile_id, case when p_approve then 'pass' else 'reshoot' end,
          nullif(trim(coalesce(p_note, '')), ''),
          coalesce((b.variation->>'passed')::boolean, false))
  returning id into rv;

  update episodes set
    status     = case when p_approve then 'cut_approved' else 'cut_rejected' end,
    review_id  = rv,
    updated_at = now()
  where id = p_episode;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (e.channel_id, 'approver', t.id, t.profile_id,
          case when p_approve then 'cut_approve' else 'cut_reject' end,
          'episode', p_episode::text, coalesce(nullif(trim(coalesce(p_note, '')), ''), case when p_approve then 'approved' end),
          jsonb_build_object('render_id', e.final_render_id, 'review_id', rv));

  return jsonb_build_object('review_id', rv, 'cut_wait_token', e.cut_wait_token);
end $$;

-- ── caps_set: the Instagram publishing switch ───────────────────────────────

create or replace function bureau_caps_set(p_token uuid, p_changes jsonb) returns channel_policy
language plpgsql as $$
declare
  t mcp_tokens; p channel_policy; k text;
  allowed text[] := array['per_short_cap_inr','daily_cap_inr','daily_longform_cap_inr',
    'monthly_cap_inr','monthly_cap_after_gate2_inr','daily_publish_cap','gate2_passed',
    'variation_min_axes','similarity_max','hook_archetype_weekly_max','catchphrase_weekly_max',
    'overlay_min_share','character_beat_max_s','money_shot_max','rerolls_max',
    'instagram_publish_enabled'];
begin
  t := bureau_require_scope(p_token, 'approver');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'invalid: no changes given';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then
      raise exception 'invalid: "%" is not a cap this tool can set', k;
    end if;
  end loop;

  update channel_policy set
    per_short_cap_inr           = coalesce((p_changes->>'per_short_cap_inr')::numeric, per_short_cap_inr),
    daily_cap_inr               = coalesce((p_changes->>'daily_cap_inr')::numeric, daily_cap_inr),
    daily_longform_cap_inr      = coalesce((p_changes->>'daily_longform_cap_inr')::numeric, daily_longform_cap_inr),
    monthly_cap_inr             = coalesce((p_changes->>'monthly_cap_inr')::numeric, monthly_cap_inr),
    monthly_cap_after_gate2_inr = coalesce((p_changes->>'monthly_cap_after_gate2_inr')::numeric, monthly_cap_after_gate2_inr),
    daily_publish_cap           = coalesce((p_changes->>'daily_publish_cap')::int, daily_publish_cap),
    gate2_passed_at             = case
                                    when p_changes ? 'gate2_passed' and (p_changes->>'gate2_passed')::boolean
                                      then coalesce(gate2_passed_at, now())
                                    when p_changes ? 'gate2_passed' then null
                                    else gate2_passed_at end,
    variation_min_axes          = coalesce((p_changes->>'variation_min_axes')::int, variation_min_axes),
    similarity_max              = coalesce((p_changes->>'similarity_max')::numeric, similarity_max),
    hook_archetype_weekly_max   = coalesce((p_changes->>'hook_archetype_weekly_max')::int, hook_archetype_weekly_max),
    catchphrase_weekly_max      = coalesce((p_changes->>'catchphrase_weekly_max')::int, catchphrase_weekly_max),
    overlay_min_share           = coalesce((p_changes->>'overlay_min_share')::numeric, overlay_min_share),
    character_beat_max_s        = coalesce((p_changes->>'character_beat_max_s')::numeric, character_beat_max_s),
    money_shot_max              = coalesce((p_changes->>'money_shot_max')::int, money_shot_max),
    rerolls_max                 = coalesce((p_changes->>'rerolls_max')::int, rerolls_max),
    instagram_publish_enabled   = coalesce((p_changes->>'instagram_publish_enabled')::boolean, instagram_publish_enabled),
    updated_at = now(),
    updated_by = 'approver:' || t.id
  where channel_id = t.channel_id
  returning * into p;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id, 'caps_set', 'channel_policy',
          t.channel_id::text, p_changes::text, p_changes);
  return p;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0050', 'redraw_holds_the_cut', array[$kiln_0050$-- 0050 — A cut cannot be decided while one of its pictures is being redrawn.
--
-- "Redraw this picture" on Cuts (src/lib/bureau/redraw.ts) replaces one scene still of a cut
-- that is awaiting the approver's call, then re-renders the composite. Approving in between
-- would approve a composite nobody watched and master a picture nobody approved. decideCut
-- refuses in TypeScript; this is the same refusal for every caller, the Kiln MCP connector
-- included — the database decides, as for every other gate in 0040.
--
-- `create or replace` of bureau_cut_decide, identical to 0040 except the one refusal below.
-- The in-flight record is `episodes.qc.redraws` (jsonb, no new column), so the code works
-- before this is pasted — only the database-side half of the refusal waits on it.
--
-- And bureau_caps_set learns one key, `instagram_publish_enabled` (decision 0023): the switch
-- for posting Reels from Kiln to the channel's own account. 0020 said caps_set flips it; the
-- allowed list never had it, so no write path could turn it on. Approver only, logged, as
-- every other key. Identical to 0040 otherwise.
--
-- Forward-only; no row is rewritten.

create or replace function bureau_cut_decide(p_token uuid, p_episode uuid, p_approve boolean, p_note text)
returns jsonb
language plpgsql as $$
declare t mcp_tokens; e episodes; b briefs; rv uuid;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into e from episodes where id = p_episode for update;
  if not found or e.channel_id <> t.channel_id then
    raise exception 'not_found: episode % does not exist on this channel', p_episode;
  end if;
  if e.status <> 'awaiting_cut' then
    raise exception 'conflict: episode % is %, not awaiting_cut', p_episode, e.status;
  end if;
  if e.final_render_id is null then
    raise exception 'conflict: episode % has no final render to review', p_episode;
  end if;
  -- 0050: a picture of this cut is being redrawn (src/lib/bureau/redraw.ts). The cut is about
  -- to change; neither decision can be made on it. An entry older than two hours no longer
  -- counts (REDRAW_STALE_MS), so a redraw that died cannot hold the cut for ever.
  if exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(e.qc->'redraws') = 'array' then e.qc->'redraws' else '[]'::jsonb end) r
    where r->>'state' in ('queued','drawing','rendering')
      and (r->>'requested_at')::timestamptz > now() - interval '2 hours'
  ) then
    raise exception 'conflict: a picture in episode % is being redrawn; decide the cut once the new composite is in', p_episode;
  end if;
  if not p_approve and (p_note is null or length(trim(p_note)) = 0) then
    raise exception 'invalid: a rejection needs a note';
  end if;
  select * into b from briefs where id = e.brief_id;

  -- reviews.reviewer_id is a person; an approver token always names one (mcp_tokens check).
  insert into reviews (render_id, reviewer_id, decision, notes, structure_novel)
  values (e.final_render_id, t.profile_id, case when p_approve then 'pass' else 'reshoot' end,
          nullif(trim(coalesce(p_note, '')), ''),
          coalesce((b.variation->>'passed')::boolean, false))
  returning id into rv;

  update episodes set
    status     = case when p_approve then 'cut_approved' else 'cut_rejected' end,
    review_id  = rv,
    updated_at = now()
  where id = p_episode;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (e.channel_id, 'approver', t.id, t.profile_id,
          case when p_approve then 'cut_approve' else 'cut_reject' end,
          'episode', p_episode::text, coalesce(nullif(trim(coalesce(p_note, '')), ''), case when p_approve then 'approved' end),
          jsonb_build_object('render_id', e.final_render_id, 'review_id', rv));

  return jsonb_build_object('review_id', rv, 'cut_wait_token', e.cut_wait_token);
end $$;

-- ── caps_set: the Instagram publishing switch ───────────────────────────────

create or replace function bureau_caps_set(p_token uuid, p_changes jsonb) returns channel_policy
language plpgsql as $$
declare
  t mcp_tokens; p channel_policy; k text;
  allowed text[] := array['per_short_cap_inr','daily_cap_inr','daily_longform_cap_inr',
    'monthly_cap_inr','monthly_cap_after_gate2_inr','daily_publish_cap','gate2_passed',
    'variation_min_axes','similarity_max','hook_archetype_weekly_max','catchphrase_weekly_max',
    'overlay_min_share','character_beat_max_s','money_shot_max','rerolls_max',
    'instagram_publish_enabled'];
begin
  t := bureau_require_scope(p_token, 'approver');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'invalid: no changes given';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then
      raise exception 'invalid: "%" is not a cap this tool can set', k;
    end if;
  end loop;

  update channel_policy set
    per_short_cap_inr           = coalesce((p_changes->>'per_short_cap_inr')::numeric, per_short_cap_inr),
    daily_cap_inr               = coalesce((p_changes->>'daily_cap_inr')::numeric, daily_cap_inr),
    daily_longform_cap_inr      = coalesce((p_changes->>'daily_longform_cap_inr')::numeric, daily_longform_cap_inr),
    monthly_cap_inr             = coalesce((p_changes->>'monthly_cap_inr')::numeric, monthly_cap_inr),
    monthly_cap_after_gate2_inr = coalesce((p_changes->>'monthly_cap_after_gate2_inr')::numeric, monthly_cap_after_gate2_inr),
    daily_publish_cap           = coalesce((p_changes->>'daily_publish_cap')::int, daily_publish_cap),
    gate2_passed_at             = case
                                    when p_changes ? 'gate2_passed' and (p_changes->>'gate2_passed')::boolean
                                      then coalesce(gate2_passed_at, now())
                                    when p_changes ? 'gate2_passed' then null
                                    else gate2_passed_at end,
    variation_min_axes          = coalesce((p_changes->>'variation_min_axes')::int, variation_min_axes),
    similarity_max              = coalesce((p_changes->>'similarity_max')::numeric, similarity_max),
    hook_archetype_weekly_max   = coalesce((p_changes->>'hook_archetype_weekly_max')::int, hook_archetype_weekly_max),
    catchphrase_weekly_max      = coalesce((p_changes->>'catchphrase_weekly_max')::int, catchphrase_weekly_max),
    overlay_min_share           = coalesce((p_changes->>'overlay_min_share')::numeric, overlay_min_share),
    character_beat_max_s        = coalesce((p_changes->>'character_beat_max_s')::numeric, character_beat_max_s),
    money_shot_max              = coalesce((p_changes->>'money_shot_max')::int, money_shot_max),
    rerolls_max                 = coalesce((p_changes->>'rerolls_max')::int, rerolls_max),
    instagram_publish_enabled   = coalesce((p_changes->>'instagram_publish_enabled')::boolean, instagram_publish_enabled),
    updated_at = now(),
    updated_by = 'approver:' || t.id
  where channel_id = t.channel_id
  returning * into p;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id, 'caps_set', 'channel_policy',
          t.channel_id::text, p_changes::text, p_changes);
  return p;
end $$;
$kiln_0050$])
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
