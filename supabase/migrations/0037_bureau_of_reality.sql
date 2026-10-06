-- 0037 — Bureau of Reality: the channel, its policy, the calendar, briefs, episodes, the
-- generation queue, the MCP control plane's tokens and its authorship log.
--
-- Reuses what exists (channels, characters, concepts, scripts, shots, generations, assets,
-- renders, reviews, publications, metrics_snapshots, cost_ledger, prompts) and adds only
-- what is missing. Decision 0012 records every deviation from the prompt that asked for it.
--
-- Forward-only. Contains ALTER … DROP CONSTRAINT/NOT NULL on constraints this migration
-- immediately re-adds in wider form, on tables that hold zero rows on the hosted project.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- ═════════════════════════════════════════════════════════════════════════════
-- The channel
-- ═════════════════════════════════════════════════════════════════════════════

alter table channels add column slug text unique;

insert into channels (id, name, platform, niche, handle, is_active, slug)
values (
  'b0000000-0000-4000-8000-000000000001',
  'Bureau of Reality',
  'youtube',
  'Original stickman workplace sitcom; each Short explains one real mechanism',
  null,
  true,
  'bureau-of-reality'
)
on conflict (id) do nothing;

comment on column channels.slug is
  'Stable handle for config that lives in the repo (channels/<slug>/). The UUID is the key; '
  'the slug is how a JSON file names the row it configures.';

-- FX: the operator chose ₹88/USD (operating plan v2.1). This is that choice, recorded, not a
-- default nobody set — fx.ts still refuses a null, and Settings → Workspace still changes it.
alter table profiles alter column usd_inr_rate set default 88;
update profiles set usd_inr_rate = 88 where usd_inr_rate is null;

-- ═════════════════════════════════════════════════════════════════════════════
-- Channel policy: caps, flags, variation thresholds, kill switch
-- ═════════════════════════════════════════════════════════════════════════════

create table channel_policy (
  channel_id                  uuid primary key references channels(id) on delete cascade,
  per_short_cap_inr           numeric not null default 150  check (per_short_cap_inr > 0),
  daily_cap_inr               numeric not null default 600  check (daily_cap_inr > 0),
  daily_longform_cap_inr      numeric not null default 1500 check (daily_longform_cap_inr > 0),
  monthly_cap_inr             numeric not null default 15000 check (monthly_cap_inr > 0),
  monthly_cap_after_gate2_inr numeric not null default 25000 check (monthly_cap_after_gate2_inr > 0),
  gate2_passed_at             timestamptz,
  daily_publish_cap           int     not null default 1 check (daily_publish_cap >= 0),
  default_slot_time           time    not null default '18:00',
  slot_timezone               text    not null default 'Asia/Kolkata',
  kill_switch                 boolean not null default false,
  kill_switch_reason          text,
  kill_switch_at              timestamptz,
  youtube_api_audited         boolean not null default false,
  instagram_publish_enabled   boolean not null default false,
  variation_window            int     not null default 14  check (variation_window between 1 and 200),
  variation_min_axes          int     not null default 4   check (variation_min_axes between 1 and 7),
  similarity_window           int     not null default 60  check (similarity_window between 1 and 500),
  similarity_max              numeric not null default 0.85 check (similarity_max > 0 and similarity_max <= 1),
  hook_archetype_weekly_max   int     not null default 2 check (hook_archetype_weekly_max >= 1),
  catchphrase_weekly_max      int     not null default 1 check (catchphrase_weekly_max >= 0),
  overlay_min_share           numeric not null default 0.5 check (overlay_min_share between 0 and 1),
  character_beat_max_s        numeric not null default 8 check (character_beat_max_s >= 0),
  money_shot_max              int     not null default 1 check (money_shot_max >= 0),
  rerolls_max                 int     not null default 2 check (rerolls_max between 0 and 5),
  updated_at                  timestamptz not null default now(),
  updated_by                  text,
  check (kill_switch = false or kill_switch_at is not null)
);

comment on table channel_policy is
  'Server-side caps and switches. Only the approver scope writes this table (caps_set, '
  'kill_switch); every write is mirrored into authorship_log by the caller.';
comment on column channel_policy.youtube_api_audited is
  'False → no upload; publish_bundles produces a bundle for manual Studio scheduling.';
