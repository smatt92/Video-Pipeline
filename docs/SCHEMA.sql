-- Kiln — Postgres schema v1 (Supabase)
-- Design notes:
--   * Vendor-neutral: `driver` + `model` are strings, never enums tied to one vendor.
--   * Every external call that costs money writes a cost row at call time, not at completion.
--   * Human editorial work is recorded as evidence, not just as state. See `reviews`.
--   * Publishing is gated by DB constraint, not by application politeness. See `publications`.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- Channels & identity
-- ─────────────────────────────────────────────────────────────

create table channels (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  platform      text not null check (platform in ('youtube','instagram')),
  niche         text not null,                       -- 'gta6', 'ai-tech', 'evergreen-doc'
  handle        text,
  external_id   text,                                -- YT channel id / IG user id
  -- tokens live in Supabase Vault, not here; this is the pointer
  vault_secret_id uuid,
  token_expires_at timestamptz,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Reusable Soul/character references so identity holds across shots
create table characters (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  driver          text not null,                     -- 'higgsfield'
  external_ref_id text not null,                     -- Higgsfield character id
  reference_urls  text[] not null default '{}',
  notes           text,
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Stage 1–2: trends → concepts
-- ─────────────────────────────────────────────────────────────

create table trend_signals (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,                        -- 'youtube','reddit','google_trends','x'
  term         text not null,
  region       text default 'IN',
  raw          jsonb not null default '{}',
  velocity     numeric,                              -- rate of change, source-normalised
  volume       numeric,
  captured_at  timestamptz not null default now()
);
create index on trend_signals (term, captured_at desc);
create index on trend_signals (source, captured_at desc);

create table concepts (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references channels(id),
  title          text not null,
  angle          text not null,                      -- the editorial POV; the anti-template field
  source_signals uuid[] not null default '{}',
  -- scoring rubric is stored, not hardcoded, so you can tune it and re-score history
  rubric_version text not null,
  scores         jsonb not null default '{}',        -- {velocity, saturation, ip_risk, evergreen_tail}
  score_total    numeric,
  ip_risk        text not null default 'unknown'
                 check (ip_risk in ('unknown','low','medium','high')),
  status         text not null default 'draft'
                 check (status in ('draft','approved','killed','in_production','published')),
  killed_reason  text,
  created_at     timestamptz not null default now(),
  approved_at    timestamptz,
  approved_by    uuid
);
create index on concepts (channel_id, status, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Stage 3: scripts & shots — originality evidence lives here
-- ─────────────────────────────────────────────────────────────

create table scripts (
  id              uuid primary key default gen_random_uuid(),
  concept_id      uuid not null references concepts(id) on delete cascade,
  version         int not null default 1,
  hook            text not null,                     -- 0–2s. The number that decides the business.
  beats           jsonb not null,                    -- [{t, text, intent}]
  cta             text,
  vo_text         text not null,
  -- provenance: what drafted it, what the human changed
  drafted_by      text not null,                     -- 'claude-opus-5' | 'human'
  draft_raw       text,                              -- the model's untouched output
  human_edit_count int not null default 0,
  human_edit_diff  text,
  -- anti-template guard: hash of the beat *structure*, not the words
  structure_hash  text not null,
  created_at      timestamptz not null default now(),
  unique (concept_id, version)
);
create index on scripts (structure_hash);

create table shots (
  id              uuid primary key default gen_random_uuid(),
  script_id       uuid not null references scripts(id) on delete cascade,
  idx             int not null,
  duration_s      numeric not null,
  description     text not null,                     -- human-readable intent
  prompt_id       uuid,                              -- references prompts(id), nullable until compiled
  compiled_params jsonb,                             -- exact driver payload
  character_id    uuid references characters(id),
  status          text not null default 'pending'
                  check (status in ('pending','generating','ready','failed','reshoot')),
  created_at      timestamptz not null default now(),
  unique (script_id, idx)
);

-- ─────────────────────────────────────────────────────────────
-- Stage 4: prompt library — the MCP→production handoff lands here
-- ─────────────────────────────────────────────────────────────

create table prompts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  driver        text not null,
  model         text not null,                       -- 'sora-2','veo-3.1','kling-3.0','soul','dop-turbo'
  template      text not null,                       -- with {{placeholders}}
  params        jsonb not null default '{}',         -- motion, aspect, quality, seed policy
  tags          text[] default '{}',
  -- provenance from the exploratory MCP session
  discovered_in text,                                -- 'claude-code-mcp' | 'manual'
  sample_output_url text,
  win_rate      numeric,                             -- backfilled from generation success + QA pass
  version       int not null default 1,
  created_at    timestamptz not null default now()
);
alter table shots add constraint shots_prompt_fk
  foreign key (prompt_id) references prompts(id);

-- ─────────────────────────────────────────────────────────────
-- Stage 5–6: generations & assets
-- ─────────────────────────────────────────────────────────────

create table generations (
  id               uuid primary key default gen_random_uuid(),
  shot_id          uuid references shots(id) on delete cascade,
  kind             text not null check (kind in ('video','image','audio','lipsync','upscale')),
  driver           text not null,
  model            text not null,
  request_payload  jsonb not null,
  idempotency_key  text unique,                      -- survives retries; do not skip this
  external_job_id  text,
  status           text not null default 'queued'
                   check (status in ('queued','running','succeeded','failed','cancelled','timeout')),
  attempt          int not null default 1,
  error_code       text,
  error_detail     text,
  -- cost is written at submit time from the rate table, reconciled on completion
  credits_spent    numeric,
  unit_cost_snapshot numeric,
  cost_inr         numeric,
  submitted_at     timestamptz not null default now(),
  completed_at     timestamptz
);
create index on generations (status, submitted_at desc);
create index on generations (external_job_id);

create table assets (
  id            uuid primary key default gen_random_uuid(),
  generation_id uuid references generations(id) on delete set null,
  kind          text not null check (kind in ('video','audio','image','caption','music')),
  r2_key        text not null,
  public_url    text,                                -- IG needs a publicly reachable URL
  duration_s    numeric,
  width         int,
  height        int,
  bytes         bigint,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Stage 7: renders — variants are first-class
-- ─────────────────────────────────────────────────────────────

create table renders (
  id               uuid primary key default gen_random_uuid(),
  script_id        uuid not null references scripts(id),
  variant_group_id uuid not null,                    -- same body, different hooks
  variant_label    text not null,                    -- 'hook-a', 'hook-b'
  format           text not null
                   check (format in ('shorts_9x16','reels_9x16','longform_16x9')),
  width            int not null,
  height           int not null,
  duration_s       numeric,
  asset_id         uuid references assets(id),
  status           text not null default 'queued'
                   check (status in ('queued','rendering','ready','failed')),
  render_ms        int,
  created_at       timestamptz not null default now()
);
create index on renders (variant_group_id);

-- ─────────────────────────────────────────────────────────────
-- Stage 8: the QA gate — a hard constraint, not a suggestion
-- ─────────────────────────────────────────────────────────────

create table reviews (
  id               uuid primary key default gen_random_uuid(),
  render_id        uuid not null references renders(id) on delete cascade,
  reviewer_id      uuid not null,
  decision         text not null check (decision in ('pass','reshoot','kill')),
  reshoot_shot_ids uuid[] default '{}',
  notes            text,
  -- originality evidence, surfaced at review time and frozen here
  human_edit_count int not null default 0,
  structure_novel  boolean not null,                 -- did the uniqueness check pass?
  created_at       timestamptz not null default now()
);
create index on reviews (render_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Stage 9–10: metadata & publishing
-- ─────────────────────────────────────────────────────────────

create table publications (
  id                        uuid primary key default gen_random_uuid(),
  render_id                 uuid not null references renders(id),
  channel_id                uuid not null references channels(id),
  review_id                 uuid not null references reviews(id),   -- ← cannot publish unreviewed
  title                     text not null,
  description               text,
  tags                      text[] default '{}',
  thumbnail_asset_id        uuid references assets(id),
  altered_content_disclosed boolean not null default true,
  scheduled_for             timestamptz,
  status                    text not null default 'draft'
                            check (status in ('draft','scheduled','uploading','live','failed')),
  external_post_id          text,
  external_url              text,
  error_detail              text,
  published_at              timestamptz,
  created_at                timestamptz not null default now()
);
create index on publications (channel_id, status, scheduled_for);

-- Enforce the editorial gate at the database, not in a route handler.
create or replace function enforce_review_pass() returns trigger as $$
declare d text;
begin
  if new.status in ('scheduled','uploading','live') then
    select decision into d from reviews where id = new.review_id;
    if d is distinct from 'pass' then
      raise exception 'publication % blocked: review % is %', new.id, new.review_id, coalesce(d,'missing');
    end if;
  end if;
  return new;
end $$ language plpgsql;

create trigger trg_enforce_review_pass
  before insert or update on publications
  for each row execute function enforce_review_pass();

-- ─────────────────────────────────────────────────────────────
-- Stage 11: measurement
-- ─────────────────────────────────────────────────────────────

create table metrics_snapshots (
  id                uuid primary key default gen_random_uuid(),
  publication_id    uuid not null references publications(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  age_bucket        text not null check (age_bucket in ('6h','24h','7d','30d')),
  views             bigint,
  likes             bigint,
  comments          bigint,
  shares            bigint,
  saves             bigint,
  avg_view_pct      numeric,
  retention_3s_pct  numeric,                         -- the hook metric
  raw               jsonb not null default '{}',
  unique (publication_id, age_bucket)
);

-- ─────────────────────────────────────────────────────────────
-- Cost ledger
-- ─────────────────────────────────────────────────────────────

create table rate_card (
  id          uuid primary key default gen_random_uuid(),
  driver      text not null,
  model       text not null,
  unit        text not null,                         -- 'credit','second','character'
  unit_cost   numeric not null,
  currency    text not null default 'USD',
  effective_from timestamptz not null default now()
);

create table cost_ledger (
  id            uuid primary key default gen_random_uuid(),
  generation_id uuid references generations(id) on delete cascade,
  render_id     uuid references renders(id) on delete cascade,
  driver        text not null,
  quantity      numeric not null,
  unit          text not null,
  cost_usd      numeric not null,
  cost_inr      numeric,
  occurred_at   timestamptz not null default now()
);
create index on cost_ledger (occurred_at desc);

-- Cost per finished render, including killed drafts on the same script.
create view v_render_cost as
select
  r.id                       as render_id,
  r.script_id,
  sum(cl.cost_inr)           as cost_inr,
  count(distinct g.id)       as generations_used,
  count(distinct g.id) filter (where g.status = 'failed') as generations_wasted
from renders r
join shots s        on s.script_id = r.script_id
left join generations g on g.shot_id = s.id
left join cost_ledger cl on cl.generation_id = g.id
group by r.id, r.script_id;

-- The only number that answers the business question.
create view v_cost_per_1k_views as
select
  p.id as publication_id,
  vrc.cost_inr,
  ms.views,
  case when ms.views > 0 then vrc.cost_inr / (ms.views / 1000.0) end as cost_per_1k_views
from publications p
join v_render_cost vrc on vrc.render_id = p.render_id
join metrics_snapshots ms on ms.publication_id = p.id and ms.age_bucket = '7d';
