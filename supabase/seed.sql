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

insert into rate_card (driver, model, unit, unit_cost, currency, effective_from)
values
  ('higgsfield', 'dop-lite',      'credit', 0.0, 'USD', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-turbo',     'credit', 0.0, 'USD', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-standard',  'credit', 0.0, 'USD', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'soul',          'credit', 0.0, 'USD', '1970-01-01T00:00:00Z'),
  ('fal',        'placeholder',   'second', 0.0, 'USD', '1970-01-01T00:00:00Z')
on conflict (driver, model, effective_from) do nothing;

insert into driver_health (driver) values ('higgsfield'), ('fal')
on conflict (driver) do nothing;