comment on column channel_policy.instagram_publish_enabled is
  'False until Meta app review clears (CLAUDE.md current phase). The code path exists and refuses.';

insert into channel_policy (channel_id)
values ('b0000000-0000-4000-8000-000000000001')
on conflict (channel_id) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Characters: the cast is a row per character, keyed by the bible's slug
-- ═════════════════════════════════════════════════════════════════════════════

alter table characters
  add column channel_id        uuid references channels(id) on delete cascade,
  add column slug              text,
  add column role              text,
  add column accent_hex        text check (accent_hex is null or accent_hex ~ '^#[0-9A-Fa-f]{6}$'),
  add column voice_id          text,
  add column on_screen         boolean not null default true,
  add column season_introduced int not null default 1,
  add column bible             jsonb not null default '{}',
  add column synced_at         timestamptz;

-- A Bureau character exists before its vendor reference does (Prompt B mints those later),
-- so the reference is optional — but a reference without a driver is meaningless.
alter table characters alter column external_ref_id drop not null;
alter table characters alter column driver drop not null;
alter table characters add constraint characters_ref_has_driver
  check (external_ref_id is null or driver is not null);
-- A full constraint, not a partial index: ON CONFLICT (channel_id, slug) cannot target a
-- partial index without repeating its predicate, and NULL slugs are distinct anyway.
alter table characters add constraint characters_channel_slug_key unique (channel_id, slug);

comment on column characters.voice_id is
  'The designed voice for this character at the TTS vendor. Null = not designed yet; the '
  'voice stage refuses a line for a character without one rather than using a stand-in.';

-- ═════════════════════════════════════════════════════════════════════════════
-- MCP tokens: approver vs agent, hashed
-- ═════════════════════════════════════════════════════════════════════════════

create table mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  scope        text not null check (scope in ('approver', 'agent')),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null,
  profile_id   uuid references profiles(id) on delete set null,
  channel_id   uuid not null references channels(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  check (scope <> 'approver' or profile_id is not null)
);

comment on table mcp_tokens is
  'Bearer tokens for /api/mcp''s Bureau tools. Only the SHA-256 is stored. An approver token '
  'names the person whose decisions it records — reviews.reviewer_id needs a human.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Authorship log: append-only appeal evidence
-- ═════════════════════════════════════════════════════════════════════════════

create table authorship_log (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default clock_timestamp(),
  channel_id   uuid references channels(id) on delete cascade,
  actor_scope  text not null check (actor_scope in ('approver', 'agent', 'ui', 'system')),
  token_id     uuid references mcp_tokens(id) on delete set null,
  profile_id   uuid,
  action       text not null,
  subject_type text not null,
  subject_id   text not null,
  exact_text   text,
  payload      jsonb not null default '{}'
);
create index on authorship_log (subject_type, subject_id, occurred_at);
create index on authorship_log (occurred_at desc);

create function authorship_log_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'authorship_log is append-only: % refused', tg_op;
end $$;

create trigger authorship_log_append_only
  before update or delete on authorship_log
  for each row execute function authorship_log_is_append_only();

comment on table authorship_log is
  'Every approve/reject/caps/kill-switch decision with the exact text and a timestamp. The '
  'channel''s evidence of human authorship in an appeal, so it cannot be edited or deleted.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The calendar
-- ═════════════════════════════════════════════════════════════════════════════

create table slots (
  id           text primary key check (id ~ '^(S[0-9]{3}|L[0-9]{2}|B[0-9]{2})$'),
  channel_id   uuid not null references channels(id) on delete cascade,
  kind         text not null check (kind in ('short', 'long_form', 'bank')),
  slot_date    date,
  series       text not null check (series in
                 ('incident','desk_tour','pip','archive','myth','deep','complaint','long_form','sequel')),
  series_name  text not null,
  lead         text,
  episode      text check (episode is null or episode ~ '^S[0-9]+E[0-9]+$'),
  topic        text not null,
  hook         text,
  seasonal_tag text,
  topic_status text not null check (topic_status in ('approved', 'planned', 'bank')),
  notes        text,
  created_at   timestamptz not null default now(),
  check ((kind = 'bank') = (slot_date is null)),
  check ((kind = 'bank') = (id like 'B%')),
  check ((kind = 'long_form') = (id like 'L%'))
);
create index on slots (channel_id, slot_date);

