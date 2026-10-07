# Handover — Prompt L: several channels, Instagram Reels (manual), trends that run, every sidebar item real (07-Oct-2026)

Decisions: `docs/decisions/0019-multichannel.md`, `docs/decisions/0020-instagram-reels-manual.md`.
Register: `0008` §21–§24. **Migration 0046 — paste it** (below).

## What landed

| # | Item | Where |
|---|---|---|
| 1a | Active channel per browser (cookie `kiln_channel`), switcher at the top of the sidebar (name + handle, **Channels**, **+ Add channel**), defaulting to the oldest channel with a bible. Screens read the active channel; every decision reads the channel of the row it acts on and acts through a web token for *that* channel; MCP uses the token's channel; tasks 19/21/24 loop channels, 20 reads the episode's | `src/lib/channels/*`, `src/components/channels/*`, `ui-actions.ts`, `src/trigger/*` |
| 1b | Per-channel bible from `channels/<slug>/` (cast, voices, series, policy, **trends.json**, a new optional `publishing` block for hashtags/tags/category), through a generated static-import registry; `check:channels` in `pnpm check` and CI | `scripts/channels-registry.mjs`, `src/lib/bureau/bible.ts` |
| 1c | Add channel: `pnpm channel:new <slug>` copies `channels/_template/`; `/channels/new` creates row, policy, publish targets and cast, and refuses a slug without a folder by name (with the command). `/channels` edits each channel's YouTube/Instagram target | `scripts/channel-new.mjs`, `src/lib/channels/add.ts` |
| 1d | MCP: resources, `policy_lint` and the server title answer for the token's channel; `startQueuedEpisode`/`restartHaltedEpisode` now check the token's channel like the 0040 functions | `mcp/surface.ts`, `control.ts` |
| 1e | `verify:channels` — two channels in one scratch DB (CI) | `scripts/verify-channels.mjs` |
| 2 | Instagram Reels variant + draft per bundle, Ready to schedule shows both targets, **Mark posted** with the permalink, read-only Instagram probe (account id + username, Page link), Meta app review checklist | `src/lib/publish/instagram-bundle.ts`, `src/lib/bureau/instagram-draft.ts`, `cover-still.ts`, `ready/page.tsx`, 0020 |
| 3 | `01-trends` scheduled 4×/day (`'40 0,6,12,18 * * *'` UTC = 06:10 / 12:10 / 18:10 / 00:10 IST), `01-trends-now` behind **Run now** on /trends (approver only), Reddit per channel, YouTube Data API v3 (chart by category + search by query), `trends_recent` agent tool | `src/lib/trends/*`, `src/lib/drivers/trends-youtube.ts`, `src/trigger/01-trends.ts` |
| 4 | Voices, Prompts, Music, Concepts built and `ready()`; dead-end sweep | `src/lib/library/*`, `src/app/(app)/library/*`, `concepts/*`, `docs/bureau/dead-end-sweep-2026-10-07.md` |
| 5 | Board and Cuts say when a cut is overlay-only and why (placeholder frames, no active recipe, the episode's own swaps). Nothing spent | `src/lib/bureau/overlay-only.ts` |

**`BUREAU_CHANNEL_ID` under `src/`: before — 55 uses in 19 files. After — 2 lines in 1 file**
(`src/lib/fixtures/seed-channel.ts`: the definition and its doc comment). Harnesses and the
audition scripts still use it as the seed id.

## (a) Migration bundle to paste

`docs/bureau/hosted-migrations-5-0046.sql` — Supabase → SQL Editor → paste → Run → "Success.
No rows returned". Verified locally: applies on a database at 0045 and refuses a second paste.
It adds `channel_publish_targets` (seeds each channel's current platform, plus an Instagram
target for the Bureau with no account id yet), `channel_voice_overrides`,
`trend_signals.channel_id`, `music_beds`, `music_bed_defaults`. Everything deployed tolerates it
not being pasted (screens say "needs migration 0046").

After pasting: **Channels** (sidebar) → Bureau of Reality → Instagram → enter the account id
(digits) and `@handle` → Save.

## (b) New environment variables

| Name | Where | Value from |
|---|---|---|
| `YOUTUBE_DATA_API_KEY` | Vercel **Production**, not Sensitive (synced to the worker on deploy); optional — without it the YouTube source refuses by name and Reddit still runs | Google Cloud console → the project your Gemini key lives in → APIs & Services → Library → **YouTube Data API v3** → Enable → Credentials → Create API key → restrict it to YouTube Data API v3. Free within the 10,000 units/day quota (a search costs 100) — no ledger row |

No other new names. The Instagram integration's fields (`META_IG_USER_ID`, `META_ACCESS_TOKEN`)
already existed; they are only needed for Save and test today.

## (c) Meta app review checklist

Full table in `docs/decisions/0020-instagram-reels-manual.md`. In short, for the **Instagram
API with Facebook Login for Business** path (what is built):

1. Business-type Meta app with Instagram + Facebook Login for Business.
2. Instagram account → Business or Creator, linked to a Facebook Page.
3. Advanced Access for **instagram_basic, instagram_content_publish, pages_show_list,
   business_management**, plus **pages_read_engagement** (Meta lists it for publishing) and
   **instagram_manage_insights** if Reel metrics should be pulled.
4. Privacy policy URL `https://video-pipeline-seven.vercel.app/privacy` (exists); terms
   `/terms`; data-deletion instructions; icon; contact email.
5. Business verification.
6. One screencast per permission (Save and test for the read permissions; the publish flow for
   `instagram_content_publish`), with a written use case each.

Then: token into the Instagram integration, Save and test, and `caps_set
instagram_publish_enabled=true` (approver). Nothing else changes shape.

## (d) What is still not clickable, and why

- **Settings → Generation, Assembly, Publishing, Danger zone** — unbuilt settings sections,
  shown disabled with their reason (unchanged).
- **Voices "Change voice"/"Clear override" and Music "Upload"/"Set default"** — hidden until
  0046 is pasted; the pages say so.
- **Prompts "Reinstate"** — needs a watched sample URL (the guard the brief assumed existed did
  not; it does now).
- **Board rows from another channel** — text, not links, because `/concepts/[id]` 404s across
  channels; switch channel to open them.
- Instagram **publishing** itself — by design until app review (Mark posted is the manual path).

## Found on the way

1. **The recipe activation guard did not exist.** Reinstate would have switched on 0044's two
   seeded recipes with nothing watched. `activationProblem` now refuses without a sample URL.
2. **`check:enums` went red on the first push** (`channel_publish_targets.platform` had no entry
   in `ENUM_CONSTRAINT_MAP`) and stopped every later CI step. Fixed in the next commit; all DB
   harnesses then run locally against the scratch cluster with exit 0.
3. **The Bureau's prompts (`20-bureau.v1.ts`) still describe the Bureau.** A second channel
   with a different format needs its own prompt version — 0019 lists what stays single-channel
   (prompts, the series enum, workspace-wide integrations).
4. `startQueuedEpisode` / `restartHaltedEpisode` accepted any episode id for the web token —
   harmless with one channel, a cross-channel action with two. Now checked.
5. The cover still is stored through `putterFor`, which signs as `video/mp4`; downloading works,
   an inline image preview may not. Worth a content-type parameter on the putter.
6. The harness Supabase shim cannot do embedded selects (`a, b(c)`): a lib function a harness
   drives must use flat queries with `.in()`.

## CI and deploy

- Worker deployed by **Deploy worker (Trigger.dev)** run 14 on `d0f4a25`: success, every step
  (secrets present, Vercel names, Remotion prebuild, dry run, Deploy) read in the step list.
- CI: run 164 (`d64ea0a`) failed at **Enums match the schema** — fixed next commit; run 168
  (trends, `6d4dd70`) success; run 170 (library, `b9d8beb`) success; run 173 (Instagram,
  isolation, overlay-only — `d0f4a25`) **success**, every step read in the step list,
  including the new **Two channels stay apart…** and **Library…** steps, Build, render, episode
  end to end, public pages. The commit carrying this file is docs only.
- Sahil's other session pushed to `main` concurrently (live progress, composite-first render,
  silent-death restart); merged without conflict except one import line on the Board.
