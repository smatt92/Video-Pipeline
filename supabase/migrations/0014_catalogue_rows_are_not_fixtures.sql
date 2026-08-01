-- Migration 0014 — the rows the wizard cannot start without stop being local fixtures
--
-- ** THIS IS THE EVOLUTION KIND **, not the specification kind. Nothing in the addenda
-- specified these rows as seed data and then required them elsewhere on the same page.
-- They were fixture data for a settings screen that rendered fixtures, and they became a
-- precondition the day the onboarding Server Actions started reading them by slug. The
-- second case that tested the original design was a hosted deployment, which is exactly
-- where a decision that only ever ran under `supabase db reset` gets found out.
--
-- ─────────────────────────────────────────────────────────────
-- What went wrong, concretely
--
-- `supabase db push` applies migrations. It does not apply `supabase/seed.sql` — that file
-- runs on `db reset`, and its own first line says it "never runs against production".
--
-- Four of the five catalogue integrations lived only in that file. The app never creates
-- them: `configureAndVerify` (src/lib/onboarding/actions.ts) and `verifyIntegration`
-- (src/lib/integrations/verify.ts) both `select ... eq('slug', …)` and throw when the row
-- is absent. It is a lookup, not an upsert. So a freshly pushed production database
-- produced this, verified by applying 0001–0013 to an empty database with no seed:
--
--     integrations   → elevenlabs only          (from 0004, which used a migration)
--     driver_health  → empty
--     rate_card      → anthropic (0006) + elevenlabs (0004); no video placeholders
--
-- Wizard steps 2 (storage), 3 (LLM) and 4 (video) therefore threw "this database has not
-- been seeded" and could not be walked at all. Step 5 (audio) worked — by the accident of
-- 0004 having put its integration row in a migration while the others went to the seed.
-- That inconsistency is the tell: the right placement was already demonstrated in this
-- repo and not followed for the rest.
--
-- The rule this settles: a row the application requires in order to function belongs in a
-- migration in every environment. `seed.sql` is for data that makes local development
-- convenient — and nothing else. What stays there after this migration is one channel row,
-- and it stays because onboarding step 8 creates a real channel itself; the seeded one only
-- spares a local developer the wizard.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 1. One integrations row per catalogue entry
--
-- Disabled and unverified. A row here is a slot to fill in, not a working credential —
-- `isUsable()` requires is_enabled AND last_verified_at, so creating these grants nothing.
--
-- Kept in sync with INTEGRATION_CATALOG in src/lib/drivers/catalog.ts. That duplication is
-- real and it is what produced this migration, so `pnpm check:catalog` now applies the
-- migrations to a scratch database and fails if a catalogue slug has no row.
--
-- elevenlabs is listed even though 0004 already inserted it. Repeating it costs nothing
-- under ON CONFLICT and makes this file the complete answer to "which integrations must
-- exist", rather than one that is only correct if you also read 0004.
-- ─────────────────────────────────────────────────────────────

insert into integrations (slug, kind, is_enabled) values
  ('supabase-storage', 'storage', false),
  ('anthropic',        'llm',     false),
  ('higgsfield',       'video',   false),
  ('elevenlabs',       'audio',   false),
  ('fal',              'video',   false)
on conflict (slug) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 2. Circuit breaker state, one row per driver that can be broken
--
-- Nothing reads these today — the breaker described in 0002 is not written yet, and
-- `grep -rn driver_health src/` finds no read and no write. They are here anyway, and the
-- reason is this migration's own subject: the breaker will be written as an UPDATE against
-- a driver key (an in-process counter is what 0002 rejected), and leaving the rows in a
-- local-only file would reproduce exactly the failure above the first time it ran in
-- production. Cheaper to be consistent now than to find it twice.
--
-- Only the two video drivers. `driver_health` guards submits that cost credits against an
-- unreliable vendor; the LLM and storage paths fail loudly and immediately.
-- ─────────────────────────────────────────────────────────────

insert into driver_health (driver) values ('higgsfield'), ('fal')
on conflict (driver) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 3. Placeholder rates for the credit-priced drivers
--
-- ⚠️  THE NUMBERS BELOW ARE ZERO AND ARE MARKED UNVERIFIED. ⚠️
--
-- Not required for the wizard: onboarding step 6 already reports a missing row and an
-- unverified row identically, as "still unverified", and blocks either way. They are here
-- so that a pushed database and a locally reset one show the same thing — the divergence
-- between those two is the entire subject of this migration — and because
-- "placeholder — replace with an observed credit delta" tells you what to do next, while
-- "no rate card row" reads like a bug in the wizard.
--
-- Higgsfield prices in credits and publishes no rate table; the real per-endpoint cost has
-- to be read off your own account after a real run. Until then every rupee figure derived
-- from these would be internally consistent and externally meaningless, which is why
-- is_verified is false and the submit path refuses rather than rendering a confident zero.
--
-- Replace by inserting a row with a later effective_from. Do not UPDATE these: the ledger
-- snapshots unit cost per generation, and rewriting history breaks the audit trail that
-- makes cost-per-video defensible.
--
-- ON CONFLICT targets the expression index from 0006, which added `unit` to the key after
-- a call priced in two units collided with itself.
-- ─────────────────────────────────────────────────────────────

insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('higgsfield', 'dop-lite',     '/v1/image2video/dop', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-turbo',    '/v1/image2video/dop', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'dop-standard', '/v1/image2video/dop', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('higgsfield', 'soul',         '/v1/text2image/soul', 'credit', 0.0, 'USD', false,
   'placeholder — replace with an observed credit delta', '1970-01-01T00:00:00Z'),
  ('fal',        'placeholder',  null,                  'second', 0.0, 'USD', false,
   'placeholder — the fal driver exists to prove the interface', '1970-01-01T00:00:00Z')
on conflict (driver, model, coalesce(endpoint, ''), unit, effective_from) do nothing;
