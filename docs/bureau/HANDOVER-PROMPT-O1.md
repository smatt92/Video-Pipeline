# Handover — Prompt O1: the four Settings sections, and Reddit + Google Trends as sources (07-Oct-2026)

Commit `0702e7e` on `main` (rebased onto O2's `c2dfe30` + `0e870ee`). Register: `0008` §30.
Migration **0049** — bundle `docs/bureau/hosted-migrations-7-0049.sql`.

## What landed

| Section | URL | What it does | Reads / writes |
|---|---|---|---|
| A Generation | `/settings/generation` | Seconds per picture, most pictures per shot; per-series video type + voice pace (Approvals still overrides per episode); picture style (≤400 chars) with the composed prompt preview; read-only: active recipes, `GENERATION_FAILOVER`, picture integration verified, picture rate, stills switch | `channel_policy.seconds_per_picture/max_pictures_per_shot` (0049); series via `updateSeries`; `channel_bibles.world.still_style` |
| B Assembly | `/settings/assembly` | Line gap, tail, loudness target, caption scale, hook scale, hook duration; safe area drawn read-only; "next render only" | `line_gap_s, tail_s, loudness_target_lufs, caption_scale, hook_scale, hook_s` (0049) |
| C Publishing | `/settings/publishing` | Slot time + zone (validated — a zone Postgres doesn't know would break `v_slot_status`); madeForKids; synthetic flag `auto` (realistic shot) / `always` — no "never"; publish targets (the existing `TargetForm`); read-only YouTube audit + Instagram flag/target | `default_slot_time, slot_timezone` (0037, live now); `made_for_kids_default, synthetic_disclosure` (0049) |
| D Danger zone | `/settings/danger` | Approver only; slug typed for every action. Find orphans (dry run) → delete needs slug **and** the count → `99-purge-orphans` worker task re-checks each before deleting bytes then row. Unstick: failed, or running with 30 min silence → `halted` + reason → Restart appears. Rotate keys: checklist with last-verified dates linking each card's Save and test. No rate-card reset, no gate bypass, no episode delete | `authorship_log`: `orphans_purge_requested`, `orphans_purged`, `episode_unstick` |
| E | `sections.ts` | All four tabs live, phase badges gone | — |
| F Trends | `/trends` | "Latest run" lists every source's own sentence ("Reddit: r/x: refused 403 — needs an app"); Reddit via OAuth client credentials; Google Trends from the public trending RSS (default IN, US; `google_trends: {geo:[…]}` or `null` in trend sources) | `trend_runs` (0049) |

**One reader for every value:** `readTuning(db, channelId)` (`src/lib/settings/tuning.ts`). Callers changed: `estimateEpisode` (now *requires* `channelId`), `pictureSpansFor` (now *requires* the tuning — which caught O2's three new callers in `redraw.ts` and Cuts at typecheck; fixed), stills step, assembler (pictures, LUFS, `textScale`, hook), `voiceStep` (gaps), longform loudness, `bundleEpisode` (disclosures), `20-episode` (records `loudness_target_lufs` beside the measurement; Cuts judges against it). Before 0049 is pasted: constants + "needs migration 0049" on each screen; writes refuse with the same sentence.

Touched outside my area, minimally: `episode-steps.ts`, `voice.ts`, `qc.ts`, `longform.ts`, `estimate.ts`, `briefs.ts`, `format-estimates.ts`, `bureau-video.tsx` (`textScale` prop), `bible.ts` (`google_trends` in `TrendsConfigSchema`), Cuts (`loudness_target_lufs`, tuning arg), Ready (madeForKids no longer a literal "No"), `20-episode.ts`, `01-trends.ts`, `redraw.ts`, `enums.ts`, `drivers/env.ts` + `worker-env.ts` (Reddit vars, optional), `supabase-shim.mjs` (`.range()`).

## The bundle to paste

`docs/bureau/hosted-migrations-7-0049.sql` — one transaction, version-guarded, refuses a second paste (proved locally on a DB at 0048). **Order:** the hosted project is at 0045, so: `hosted-migrations-5-0046.sql` → `hosted-migrations-6-0047-0048.sql` → **`hosted-migrations-7-0049.sql`** → O2's `hosted-migrations-8-0050.sql`. 0049 and 0050 are independent (0049: `channel_policy` columns + `trend_runs`; 0050: redraw/caps functions), so 0050 before 0049 also works, but paste in number order.

## What Sahil must do

| # | Step |
|---|---|
| 1 | Paste the bundles in the order above (SQL Editor → Run → "Success. No rows returned") |
| 2 | Reddit: reddit.com/prefs/apps → "create another app…" → type **script** → name `kiln-trends`, redirect uri `http://localhost:8080` (required by the form, unused) → the id is the string under the app name, the secret is "secret" |
| 3 | Vercel → Project → Settings → Environment Variables → **Production**: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` — **not "Sensitive"** (the worker sync cannot read Sensitive values and skips them silently, decision 0017) |
| 4 | Redeploy the worker so its env syncs from Vercel: Actions → "Deploy worker (Trigger.dev)" → Run workflow (`dry_run_only` false). The env is copied from Vercel production at deploy (`src/lib/trigger/vercel-env.ts`); nothing else syncs it. Redeploy Vercel too so /trends shows "set" |
| 5 | Decide on Reddit's terms: the free API tier is non-commercial; a monetised channel may count as commercial (said on /trends) |
| 6 | After a run (or Run now), /trends → "Latest run" shows each source's answer |

## What is unverified

- Reddit's real token/listing endpoints and Google's real RSS: this container's egress refuses `www.reddit.com` and `trends.google.com` (curl: CONNECT 403; WebFetch timed out on permission). The RSS element names (`ht:approx_traffic`, `ht:news_item…`) are from the feed's published shape; the parse is strict, so a change shows as "unexpected feed shape" on /trends, never a blank.
- No Settings screen has been opened signed in (build compiles all four; harness drives the lib functions). No paste on the hosted project. `99-purge-orphans` never ran against the real bucket.
- `src/lib/publish/run.ts` (the dormant YouTube upload lane) still sends `madeForKids: false` regardless of the setting; it uploads nothing while unaudited. Bundles (what is used today) carry the setting.

## Verified

`pnpm check` exit 0; local Postgres 16: `verify:settings` (new, in CI after "Stage 1"), `verify:trends` (§13 Reddit 403 / no creds / creds / RSS / feed down; §14 no `trend_runs`), `verify:episode`, `verify:channel-bible`, `verify:channels`, `verify:ig-publish`, `verify:bureau`, `verify:bureau-publish`, `verify:submit`, `verify:library`, `verify:onboarding` and 10 more, `check:enums/drift/catalog/duplicates`, `next build`.

## CI and deploy

- CI run **196** on `0702e7e`: **success** — step list read: guards, typecheck, lint, migrations 0001–0050, enums, drift, catalogue, duplicates, every DB harness including the new **"Settings — generation, assembly, publishing and the danger zone"** and Stage 1 (trends §13–14), Build, render, episode end to end, public pages, scaling, tour.
- Worker: **Deploy worker (Trigger.dev)** run 23 on `0702e7e`: success, every step — "Successfully deployed version 20261007.13 … 21 detected tasks" (O2's 20 + `99-purge-orphans`).
- Vercel production for `0702e7e`: **not confirmed from here** — the Vercel connector is not authorised for the team scope (403) and the container's egress refuses the app's host. Open https://video-pipeline-seven.vercel.app/settings/generation (…/assembly, …/publishing, …/danger) once to confirm; the build is the same `next build` CI ran green.
- Rebased onto O2 (`c2dfe30`, `0e870ee`); one conflict in `0008` (both appended a §28) resolved — mine is §30. O2's three new `pictureSpansFor` callers were updated to pass the channel's tuning.
