# 0020 — Instagram Reels: a manual target now, and exactly what Meta app review needs

**Date:** 2026-10-07
**Status:** accepted — manual posting; automatic publishing waits on Meta app review
**Supersedes:** the Instagram half of 0012 #4 (the mirror stays built and off)

## Decision

Every channel can publish to YouTube **and** Instagram (`channel_publish_targets`, 0046). The
Instagram half is manual, because CLAUDE.md's current phase forbids auto-publish until Meta
app review clears:

1. When a cut is approved and bundled, `buildInstagramDraft` writes a second `publications`
   row — `platform = 'instagram'`, `status = 'draft'`, same render and review as the YouTube
   row, `idempotency_key = ig:<youtube publication id>` — with the Reels variant in `bundle`:
   the same 9:16 MP4 (flagged if it is outside the API's 5–90 s, which the app still allows),
   a caption ≤ 2,200 characters with **3–5 hashtags** from the channel bible's
   `publishing.hashtags` (never 30), a **cover still** extracted by ffmpeg at the end of the
   series' cold open (or the frame time when extraction fails), **alt text** and a **first
   comment** (the pinned comment plus the source link). Refused by name for a channel without
   an enabled Instagram target. Built from Ready to schedule for bundles that predate it.
2. **Ready to schedule** shows each episode once, with a YouTube and an Instagram section.
   **Mark posted** takes the Reel permalink: it goes through `bureau_mark_scheduled` (review
   gate, kill switch, daily cap, authorship log — all in the database), then records the row
   `live` with the shortcode in `external_post_id` and the permalink in `external_url`, so
   metrics can find it once the read permissions exist.
3. The switched-off auto path (`afterBundle` when `instagram_publish_enabled`) now schedules
   the existing draft instead of inserting a second row for the same cut.
4. The **Instagram integration's Save and test** is read-only: `GET /{ig-user-id}?fields=id,username`
   (only a professional account has a Graph node) and `GET /me/accounts?fields=name,instagram_business_account{id,username}`
   (the account is linked to a Page the token sees, and is the active channel's target). No
   publish permission is exercised.

## Meta app review — the checklist to submit

Path: **Instagram API with Facebook Login for Business** (the Graph API at
`graph.facebook.com`, which `src/lib/publish/instagram.ts` calls). The alternative,
*Instagram API with Instagram Login*, uses `instagram_business_basic` /
`instagram_business_content_publish` instead (the scopes ARCHITECTURE §5 quotes); it needs no
Facebook Page but a different token flow and host — not what is built. Verify the list
against the App Review page at submission; Meta renames permissions.

| # | Item | Where it comes from |
|---|---|---|
| 1 | Meta developer app, type **Business**, with the **Instagram** and **Facebook Login for Business** products | developers.facebook.com → My Apps → Create |
| 2 | Instagram account switched to **Business or Creator** and **linked to a Facebook Page** | Instagram → Settings → Accounts Center; Save and test's second check proves it |
| 3 | Permissions requested for Advanced Access: **`instagram_basic`**, **`instagram_content_publish`**, **`pages_show_list`**, **`business_management`**; plus **`pages_read_engagement`** (Meta's content-publishing docs list it alongside these) and **`instagram_manage_insights`** if Reel metrics are to be pulled | App Review → Permissions and Features |
| 4 | **Privacy policy URL**: `https://video-pipeline-seven.vercel.app/privacy` (exists, public) | App Settings → Basic |
| 5 | Terms URL: `/terms`; app icon 1024×1024; category; contact email | App Settings → Basic |
| 6 | **Data deletion**: instructions URL (the privacy page's section) or a callback | App Settings → Basic |
| 7 | **Business verification** of the business that owns the app (required for Advanced Access) | Business Settings → Security Center |
| 8 | **Screencast per permission**: sign in to Kiln, Settings → Integrations → Instagram → Save and test (shows the account read and the linked Page — `instagram_basic`, `pages_show_list`); Ready to schedule → an episode's Instagram section (caption, cover, alt text) and the publish action as it will run (`instagram_content_publish`) | Record once publishing is enabled in a test build against a test account |
| 9 | Per-permission written use case: "Publishes Reels the account owner has reviewed and approved in Kiln, one at a time, at the scheduled slot; reads the account id and username to confirm the right account" | App Review form |

After approval: set `META_IG_USER_ID` and `META_ACCESS_TOKEN` (long-lived) on the Instagram
integration, Save and test, then flip `instagram_publish_enabled` with `caps_set` (approver
only). Nothing else changes shape.

## Not verified

No real Graph API call has been made from here; the probe, the draft and Mark posted are
proven against stubs and a local database (`verify:channels` §4–§6). The 25-vs-100 posts per
24 h question (ARCHITECTURE §5) is still read from `content_publishing_limit` rather than
assumed, and only matters once publishing is on.
