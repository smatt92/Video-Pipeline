# 0023 — Instagram Reels publish from Kiln, to accounts we own; YouTube stays manual

**Date:** 2026-10-07
**Status:** accepted — built and proven against a stub Graph API; no real post yet (0008 §29)
**Supersedes:** 0020's premise that automatic Instagram publishing waits on Meta app review.
0020's draft, cover, caption and Mark posted all stand.

## Why the premise changed

CLAUDE.md's current phase said "do not build auto-publish until Meta app review clears", and
0020 listed an Advanced Access submission. Meta's own overview says otherwise for our case
(https://developers.facebook.com/docs/instagram-platform/overview, read 07-Oct-2026):

> "If your app only serves your Instagram professional account or an account you manage,
> Standard Access is all your app needs."

Advanced Access — and with it App Review and Business Verification — "is the access level
required if your app serves Instagram professional accounts that you don't own or manage". Kiln
posts only to the channels' own accounts, so Standard Access is enough.

YouTube is unchanged: its upload API stays locked to private uploads until Google's audit
clears (submitted 07-Oct, `docs/bureau/youtube-audit-application.md`). Publishing there stays
manual (download → Studio → Mark scheduled).

## Decision

1. **Only accounts we own.** The app is used by people with roles on it, for the channels'
   own professional accounts. Serving anyone else's account would need Advanced Access and is
   out of scope.
2. **Only behind the gates.** A Reel is posted only from `scheduled`, which only
   `bureau_mark_scheduled` writes (enforce_review_pass, enforce_channel_policy: review pass,
   kill switch, daily cap; authorship log). Then `publishReel` (`src/lib/publish/ig-run.ts`)
   refuses unless `channel_policy.instagram_publish_enabled` is on, the channel's Instagram
   target is enabled and the integration has verified, and the account's publishing limit has
   room. No override flag exists.
3. **Ready → "Publish to Instagram now" or "Publish at the slot"**, approver only, shown only
   when all of (2) hold; otherwise the manual card stays with the reason. Now = `26-ig-post`;
   slot = the 15-minute `23-ig-publish` cron.
4. **Never twice.** A compare-and-set claim (`scheduled → uploading`); `bundle.publish` records
   the container, a `publishing_at` mark right before media_publish and the media id right
   after; a replay that finds the mark without an id refuses (Meta may have posted) and is
   reconciled by Mark posted.
5. **Polling, bounded, with the reason in the code.** Meta has no webhook for container
   processing (rule 4's exception) and says to check "once per minute, for no more than 5
   minutes" (content-publishing guide). Five one-minute `wait.for` checkpoints.
6. **Facebook Login for Business** (graph.facebook.com, v25.0 — the version Meta's examples
   use): permissions `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`,
   `pages_show_list` (Save and test reads the linked Page). Save and test now also reads
   `content_publishing_limit`, which proves the publish permission without posting.

## Facts checked against Meta's docs on 07-Oct-2026

| Fact | Source |
|---|---|
| Standard Access suffices for accounts you own or manage | Instagram Platform overview |
| 100 API-published posts per 24 h moving window; read `GET /<IG_ID>/content_publishing_limit` | Content publishing guide |
| REELS container: `media_type=REELS`, `video_url` (public server), `caption`, `share_to_feed`, `cover_url` (wins over `thumb_offset`) | IG User /media reference |
| Container `status_code`: EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED; check once a minute ≤ 5 min | Content publishing guide |
| `POST /<IG_ID>/media_publish` with `creation_id` | Content publishing guide |
| Reels 3 s – 15 min, ≤ 300 MB, 9:16 recommended | IG User /media reference |
| IG Media fields `permalink`, `shortcode` | IG Media reference |

## Not changed, and why

`afterBundle` still schedules the Reels draft at the slot automatically when
`instagram_publish_enabled` is on (0012's switched-off path, kept). With the flag on, every
approved cut's Reel is therefore posted at its slot without a second click; with it off,
nothing is scheduled and Ready's buttons are hidden. Turn the flag on only when that is wanted.

## Not verified

Everything against Meta (0008 §29). The first real post is one approved bundle Sahil picks.
