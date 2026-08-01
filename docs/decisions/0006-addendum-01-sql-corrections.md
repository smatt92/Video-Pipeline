# 0006 — Corrections applied to the addenda SQL

**Date:** 2026-08-01
**Status:** accepted
**Applies to:** migrations 0003, 0004, 0005

The addenda supply SQL directly. It is applied as written except where running it revealed
a hole. Each correction is marked `[FIX n]` in the migration it appears in.

## Addendum 01 §5 → migration 0003

1. **`renders.origin` had no CHECK** while `generations.origin` did. Same column, same
   meaning, same closed set. An unconstrained twin drifts, and the enum drift-checker
   would have had nothing to compare against.
2. **`integration_events.event` had no CHECK** — the value set was documented in a trailing
   comment. An audit trail with free-text event names stops being groupable within a
   month.
3. **`rate_card` uniqueness broke under per-endpoint pricing.** 0002 keyed on
   `(driver, model, effective_from)`; adding `endpoint` makes two endpoints on one model
   distinct rates, which that key rejects. Rekeyed — but as a unique *index* over
   `coalesce(endpoint, '')`, because `endpoint` is nullable and NULLs never compare equal,
   so a plain constraint would have silently permitted unlimited duplicate NULL-endpoint
   rows. That is precisely the ambiguity 0002 existed to remove.
4. **`v_render_cost` coalesced only half its sum.** The addendum wraps the render-specific
   subquery but not the shared term, so a script with no generations yet yields
   `NULL / n + 0 = NULL` and the render's own encode cost vanishes rather than standing
   alone.
5. **`v_render_cost` used an inner join** to `v_script_cost`, dropping any render whose
   script has no `shots` rows yet — exactly the state a render is in while its first shots
   are generating, which is when you most want to watch cost climb. Changed to LEFT JOIN.
6. **Seeded rate rows needed `is_verified = false` explicitly.** The column defaults to
   false for new rows, but the placeholder zeros seeded during the scaffold predate it.
   Marking them makes the "unpriced" path exercisable from the first run instead of
   looking like real zero-cost generation.

A seventh issue was found by running it rather than reading it: `supabase/seed.sql` used
`ON CONFLICT (driver, model, effective_from)`, which stopped matching any constraint the
moment 0003 rekeyed `rate_card`. Fixed in the seed, not the migration.

## Addendum 02 §2 → migration 0004

- **`pronunciations` table added.** Not in the addendum's SQL, but §2 requires "an editable
  table, because you will add entries weekly" and the settings page needs somewhere to
  write. `kind` distinguishes alias substitution from phoneme rules because phoneme tags
  are honoured by only some models and *silently ignored* by the rest — a distinction that
  has to be represented or the feature fails invisibly on three of four models.

## Addendum 03 §2 → migration 0005

- **`profiles.id` carries no FK to `auth.users`.** The auth schema is Supabase-managed and
  does not exist on a plain Postgres, so a hard FK would make the migration sequence
  unrunnable in CI. This follows the convention 0001 already set with
  `concepts.approved_by` and `reviews.reviewer_id`.
- **`integration_checks` table added.** §2 requires "a real call, not a format check" at
  every onboarding step, and step 4 blocks on step 2 specifically.
  `integrations.last_verified_at` records only that *something* passed; "the key is valid"
  and "we can round-trip an object" are separate facts and only one is about the
  credential.
