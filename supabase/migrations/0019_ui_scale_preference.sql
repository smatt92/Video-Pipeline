-- Migration 0019 — the UI scale is a setting, not a constant
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION.
--
-- `profiles` already holds the workspace settings whose own comment says it best: *"These
-- are settings, not constants: the FX rate in particular decides every rupee figure in the
-- product, and a constant in code cannot be corrected without a deploy."* Display scale is
-- the same argument applied to a different constant. Nothing in 0005 contradicts this; it
-- simply had no reason to consider a display that reports 3840 CSS pixels.
--
-- ─────────────────────────────────────────────────────────────
-- Why this has to be persisted server-side at all
--
-- The obvious cheap version is localStorage. It is wrong here for one specific reason: the
-- value has to be on the *first* paint. Read it on the client and every page load renders
-- once at 100% and then jumps — on a 4K display, where the whole complaint is that the UI
-- is too small, the jump is from unreadable to readable and it happens on every navigation.
--
-- Persisted on the profile, the server can put it on the document element before anything
-- renders. localStorage stays as the fallback for the pre-auth splash, where there is no
-- profile to read.
-- ─────────────────────────────────────────────────────────────

alter table profiles
  add column ui_scale numeric not null default 1.0
    check (ui_scale in (0.9, 1.0, 1.1, 1.25, 1.5));

comment on column profiles.ui_scale is
  'Multiplier applied to every size and space token. A closed set rather than a free '
  'numeric: the steps are the product decision, and an arbitrary 1.37 produces fractional '
  'pixel values that make hairlines and 1px borders render inconsistently across the app. '
  'The same reason VS Code, Figma and Zed all ship a stepper rather than a slider.';

-- ─────────────────────────────────────────────────────────────
-- The floor is a constraint, not a preference
--
-- WCAG 2.5.8 requires a 24px minimum target. At 0.9 a control laid out to exactly 24px
-- would land at 21.6px, so `--hit-min` is deliberately NOT multiplied by --ui-scale in
-- tokens.css. This CHECK is the other half of that: it stops the set of steps growing
-- downward later without someone re-reading why the floor is unscaled.
-- ─────────────────────────────────────────────────────────────

comment on constraint profiles_ui_scale_check on profiles is
  'The smallest step is 0.9. Anything smaller would need --hit-min re-checked against WCAG '
  '2.5.8, which is a 24px floor that must not shrink with a display preference.';

notify pgrst, 'reload schema';
