# Addendum 03 — Supabase settings, onboarding, screen inventory

> Transcribed into the repo from the working session. Extends Addenda 01 and 02. Last
> architecture document before the full build.

---

## 1. The bootstrap paradox: Supabase settings can't work like the others

Every other integration follows the same pattern — credential in Vault, editable from the
settings page, driver constructed from the record. Supabase cannot, because **Vault lives
inside Supabase**. You can't read the database credentials out of the database you need
credentials to reach.

So Supabase is a different kind of settings section: **diagnostic, not editable.**

| Field | Source | Editable? |
|---|---|---|
| Project ref, region, URL | Bootstrap env | No — env only |
| Connection status + latency | Live probe | No |
| Schema migration version | `supabase_migrations.schema_migrations` | No |
| Vault health | Probe: write + read + delete a canary secret | No |
| Storage bucket usage | Storage API | No |
| Table row counts, DB size | `pg_stat_user_tables`, `pg_database_size` | No |
| RLS status per table | `pg_class.relrowsecurity` | No |
| Backup / PITR status | Management API (optional) | No |
| Connection pool mode | Config | No |

The value is that when something breaks at 1am, one screen tells you whether the problem
is Supabase, without SSHing anywhere. Show the four bootstrap env vars as present/absent
with `last_4`, never their values.

**Same reasoning applies to two other things** that must stay in env and out of Vault: the
Vault encryption key itself, and the webhook callback base URL (needed before any
integration record can be read). Everything else moves to Vault. Make this explicit in the
UI — the Supabase section should say, in plain words, that these are env-managed and why.
A settings page with a greyed field and no explanation reads as broken.

---

## 2. First-run onboarding

The app currently fails in the middle of a pipeline run when something isn't configured.
That's the wrong place to discover it. **The app should be unusable until it's usable** —
gate the whole thing behind a first-run wizard, with dependency order enforced.

### Gate

`profiles.onboarding_step` (int) and `profiles.onboarding_completed_at`. Middleware
redirects every route except `/onboarding/*` and `/settings/*` until required steps pass.
Not a dismissible banner — a redirect.

### Steps, in dependency order

| # | Step | Blocks on | Verification (a real call, not a format check) |
|---|---|---|---|
| 0 | Sign in | Allowlisted email | Supabase Auth |
| 1 | Profile | — | Name, timezone (IST), currency, USD→INR rate |
| 2 | **Storage** — R2 | — | Write a probe object, read it back, delete it. Nothing can be stored until this passes, so it goes first. |
| 3 | **Anthropic** | — | One cheap Messages call. Store the model list. |
| 4 | **Higgsfield** | R2 | Fetch credit balance. Display balance **and expiry date** — credits expire ~90 days and that clock starts now. |
| 5 | **ElevenLabs** | R2 | `listVoices()` + read subscription tier. **Store the tier's concurrency limit** — this is what the queue reads later. |
| 6 | **Rate card** | 4, 5 | Pre-seeded rows, every one `is_verified=false`. User pastes real per-endpoint costs from their own account dashboards. Cannot proceed while any rate used by an enabled driver is unverified. |
| 7 | **Host voice** | 5 | Pick a library voice to start, or begin a Professional Voice Clone. PVC is a multi-day external process — record it as `pending_external` and let the user proceed with a stock voice meanwhile. |
| 8 | **First channel** | 1 | Name, platform, niche. One channel minimum. |
| 9 | Optional | — | MCP servers, YouTube, Instagram — visibly deferred with "needed for Phase 3" not "coming soon". |
| 10 | **Guided first video** | all required | See below. |

Steps 2–5 can be presented on one screen with four cards, each independently testable, but
the *order of first success* should be enforced visually — R2 green before Higgsfield is
even offered.

### Step 10 — the guided first video

Don't end onboarding with a checklist and a "You're all set!" screen. End it by producing
something.

A scripted walkthrough that runs one real 15-second video end to end: a pre-written
concept → VO generated (real ElevenLabs call, real word timings) → two shots generated
(real Higgsfield calls) → rough cut stitched → review screen → download. Six or seven
guided steps with the actual UI, each annotated once and never again.

This costs maybe ₹40 of credits and it is the single highest-value screen in the product.
It proves every integration works together, teaches the review loop, and leaves the user
holding an artifact. Track `onboarding_first_video_render_id` so you can tell later
whether a user ever finished.

Make it skippable, with a persistent "Run the guided first video" entry in the sidebar
afterwards.

### Per-profile, not global

`profiles` gets `onboarding_step`, `onboarding_completed_at`,
`onboarding_first_video_render_id`. Integrations stay workspace-scoped for now (single
user), but the schema shouldn't forbid per-profile later — add a nullable `profile_id` to
`integrations` now and leave it null. Cheap insurance.

---

## 3. Screen inventory

| Route | Purpose | Phase |
|---|---|---|
| `/onboarding/[step]` | Wizard, steps 1–10 | 1a |
| `/` | Pipeline board — every video by state, one glyph each | 1c |
| `/studio` · `/studio/[sessionId]` | Opus 5 chat + artifact canvas | 1d |
| `/concepts` · `/concepts/[id]` | Concept queue, script editor, shotlist | 1c |
| `/review/[renderId]` | **The screen that matters** — player, shot strip, VO waveform, per-shot regenerate | 1.5 |
| `/library/prompts` | Prompt recipes, win rate, MCP-discovered provenance | 1b |
| `/library/voices` | Host voices, pronunciation dictionary, per-format model policy | 1b |
| `/library/music` | Music beds, SFX | 2 |
| `/costs` | Cost per video, per shot, credit burn vs expiry, yield | 1c |
| `/analytics` | Hook retention, cost per 1k views | 4 |
| `/publish` | Queue, schedule, rate-limit budget | 3 |
| `/settings/*` | Ten sections — the nine from Addendum 02 §4, plus Supabase | 1a |

`/costs` deserves a note: video cost dwarfs audio and token cost by ~100×. Do not stack
them in one bar chart where a segment is 1% tall. Video cost is the headline number; audio
and LLM are a secondary line beneath it.

---

## 4. On building this in one pass

An agent building forty files against unverified external APIs produces something that
compiles, demos, and fails on the first real call — and by then the wrong assumption is
load-bearing in ten places.

**Five hard stop-gates.** Each is a point where a wrong assumption gets cheap instead of
expensive. Don't remove them to go faster; they *are* the fast path.

1. **After the design system** — before any feature UI exists. Judge whether it reads as
   templated. Cheapest possible moment to change it.
2. **After the driver interfaces** — before implementations. `AudioDriver` and
   `VideoDriver` have genuinely different shapes and the interface has to survive both.
3. **After the first real ElevenLabs response** — the word-timing converter must be tested
   against a captured fixture, not a hand-written one. Everything downstream (captions,
   shot durations, the whole audio-first inversion) depends on this being right.
4. **After the first real Higgsfield generation** — including the actual credit cost, which
   reconciles the rate card against reality.
5. **After the guided first video runs end to end** — the integration proof.

Everything between gates can run unattended.
