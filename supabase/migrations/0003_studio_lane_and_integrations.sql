-- Migration 0003 — Studio lane, integrations, rough cuts, cost view correction
--
-- Source: docs/addenda/01-studio-lane-and-integrations.md §5.
--
-- Applied as specified except for six corrections, each marked [FIX] below and listed
-- in docs/decisions/0006-addendum-01-sql-corrections.md. None of them change intent;
-- they close holes that would have shipped silently.

-- ─────────────────────────────────────────────────────────────
-- 1. Studio lane
--
-- The Studio lane gets exactly one table, and it is a session log — not a parallel
-- content model. Everything downstream (shots, generations, assets, renders, reviews)
-- is shared with the pipeline lane, so review, stitch, cost and the originality trail
-- work on Studio output with no special-casing.
--
-- The transcript is the point. §0.2 of ARCHITECTURE.md makes human editorial judgment a
-- compliance control; a conversational lane produces literal turn-by-turn evidence of
-- it. This column is the appeal evidence.
-- ─────────────────────────────────────────────────────────────

create table studio_sessions (
  id            uuid primary key default gen_random_uuid(),
  channel_id    uuid references channels(id),
  script_id     uuid references scripts(id),      -- materialised on first generation
  title         text,
  model         text not null,
  transcript    jsonb not null default '[]',      -- full turn history = editorial evidence
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_inr      numeric not null default 0,
  spend_cap_inr numeric,
  status        text not null default 'active'
                check (status in ('active','archived','capped')),
  created_at    timestamptz not null default now()
);

create index on studio_sessions (status, created_at desc);
create index on studio_sessions (script_id);

comment on column studio_sessions.transcript is
  'Full turn history. This is originality evidence under the inauthentic-content policy, '
  'not a debug log — do not truncate it, and do not drop turns on archive.';
comment on column studio_sessions.spend_cap_inr is
  'Hard ceiling for the session. An agent loop with tool access can burn a lot of tokens '
  'on one bad turn; status flips to ''capped'' rather than continuing.';

alter table generations
  add column origin text not null default 'pipeline'
      check (origin in ('pipeline','studio','studio_unmanaged')),
  add column studio_session_id uuid references studio_sessions(id),
  -- soul(text→image) → dop(image→video) is a chain, not one call
  add column parent_generation_id uuid references generations(id);

comment on column generations.origin is
  'studio_unmanaged means the row records a generation made through a vendor MCP server '
  'we do not control: no idempotency key we issued, no cost we can attribute. Such rows '
  'must carry cost_inr = null rather than zero — zero is a claim, null is the truth.';
comment on column generations.parent_generation_id is
  'Keyframe→video chaining. A shot generated as text→image→video is two rows, two cost '
  'entries, one shot. Cost per shot is the sum of the chain, not the last link.';

create index on generations (studio_session_id) where studio_session_id is not null;
create index on generations (parent_generation_id) where parent_generation_id is not null;

alter table renders
  add column kind text not null default 'final'
      check (kind in ('rough_cut','final')),
  -- [FIX 1] The addendum adds renders.origin with no CHECK, while generations.origin has
  -- one. Same column, same meaning, same closed set — an unconstrained twin would drift.
  add column origin text not null default 'pipeline'
      check (origin in ('pipeline','studio','studio_unmanaged'));

comment on column renders.kind is
  'rough_cut = ffmpeg concat for review ("does this hang together?"). '
  'final = Remotion composition with captions, hook text, safe areas. '
  'Only final renders carry cost in v_render_cost.';

-- ─────────────────────────────────────────────────────────────
-- 2. Integrations
--
-- Credentials move from environment variables to the database, which changes the driver
-- constructor: a driver is built per-call from an integration record, never from
-- module-level process.env. Environment keeps two jobs only — bootstrap and CI.
--
-- The secret value is never a column here. `vault_secret_id` points into Supabase Vault;
-- `last_4` exists so the UI can show which key is configured without being able to read
-- it back.
-- ─────────────────────────────────────────────────────────────

create table integrations (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique,
  kind             text not null check (kind in ('llm','video','audio','storage','mcp','channel')),
  config           jsonb not null default '{}',   -- non-secret only
  vault_secret_id  uuid,
  last_4           text,
  is_enabled       boolean not null default false,
  last_verified_at timestamptz,
  last_error       text,
  created_at       timestamptz not null default now()
);

comment on column integrations.config is
  'Non-secret configuration only. If a value would be damaging in a screenshot, it '
  'belongs in Vault behind vault_secret_id, not here.';
comment on column integrations.last_verified_at is
  'Set by the Test-connection action, which makes the cheapest real call the vendor '
  'offers. A pipeline task must refuse to select an integration that has never verified.';

create table mcp_servers (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  url              text not null,
  auth_mode        text not null check (auth_mode in ('none','bearer','oauth')),
  vault_secret_id  uuid,
  allowed_tools    text[] default '{}',
  is_enabled       boolean not null default false,
  last_verified_at timestamptz,
  created_at       timestamptz not null default now()
);

comment on column mcp_servers.allowed_tools is
  'Allowlist. Empty array means no tools are exposed, not all of them — an agent with '
  'unbounded tool access to a spending API is not a default worth having.';

create table integration_events (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid references integrations(id) on delete cascade,
  -- [FIX 2] The addendum documents the value set in a comment but does not constrain it.
  -- An audit trail with free-text event names stops being groupable within a month.
  event          text not null
                 check (event in ('created','rotated','verified','failed','disabled','enabled')),
  detail         text,
  occurred_at    timestamptz not null default now()
);

