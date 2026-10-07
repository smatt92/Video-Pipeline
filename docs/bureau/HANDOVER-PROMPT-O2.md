# Handover — Prompt O2: Redraw this picture, and Instagram Reels from Kiln (07-Oct-2026)

Decision: `docs/decisions/0023-instagram-reels-publishing.md`. Register: `0008` §28–§29.
**Migration 0050 — one paste**, after O1's 0049 (no dependency between them; order only keeps
the ledger tidy): `docs/bureau/hosted-migrations-8-0050.sql`. Code works before it is pasted.

## What landed

| # | Item | Where |
|---|---|---|
| A1 | Cuts, awaiting cut: under every illustrated shot, a thumbnail per picture (presigned GET, newest per part) with **Redraw** and an optional one-line note | `bureau/cuts/page.tsx`, `components/bureau/redraw-picture.tsx` |
| A2 | `requestRedraw` (approver only, `authorship_log` action `still_redraw`, one in flight per episode) → **`25-redraw`** (concurrency 1, no auto-retry, replayable) → `runRedraw`: `generateStillForShot` per asked part with the note as an **APPROVER DIRECTION** under prompt **`21-still.v4`** (v1–v3 kept), ledger estimate before the call, key `still:<shot>[:p<part>]:<attempt>`; then **only the composite** (`assembleEpisode` `layers:['composite'], keepStatus, keyTag` — new key, old bytes untouched), `final_render_id` moved, loudness re-measured. Episode stays `awaiting_cut` on the **same** cut token; approve later masters from `stillsByPart` | `lib/bureau/redraw.ts`, `redraw-state.ts`, `stills.ts`, `episode-steps.ts` (2 opts), `trigger/25-redraw.ts`, `effects.ts`, `ui-actions.ts` (`redrawAction`) |
| A3 | In flight: `qc.redraws[]` (state queued → drawing → rendering → done/failed, reason), progress via `status_detail` + LiveStatus/LiveRefresh; **approve/reject refused** in `decideCut` AND `bureau_cut_decide` (0050). Stale after 2 h in both. A failed redraw keeps the previous picture and says why on Cuts | `control.ts`, `0050_redraw_holds_the_cut.sql`, `cut-controls.tsx`, `live-status.tsx` |
| A4 | MCP `shot_regenerate` on a still → the redraw path (`part` optional, default all parts); agent token refused by name | `episodes.ts`, `mcp/surface.ts` |
| A5 | `verify:episode` §12 (in CI) — see 0008 §28 | `scripts/verify-episode.mjs` |
| B1 | CLAUDE.md current phase; Ready banner; decision 0023 citing Meta's overview | `CLAUDE.md`, `bureau/ready/page.tsx` |
| B2 | Driver on Graph **v25.0**: REELS container with `cover_url` (the stored cover still), status, `media_publish`, **permalink + shortcode read-back**; Reels limits 3 s–15 min (docs) | `lib/publish/instagram.ts` |
| B3 | `publishReel`: readiness (flag, kill switch, target enabled, integration verified) → limit → preflight → **CAS claim** scheduled→uploading → container (re-used if FINISHED) → 5 × 60 s `wait.for` (Meta: no webhook; once a minute ≤ 5 min) → `publishing_at` mark → media_publish → media id → permalink into `external_url`, shortcode into `external_post_id` (Mark posted's fields). Never twice: live / unrecorded media_publish / PUBLISHED container refuse | `lib/publish/ig-run.ts` |
| B4 | Ready: **"Publish to Instagram now"** (→ `26-ig-post`) and **"Publish at the slot"** (→ the 15-min `23-ig-publish` cron), both via `bureau_mark_scheduled` (review gate, kill switch, daily cap, log); shown only when ready, else the manual card stays with the reason; failed → reason + "Publish again"; live → permalink link | `instagram-draft.ts` (`requestInstagramPublish`), `ready-controls.tsx`, `trigger/26-ig-post.ts`, `trigger/23-ig-publish.ts` |
| B5 | Save and test gains a third check, **publish** (`content_publishing_limit` — needs `instagram_content_publish`; posts nothing) | `instagram.ts` (`probeInstagram`), `drivers/catalog.ts`, `probes.ts` |
| B6 | `caps_set` can flip `instagram_publish_enabled` (0050 — the allowed list never had it, so nothing could turn it on) | `0050`, `mcp/surface.ts` |
| B7 | `verify:ig-publish` (new, in CI) + `verify:channels` §6 — see 0008 §29 | `scripts/verify-ig-publish.mjs` |

## The bundle

`docs/bureau/hosted-migrations-8-0050.sql` — Supabase → SQL Editor → paste → Run → "Success. No
rows returned". Two `create or replace`s: `bureau_cut_decide` (+ the redraw refusal) and
`bureau_caps_set` (+ `instagram_publish_enabled`). Paste **after** O1's 0049 bundle, and after
the earlier outstanding ones (5-0046, 6-0047-0048) if those are still unpasted. Verified
locally: applied to a database without 0050, function replaced; a second paste refused by the
version guard. Until pasted: the TypeScript refusal still covers the web and the MCP connector
(both go through `decideCut`); only a raw RPC is uncovered, and the Instagram switch can only be
flipped by SQL.

## Per-redraw cost (₹88/USD, the stored FX)

| | |
|---|---|
| One picture — `gen4_image` 720p, USD 0.05 × ₹88 | ₹4.40 (ledgered before the call) |
| Its rewrite — one fast-tier call (~520 in / 50 out, as measured on S001) | ≈ ₹0.07 |
| **Per picture redrawn** | **≈ ₹4.47** · a 4-picture shot ≈ ₹17.9 |
| The composite re-render | worker compute only — not in the ledger (no vendor) |

Instagram posting is free at Meta: no ledger row.

## Sahil's Meta setup (nothing has been posted)

1. **developers.facebook.com → My Apps → Create app**, type **Business**; add the products
   **Instagram** (API setup with *Facebook login*) and **Facebook Login for Business**.
   Development mode is fine: Standard Access serves people with a role on the app.
2. **Instagram account → Professional (Business or Creator)**, linked to a **Facebook Page**
   you admin (Instagram → Settings → Accounts Center).
3. **App roles**: you are Administrator as the creator; the token must be yours (a person with
   a role). No App Review, no Business Verification — those are Advanced Access.
4. **Permissions** (Standard Access): `instagram_basic`, `instagram_content_publish`,
   `pages_show_list`, `pages_read_engagement` (+ `business_management` if the Page sits in a
   business portfolio).
5. **Token**: Graph API Explorer → your app → User token with those permissions → Generate →
   grant the Page and the IG account → exchange for a **long-lived** token
   (`GET /oauth/access_token?grant_type=fb_exchange_token&client_id=…&client_secret=…&fb_exchange_token=…`;
   ≈ 60 days — renew before it lapses). Account id:
   `GET /me/accounts?fields=instagram_business_account` → `instagram_business_account.id`.
6. **Vercel → video-pipeline → Environment Variables → Production**: `META_IG_USER_ID`,
   `META_ACCESS_TOKEN`, added **not Sensitive** (`vercel env add … production --no-sensitive`) —
   the worker sync drops Sensitive values silently (0017). Redeploy Vercel, then run **Deploy
   worker (Trigger.dev)** so the worker's env syncs from Vercel.
7. **Channels**: the Bureau's Instagram target enabled with account id = `META_IG_USER_ID`.
8. **Settings → Integrations → Instagram (Reels) → Save and test** → three checks pass
   (account read; linked Page and the channel's target; can publish).
9. Paste the 0050 bundle, then `caps_set { instagram_publish_enabled: true }` (approver).
   **Note:** with the flag on, `afterBundle` (unchanged) also schedules every newly approved
   cut's Reel at its slot automatically. Turn it off again after the first post if you want
   only button-driven posts.
10. **First real post**: one approved bundle you pick → Ready → "Publish to Instagram now" →
    watch the permalink appear, open it on Instagram.

## Found on the way

1. **`caps_set` could never turn Instagram on**: 0020 said it would; 0040's allowed list never
   had the key. Fixed in 0050 and asserted.
2. **A re-render overwrote the previous render's bytes** (`renders/<ep>/composite-en.mp4` for
   every composite). A redraw now renders under its own key; the episode run's paths are
   unchanged.
3. Meta's docs (07-Oct) say Reels are 3 s–15 min, not 5–90 s; container checks "once per
   minute, ≤ 5 minutes" (was 40 × 15 s); examples are v25.0 (code was v23.0). All updated.
4. **Not changed — permission denied in-session:** an edit to `after-bundle.ts` (its comment and
   "off" message still say "until Meta app review clears"). The behaviour is untouched; the
   wording is stale. Reword it in a later prompt.

## What is unverified

Everything against Meta (0008 §29); `25-redraw` / `26-ig-post` / `23-ig-publish` on the worker;
a real redraw; the two screens in a browser against the deployed app; the 0050 paste.

## CI and deploy

- CI run **194** on `c2dfe30` (the code commit): **success**, every step read in the step
  list — guards, typecheck, lint, Bureau rules, migrations 0001–0050, enums, drift, catalogue,
  duplicates, every DB harness including the new **Instagram Reels publish — gated, once, with
  the permalink** step, Build, render, **Bureau episode end to end** (with §12 redraw), public
  pages, scaling, tour.
- Worker: **Deploy worker (Trigger.dev)** run 22 on `c2dfe30`: success, every step; "Successfully
  deployed version 20261007.12 … 20 detected tasks" (18 + `25-redraw` + `26-ig-post`).
- Locally before push: `pnpm check` exit 0; `verify:episode`, `verify:ig-publish`,
  `verify:channels`, `verify:bureau`, `verify:bureau-publish`, enums/drift/catalog/duplicates
  exit 0 on a local Postgres 16 + pgvector cluster; `pnpm build` exit 0 with CI's env.
- O1 had pushed nothing to `main` by this push (fetched before committing); no rebase needed.
- Not looked at: Cuts and Ready on the deployed app in a browser (no session here). Cuts shows
  Redraw only on an awaiting cut with illustrated shots; Ready shows "manual" with the reason
  until the Meta steps above are done.
