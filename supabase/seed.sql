-- Local development seed. Applied by `supabase db reset`; never runs against production.
--
-- Two things Phase 1 cannot start without:
--   1. a channel row, because concepts.channel_id is NOT NULL and Phase 1 enters
--      concepts by hand;
--   2. rate_card rows, because a submit refuses to proceed when it cannot price the
--      call (CLAUDE.md rule 5 — the cost row is written before the result comes back).

insert into channels (id, name, platform, niche, handle, is_active)
values (
  '00000000-0000-4000-8000-000000000001',
  'Kiln — dev channel',
  'youtube',
  'unset',
  null,
  true
)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- Rate card
--
-- ⚠️  THE NUMBERS BELOW ARE PLACEHOLDERS AND ARE ALMOST CERTAINLY WRONG. ⚠️
--
-- Higgsfield prices in credits and does not publish a public rate table; the real
-- per-endpoint credit cost has to be read off your own account after a real run. Until
-- these are replaced with observed values, every rupee figure the dashboard shows is
-- fiction — it will be internally consistent and externally meaningless.
--
-- Replace by inserting a new row with a later effective_from. Do not UPDATE these:
-- the ledger snapshots unit cost per generation, and rewriting history breaks the
-- audit trail that makes cost-per-video defensible.
-- ─────────────────────────────────────────────────────────────

-- ON CONFLICT targets the expression index from migration 0003, not a plain column list:
-- `endpoint` is nullable, and NULLs never compare equal, so the index keys on
-- coalesce(endpoint, '') to keep "one rate per endpoint per date" actually unique.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('higgsfield', 'dop-lite',     '/v1/image2video/dop', 'credit', 0.0, 'USD', false, 'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-turbo',    '/v1/image2video/dop', 'credit', 0.0, 'USD', false, 'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-standard', '/v1/image2video/dop', 'credit', 0.0, 'USD', false, 'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'soul',         '/v1/text2image/soul', 'credit', 0.0, 'USD', false, 'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('fal',        'placeholder',  null,                  'second', 0.0, 'USD', false, 'placeholder — the fal driver exists to prove the interface', '1970-01-01T00:00:00Z')
on conflict (driver, model, coalesce(endpoint, ''), effective_from) do nothing;

-- Integrations the settings page expects to find. Disabled and unverified: a row here is
-- a slot to fill in, not a working credential. A pipeline task must refuse to select an
-- integration that has never verified.
insert into integrations (slug, kind, is_enabled) values
  ('anthropic',  'llm',     false),
  ('higgsfield', 'video',   false),
  ('fal',        'video',   false),
  ('supabase-storage', 'storage', false)
on conflict (slug) do nothing;

insert into driver_health (driver) values ('higgsfield'), ('fal')
on conflict (driver) do nothing;