create index on integration_events (integration_id, occurred_at desc);

comment on table integration_events is
  'Cheap now, essential the day a key leaks and the question is "when did this change, '
  'and what used it since?"';

-- ─────────────────────────────────────────────────────────────
-- 3. Rate card gains endpoint granularity and an honesty flag
-- ─────────────────────────────────────────────────────────────

alter table rate_card
  add column endpoint    text,
  add column is_verified boolean not null default false,
  add column source_note text;

comment on column rate_card.is_verified is
  'False means the number is a guess. Nothing may display a rupee figure derived from an '
  'unverified rate — show "unpriced" instead. A wrong cost is worse than a missing one '
  'because it gets believed.';
comment on column rate_card.source_note is
  'Where the number came from: an invoice, an observed credit delta, a docs page. '
  'Without this, is_verified is just a boolean someone flipped.';

-- [FIX 3] 0002 keyed rate_card on (driver, model, effective_from). With per-endpoint
-- pricing, two endpoints on the same model are now distinct rates and that key rejects
-- the second one. Rekey to include endpoint.
--
-- endpoint is nullable and NULLs do not compare equal in a UNIQUE constraint, so a
-- plain constraint would silently permit unlimited duplicate NULL-endpoint rows — the
-- exact ambiguity 0002 existed to remove. A unique index over coalesce() restores it.
alter table rate_card
  drop constraint rate_card_driver_model_effective_key;

create unique index rate_card_driver_model_endpoint_effective_key
  on rate_card (driver, model, coalesce(endpoint, ''), effective_from);

create index on rate_card (driver, model, endpoint, effective_from desc);

-- ─────────────────────────────────────────────────────────────
-- 4. Cost views — correcting the double-count
--
-- The original v_render_cost joined renders→shots→generations on script_id, so every
-- variant render of one script reported the *full* script cost and summing across
-- renders multiplied it by the number of variants.
--
-- Shot spend is genuinely shared across variants of the same script: five hook variants
-- over one body did not generate the body five times. So shot cost is divided across the
-- final renders that share it, and render-specific spend (encode, per-variant VO)
-- attaches directly.
--
-- That division is a modelling choice, not a fact. If you would rather see full shot cost
-- against every variant, drop the divisor — but then never SUM this column.
-- ─────────────────────────────────────────────────────────────

drop view if exists v_cost_per_1k_views;
drop view if exists v_render_cost;

create view v_script_cost as
select
  s.script_id,
  sum(cl.cost_inr)                                        as cost_inr,
  count(distinct g.id)                                    as generations_used,
  count(distinct g.id) filter (where g.status = 'failed') as generations_wasted
from shots s
left join generations g  on g.shot_id = s.id
left join cost_ledger cl on cl.generation_id = g.id
group by s.script_id;

comment on view v_script_cost is
  'Total generation spend for a script, counted once. Includes wasted generations — a '
  'reshoot that cost money and produced nothing is part of what the script cost.';

create view v_render_cost as
select
  r.id        as render_id,
  r.script_id,
  -- [FIX 4] coalesce the shared term. The addendum wraps only the render-specific
  -- subquery, so a script with no generations yet yields NULL / n + 0 = NULL, and the
  -- render's own encode cost disappears rather than standing alone.
  coalesce(vsc.cost_inr, 0) / nullif(count(*) over (partition by r.script_id), 0)
    + coalesce((select sum(cl.cost_inr) from cost_ledger cl where cl.render_id = r.id), 0)
    as cost_inr,
  coalesce(vsc.generations_used, 0)   as generations_used,
  coalesce(vsc.generations_wasted, 0) as generations_wasted
-- [FIX 5] LEFT JOIN, not JOIN. An inner join drops any render whose script has no shots
-- rows yet, which is precisely the state a render is in while its first shots are still
-- generating — the window in which you most want to watch the cost climb.
from renders r
left join v_script_cost vsc on vsc.script_id = r.script_id
where r.kind = 'final';

comment on view v_render_cost is
  'Cost attributable to one final render. Shot spend is divided across the final renders '
  'of the same script because variants share it; SUM over this column is meaningful, '
  'SUM over an undivided one would not be. Rough cuts are excluded — they are a review '
  'artifact, not an output.';

create view v_cost_per_1k_views as
select
  p.id as publication_id,
  vrc.cost_inr,
  ms.views,
  case when ms.views > 0 then vrc.cost_inr / (ms.views / 1000.0) end as cost_per_1k_views
from publications p
join v_render_cost vrc     on vrc.render_id = p.render_id
join metrics_snapshots ms  on ms.publication_id = p.id and ms.age_bucket = '7d';

comment on view v_cost_per_1k_views is
  'The only number that touches the business question.';

-- ─────────────────────────────────────────────────────────────
-- 5. Existing seed rates are guesses; say so
--
-- [FIX 6] is_verified defaults to false, which is correct for new rows, but the rate_card
-- rows already seeded carry placeholder zeros. Marking them explicitly makes the
-- "unpriced" path exercisable from the first run rather than looking like real zero-cost
-- generation.
-- ─────────────────────────────────────────────────────────────

update rate_card
set is_verified = false,
    source_note = 'placeholder seeded during scaffold — replace with an observed credit delta'
where unit_cost = 0;