comment on column slots.topic_status is
  'The calendar''s planning state for the TOPIC, from the CSV. Production state is derived '
  '(v_slot_status) from briefs and episodes, never stored here — two homes for one fact drift.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Comments (before briefs: a Complaint Box brief names the comment it came from)
-- ═════════════════════════════════════════════════════════════════════════════

create table comments (
  id                 uuid primary key default gen_random_uuid(),
  channel_id         uuid not null references channels(id) on delete cascade,
  publication_id     uuid references publications(id) on delete set null,
  platform           text not null check (platform in ('youtube', 'instagram')),
  external_id        text not null,
  parent_external_id text,
  author_handle      text,
  is_public          boolean not null default true,
  body               text not null,
  like_count         int check (like_count is null or like_count >= 0),
  reply_count        int check (reply_count is null or reply_count >= 0),
  published_at       timestamptz,
  fetched_at         timestamptz not null default now(),
  character_mentions text[] not null default '{}',
  is_question        boolean not null default false,
  complaint_score    numeric,
  used_in_brief_id   uuid,
  unique (platform, external_id)
);
create index on comments (channel_id, published_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- Briefs: Tap 1
-- ═════════════════════════════════════════════════════════════════════════════

create table briefs (
  id                    uuid primary key default gen_random_uuid(),
  channel_id            uuid not null references channels(id) on delete cascade,
  slot_id               text references slots(id),
  series                text not null check (series in
                          ('incident','desk_tour','pip','archive','myth','deep','complaint','long_form')),
  season                int check (season is null or season > 0),
  episode               int check (episode is null or episode > 0),
  lead_character        text not null,
  supporting_characters text[] not null default '{}',
  desk                  text not null,
  premise               text not null check (length(premise) between 10 and 300),
  premise_type          text not null,
  structure_variant     text not null,
  ending_type           text not null,
  music_bed             text not null,
  hook_archetype        text not null check (hook_archetype in
                          ('question','contradiction','number_claim','warning','story_open','direct_address','demonstration')),
  catchphrase_used      text,
  punchlines            jsonb not null check (jsonb_typeof(punchlines) = 'array' and jsonb_array_length(punchlines) = 3),
  beat_sheet            jsonb not null check (jsonb_typeof(beat_sheet) = 'array'),
  script_text           text not null,
  shot_list             jsonb not null default '[]' check (jsonb_typeof(shot_list) = 'array'),
  fact                  jsonb not null check (fact ? 'claim' and fact ? 'source_url'),
  titles                jsonb not null check (jsonb_typeof(titles) = 'array' and jsonb_array_length(titles) = 3),
  pinned_comment        text not null,
  estimate_inr          numeric check (estimate_inr is null or estimate_inr >= 0),
  estimate_basis        jsonb,
  tags                  text[] not null default '{}',
  flagged               boolean not null default false,
  flag_reasons          text[] not null default '{}',
  variation             jsonb,
  policy                jsonb,
  script_embedding      extensions.vector(768),
  title_embedding       extensions.vector(768),
  embedding_model       text,
  source_comment_id     uuid references comments(id) on delete set null,
  status                text not null default 'pending'
                          check (status in ('pending', 'approved', 'rejected', 'superseded')),
  chosen_punchline      text,
  approved_edits        jsonb,
  approved_at           timestamptz,
  approved_by_token     uuid references mcp_tokens(id) on delete set null,
  rejected_at           timestamptz,
  reject_reason         text,
  created_by            text not null check (created_by in ('agent', 'approver', 'ui', 'system')),
  created_by_token      uuid references mcp_tokens(id) on delete set null,
  created_at            timestamptz not null default now(),
  check (series <> 'pip' or (season is not null and episode is not null)),
  check (status <> 'approved' or (approved_at is not null and chosen_punchline is not null)),
  check (status <> 'rejected' or (rejected_at is not null and reject_reason is not null)),
  check (array_length(regexp_split_to_array(trim(script_text), '\s+'), 1) <= case when series = 'long_form' then 2000 else 150 end)
);
create unique index briefs_one_live_per_slot on briefs (slot_id)
  where slot_id is not null and status in ('pending', 'approved');
create index on briefs (channel_id, status, created_at desc);

alter table comments add constraint comments_used_in_brief_fkey
  foreign key (used_in_brief_id) references briefs(id) on delete set null;

comment on column briefs.estimate_inr is
  'Null = unpriced (an unverified rate somewhere in the shot list). Never zero for unknown.';
comment on column briefs.flagged is
  'Submitted despite failing variation or policy after two rewrites; flag_reasons names the '
  'axes. A flagged brief can still be approved — the approver sees why it was flagged.';

create table fact_sources (
  id           uuid primary key default gen_random_uuid(),
  brief_id     uuid not null references briefs(id) on delete cascade,
  claim        text not null,
  url          text not null check (url ~ '^https?://'),
  domain       text not null,
  source_class text not null check (source_class in
                 ('gov','edu','space_agency','met_ocean_agency','museum','peer_reviewed','standards_body','other')),
  title        text,
  checked_at   timestamptz,
  http_status  int,
  created_at   timestamptz not null default now()
);
create index on fact_sources (brief_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- Episodes: one per approved brief; the spine of the workflow
-- ═════════════════════════════════════════════════════════════════════════════

create table episodes (
  id               uuid primary key default gen_random_uuid(),
  brief_id         uuid not null unique references briefs(id) on delete cascade,
  channel_id       uuid not null references channels(id) on delete cascade,
  slot_id          text references slots(id),
  concept_id       uuid references concepts(id) on delete set null,
  script_id        uuid references scripts(id) on delete set null,
  status           text not null default 'queued' check (status in
                     ('queued','scripting','shotlisting','estimating','generating','qc','voicing',
                      'assembling','awaiting_cut','cut_approved','cut_rejected','bundled',
                      'scheduled','live','failed','halted')),
  status_detail    text,
  run_id           text,
  cut_wait_token   text,
  estimate_inr     numeric,
  final_render_id  uuid references renders(id) on delete set null,
  master_render_id uuid references renders(id) on delete set null,
  review_id        uuid references reviews(id) on delete set null,
  publication_id   uuid references publications(id) on delete set null,
  qc               jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on episodes (channel_id, status);

-- ═════════════════════════════════════════════════════════════════════════════
-- Shots and renders: the Bureau's routes and layers
-- ═════════════════════════════════════════════════════════════════════════════

alter table shots
  add column render_route    text check (render_route is null or render_route in
                               ('overlay','character_beat','acted_beat','money_shot')),
  add column character_slugs text[] not null default '{}',
  add column overlay_spec    jsonb,
  add column realistic       boolean not null default false,
  add column beat_id         text;

comment on column shots.render_route is
  'Which engine renders the shot. Distinct from shot_kind (framing vocabulary for recipes) '
  'on purpose: two adjacent concepts sharing a name is the collision CLAUDE.md warns about.';
comment on column shots.realistic is
  'True only for a photoreal money shot. Drives containsSyntheticMedia on the bundle.';

alter table renders
  add column layer    text not null default 'composite'
                      check (layer in ('composite','clean_master','caption_layer','longform')),
  add column language text not null default 'en';

comment on column renders.layer is
  'clean_master = no burned text (the localisation base). caption_layer = text only, '
  'transparent, one per language. composite = master + English captions, the cut Sahil approves.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The generation queue
-- ═════════════════════════════════════════════════════════════════════════════

create table provider_limits (
  provider        text primary key,
  max_concurrency int not null check (max_concurrency > 0),
  updated_at      timestamptz not null default now()
);
insert into provider_limits (provider, max_concurrency) values
  ('higgsfield', 10), ('gemini', 5), ('runway', 3), ('fal', 5)
on conflict (provider) do nothing;

create table gen_jobs (
  id              uuid primary key default gen_random_uuid(),
  episode_id      uuid references episodes(id) on delete cascade,
  shot_id         uuid references shots(id) on delete cascade,
  render_route    text not null check (render_route in ('character_beat','acted_beat','money_shot')),
  provider        text not null references provider_limits(provider),
  model           text not null,
  endpoint        text,
  params          jsonb not null,
  prompt_id       uuid references prompts(id),
  duration_s      numeric not null check (duration_s > 0),
  estimate_inr    numeric,
  status          text not null default 'queued' check (status in
                    ('queued','claimed','submitted','succeeded','failed','throttled','cancelled')),
  attempts        int not null default 0 check (attempts >= 0),
  max_attempts    int not null default 3 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  idempotency_key text not null unique,
  request_id      text,
  poll_ref        jsonb not null default '{}',
  generation_id   uuid references generations(id) on delete set null,
  failover_of     uuid references gen_jobs(id) on delete set null,
  reroll_of       uuid references gen_jobs(id) on delete set null,
  reroll_index    int not null default 0 check (reroll_index >= 0),
  note            text,
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  last_error_code text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on gen_jobs (provider, status, next_attempt_at);
create index on gen_jobs (episode_id);
create unique index gen_jobs_request_key on gen_jobs (provider, request_id) where request_id is not null;

comment on table gen_jobs is
  'The generation queue. claim_gen_jobs() hands out work with FOR UPDATE SKIP LOCKED inside '
  'a per-provider advisory lock, so concurrency is enforced by the database rather than by '
  'how many workers happen to be running.';

-- Is generation halted for the channel a job belongs to?
create function channel_killed(p_channel uuid) returns boolean language sql stable as $$
  select coalesce((select kill_switch from channel_policy where channel_id = p_channel), false)
$$;

create function claim_gen_jobs(p_provider text, p_worker text, p_max int)
returns setof gen_jobs
language plpgsql as $$
declare
  cap      int;
  inflight int;
  room     int;
begin
  -- Serialise the capacity arithmetic per provider. SKIP LOCKED alone stops two workers
  -- claiming the same row; it does not stop two workers each seeing 9 in flight and both
  -- claiming the tenth slot.
  perform pg_advisory_xact_lock(hashtext('gen_jobs:' || p_provider));

  select max_concurrency into cap from provider_limits where provider = p_provider;
  if cap is null then
    raise exception 'no provider_limits row for %', p_provider;
  end if;

  select count(*) into inflight from gen_jobs
   where provider = p_provider and status in ('claimed', 'submitted');

  room := least(greatest(cap - inflight, 0), greatest(p_max, 0));
  if room = 0 then
    return;
  end if;

  return query
  update gen_jobs j
     set status = 'claimed', locked_at = now(), locked_by = p_worker,
         attempts = j.attempts + 1, updated_at = now()
   where j.id in (
     select q.id
       from gen_jobs q
       left join episodes e on e.id = q.episode_id
      where q.provider = p_provider
        and q.status in ('queued', 'throttled')
        and q.next_attempt_at <= now()
        and q.attempts < q.max_attempts
        and (e.channel_id is null or not channel_killed(e.channel_id))
      order by q.created_at
      for update of q skip locked
      limit room)
  returning j.*;
end $$;

comment on function claim_gen_jobs is
  'Claim up to p_max jobs for one provider without exceeding provider_limits.max_concurrency, '
  'skipping rows another worker holds and any job on a killed channel.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Metrics: the gates the plan measures
-- ═════════════════════════════════════════════════════════════════════════════

alter table metrics_snapshots drop constraint metrics_snapshots_age_bucket_check;
alter table metrics_snapshots add constraint metrics_snapshots_age_bucket_check
  check (age_bucket in ('1h', '6h', '24h', '72h', '7d', '30d'));

alter table metrics_snapshots drop constraint metrics_snapshots_metric_source_check;
alter table metrics_snapshots add constraint metrics_snapshots_metric_source_check
  check (metric_source in ('manual_entry', 'vendor_api', 'studio_csv'));

alter table metrics_snapshots
  add column engaged_views        bigint check (engaged_views is null or engaged_views >= 0),
  add column viewed_vs_swiped_pct numeric check (viewed_vs_swiped_pct is null or viewed_vs_swiped_pct between 0 and 100),
  add column subs_gained          int;

comment on column metrics_snapshots.viewed_vs_swiped_pct is
  'Shorts "viewed vs swiped away", 0–100. Not exposed by the Analytics API as of writing, so '
  'it arrives by Studio CSV import (metric_source = studio_csv). Null = not imported, never 0.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Publications: bundle, kids flag, links to the episode and slot
-- ═════════════════════════════════════════════════════════════════════════════

alter table publications
  add column platform            text not null default 'youtube' check (platform in ('youtube', 'instagram')),
  add column made_for_kids       boolean not null default false,
  add column bundle              jsonb,
  add column episode_id          uuid references episodes(id) on delete set null,
  add column slot_id             text references slots(id),
  add column marked_scheduled_at timestamptz;

comment on column publications.made_for_kids is
  'Always false for this channel (adult office satire). Stored per row because the upload '
  'call needs it and a bundle copied into Studio must carry it.';

-- Kill switch and daily publish cap — enforced where enforce_review_pass is, in the
-- database. Separate trigger: that one is the compliance gate (rule 7) and stays untouched.
create function enforce_channel_policy() returns trigger language plpgsql as $$
declare
  pol channel_policy%rowtype;
  same_day int;
begin
  if new.status not in ('scheduled', 'uploading', 'live') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('scheduled', 'uploading', 'live') then
    return new;  -- already past the gate; status moving along the same lane
  end if;

  select * into pol from channel_policy where channel_id = new.channel_id;
  if not found then
    return new;
  end if;

  if pol.kill_switch then
    raise exception 'publication % blocked: kill switch is on for channel %', new.id, new.channel_id;
  end if;

  if new.scheduled_for is not null then
    select count(*) into same_day from publications p
     where p.channel_id = new.channel_id
       and p.platform = new.platform
       and p.id <> new.id
       and p.status in ('scheduled', 'uploading', 'live')
       and (p.scheduled_for at time zone pol.slot_timezone)::date
           = (new.scheduled_for at time zone pol.slot_timezone)::date;
    if same_day >= pol.daily_publish_cap then
      raise exception 'publication % blocked: daily publish cap % reached for %',
        new.id, pol.daily_publish_cap, (new.scheduled_for at time zone pol.slot_timezone)::date;
    end if;
  end if;
  return new;
end $$;

create trigger publications_channel_policy
  before insert or update of status on publications
  for each row execute function enforce_channel_policy();

-- ═════════════════════════════════════════════════════════════════════════════
-- Dubs, strategy memos, notifications
-- ═════════════════════════════════════════════════════════════════════════════

create table dub_jobs (
  id                uuid primary key default gen_random_uuid(),
  episode_id        uuid not null references episodes(id) on delete cascade,
  language          text not null check (language in ('hi', 'es', 'pt-BR')),
  status            text not null default 'queued' check (status in
                      ('queued','translating','voicing','rendering','ready','failed','cancelled')),
  requested_by      text not null check (requested_by in ('agent', 'approver', 'ui', 'system')),
  token_id          uuid references mcp_tokens(id) on delete set null,
  translated_lines  jsonb,
  audio_asset_id    uuid references assets(id) on delete set null,
  caption_render_id uuid references renders(id) on delete set null,
  estimate_inr      numeric,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (episode_id, language)
);

create table strategy_memos (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  week_of    date not null,
  body       text not null check (length(body) <= 4000),
  gates      jsonb not null default '{}',
  created_by text not null check (created_by in ('agent', 'approver', 'system')),
  token_id   uuid references mcp_tokens(id) on delete set null,
  created_at timestamptz not null default now()
);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid references channels(id) on delete cascade,
  kind       text not null check (kind in
               ('briefs_pending','cut_ready','cap_80','policy_flag','qc_failed','kill_switch','info')),
  dedupe_key text unique,
  text       text not null,
  delivered  boolean not null,
  detail     text,
  created_at timestamptz not null default now()
);

comment on table notifications is
  'Every attempted alert and whether it was delivered. A missed alert is a row you can '
  'select, not a log line nobody opens. dedupe_key stops a cap-at-80% alert firing hourly.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Views
-- ═════════════════════════════════════════════════════════════════════════════

-- The money that counts: a generation's reconcile replaces its estimate; refunds subtract.
create view v_ledger_effective as
select a.*,
       a.script_id as eff_script_id,
       coalesce(a.channel_id, c.channel_id) as eff_channel_id
  from v_cost_attributed a
  left join scripts s  on s.id = a.script_id
  left join concepts c on c.id = s.concept_id
 where a.entry_kind in ('reconcile', 'refund')
    or a.generation_id is null
    or not exists (
         select 1 from cost_ledger r
          where r.generation_id = a.generation_id and r.entry_kind = 'reconcile');

create view v_episode_spend as
select e.id as episode_id, e.channel_id, e.brief_id,
       coalesce(sum(l.cost_inr), 0) as spent_inr,
       count(l.id) filter (where l.cost_inr is null) as unpriced_rows
  from episodes e
  left join v_ledger_effective l on l.eff_script_id = e.script_id
 group by e.id;

create view v_channel_spend as
select p.channel_id,
       coalesce(sum(l.cost_inr) filter (
         where (l.occurred_at at time zone p.slot_timezone)::date
             = (now() at time zone p.slot_timezone)::date), 0) as today_inr,
       coalesce(sum(l.cost_inr) filter (
         where date_trunc('month', l.occurred_at at time zone p.slot_timezone)
             = date_trunc('month', now() at time zone p.slot_timezone)), 0) as month_inr,
       p.daily_cap_inr,
       p.daily_longform_cap_inr,
       case when p.gate2_passed_at is null then p.monthly_cap_inr else p.monthly_cap_after_gate2_inr end
         as monthly_cap_effective_inr,
       p.per_short_cap_inr,
       p.kill_switch
  from channel_policy p
  left join v_ledger_effective l on l.eff_channel_id = p.channel_id
 group by p.channel_id, p.slot_timezone, p.daily_cap_inr, p.daily_longform_cap_inr,
          p.gate2_passed_at, p.monthly_cap_inr, p.monthly_cap_after_gate2_inr,
          p.per_short_cap_inr, p.kill_switch;

-- Production state of a slot, derived. Null brief = nobody has drafted it yet.
create view v_slot_status as
select s.*,
       b.id as brief_id, b.status as brief_status, b.flagged,
       e.id as episode_id, e.status as episode_status,
       case
         when e.status is not null then e.status
         when b.status = 'pending' then 'needs_approval'
         when b.status = 'approved' then 'approved'
         else 'open'
       end as production_status,
       (s.slot_date + p.default_slot_time) at time zone p.slot_timezone as publish_at
  from slots s
  join channel_policy p on p.channel_id = s.channel_id
  left join lateral (
    select * from briefs b
     where b.slot_id = s.id and b.status in ('pending', 'approved')
     order by b.created_at desc limit 1) b on true
  left join episodes e on e.brief_id = b.id;

-- The variation ledger: one row per brief that counts as "an episode" for the 4-of-7 rule.
create view v_variation_ledger as
select b.id as brief_id, b.channel_id, b.series, b.lead_character as lead, b.desk,
       b.premise_type, b.structure_variant, b.ending_type, b.music_bed,
       b.hook_archetype, b.catchphrase_used,
       coalesce(s.slot_date, b.approved_at::date, b.created_at::date) as on_date,
       b.status, b.created_at
  from briefs b
  left join slots s on s.id = b.slot_id
 where b.status in ('approved', 'pending');

create view v_gen_queue as
select l.provider, l.max_concurrency,
       count(*) filter (where q.status = 'queued')    as queued,
       count(*) filter (where q.status = 'throttled') as throttled,
       count(*) filter (where q.status in ('claimed','submitted')) as in_flight,
       count(*) filter (where q.status = 'failed'
                          and q.updated_at > now() - interval '24 hours') as failed_24h,
       count(*) filter (where q.status = 'succeeded'
                          and q.updated_at > now() - interval '24 hours') as succeeded_24h
  from provider_limits l
  left join gen_jobs q on q.provider = l.provider
 group by l.provider, l.max_concurrency;

-- Similarity search over the last N briefs. search_path includes extensions so the vector
-- operator resolves on Supabase and on a plain Postgres with pgvector alike.
create function brief_similarity(p_channel uuid, p_embedding extensions.vector, p_window int, p_exclude uuid)
returns table (brief_id uuid, similarity double precision)
language sql stable
set search_path = public, extensions
as $$
  select b.id, 1 - (b.script_embedding <=> p_embedding)
    from (select id, script_embedding from briefs
           where channel_id = p_channel and script_embedding is not null
             and status in ('approved', 'pending')
             and (p_exclude is null or id <> p_exclude)
           order by created_at desc limit p_window) b
   order by 2 desc
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Integration rows for the catalogue's new entries (check:catalog requires them)
-- ═════════════════════════════════════════════════════════════════════════════

alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('llm', 'video', 'audio', 'storage', 'mcp', 'channel', 'notify'));

insert into integrations (slug, kind, is_enabled) values
  ('gemini',    'video',   false),
  ('runway',    'video',   false),
  ('instagram', 'channel', false),
  ('slack',     'notify',  false)
on conflict (slug) do nothing;
