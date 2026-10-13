-- 0054 — Rates for the router's new fast tier, for Studio's prompt cache, and for the
-- Message Batches endpoint.
--
-- Forward-only. Inserts only; no row is updated, so every historical rupee figure keeps the
-- unit cost it was written with (rate-card.ts: a rate is superseded by a later row, never
-- rewritten).
--
-- Every figure below was read on 2026-10-13 from the published price list,
-- platform.claude.com/docs/en/about-claude/pricing, and each one appears on that page as
-- written here. Verified in the sense 0040 uses: a published price, not a measured balance
-- move.
--
-- ── Units ───────────────────────────────────────────────────────────────────
--
-- cache_read_token       a prompt-cache hit ("Cache hits and refreshes")
-- cache_write_5m_token   a 5-minute prompt-cache write. Studio sets no TTL, so the default
--                        5-minute cache is the only one written. The 1-hour write is priced
--                        differently (2x base input, not 1.25x) and has no row here: a
--                        1-hour write would refuse as unpriced, which is the right failure.
--
-- ── Endpoints ───────────────────────────────────────────────────────────────
--
-- '/v1/messages/batches' is its own endpoint key because the same model costs half as much
-- there ("a 50% discount on both input and output tokens"). Pricing a batch row against
-- '/v1/messages' would overstate it by 2x, and the ledger snapshots whichever rate it read.
--
-- ── What is NOT modelled ────────────────────────────────────────────────────
--
-- Claude Haiku 5.5 has a second price tier for prompts over 100,000 tokens ($0.50 / $2.50
-- per MTok, batch $0.25 / $1.25). Every fast-tier task in this repo sends a few thousand
-- tokens at most, so only the up-to-100K tier is carried. A Haiku call over 100K input
-- tokens would be under-priced 5x by these rows; if one is ever added, it needs its own
-- rows and a branch in priceLlmCall, not a quiet reuse of these.

insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  -- The fast tier (router.ts MODELS.fast). Haiku 4.5's rows stay: they priced history.
  ('anthropic', 'claude-haiku-5-5', '/v1/messages', 'input_token', 0.0000001, 'USD', true,
   'Published list price: USD 0.10 per 1M input tokens, prompts up to 100,000 tokens (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z'),
  ('anthropic', 'claude-haiku-5-5', '/v1/messages', 'output_token', 0.0000005, 'USD', true,
   'Published list price: USD 0.50 per 1M output tokens, prompts up to 100,000 tokens (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z'),

  -- The Studio session (router.ts studio_session → writer tier), which now caches its
  -- system prompt, tools and transcript.
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages', 'cache_read_token', 0.0000001, 'USD', true,
   'Published list price: USD 0.10 per 1M cache-hit tokens, 0.05x base input (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z'),
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages', 'cache_write_5m_token', 0.0000025, 'USD', true,
   'Published list price: USD 2.50 per 1M 5-minute cache-write tokens, 1.25x base input (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z'),

  -- Message Batches, at the published 50%. Only the two models routedBatch() sends there:
  -- caption translation (fast tier) and the nightly brief draft (writer tier).
  ('anthropic', 'claude-haiku-5-5', '/v1/messages/batches', 'input_token', 0.00000005, 'USD', true,
   'Published batch price: USD 0.05 per 1M input tokens, prompts up to 100,000 tokens (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z'),
  ('anthropic', 'claude-haiku-5-5', '/v1/messages/batches', 'output_token', 0.00000025, 'USD', true,
   'Published batch price: USD 0.25 per 1M output tokens, prompts up to 100,000 tokens (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z'),
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages/batches', 'input_token', 0.000001, 'USD', true,
   'Published batch price: USD 1.00 per 1M input tokens (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z'),
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages/batches', 'output_token', 0.000005, 'USD', true,
   'Published batch price: USD 5.00 per 1M output tokens (pricing page, read 2026-10-13).', '2026-10-13T00:00:00Z')
on conflict do nothing;
