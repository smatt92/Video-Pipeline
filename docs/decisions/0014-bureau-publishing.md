# 0014 — Bureau publishing: bundles today, two flags for later, and the disclosure per video

Status: accepted · 2026-10-06

## What ships today

`youtube_api_audited = false` and `instagram_publish_enabled = false` (channel_policy, 0037).
So an approved cut becomes a **bundle** — MP4 (presigned, 1 h), title + two alternates,
description with the sourced fact and its URL, tags, `madeForKids = false`,
`containsSyntheticMedia`, pinned comment, slot time — on the Ready-to-schedule page and through
`publish_bundles()`. Sahil schedules it in YouTube Studio and calls
`mark_scheduled(id, at, video_url)`; the video id is what lets the metrics loop find it.

CLAUDE.md current phase forbids auto-publish until Meta app review clears. The upload and the
Reels mirror exist as code paths behind the two flags (`src/lib/bureau/after-bundle.ts`,
`src/lib/publish/ig-run.ts`, `23-ig-publish`), and `verify:bureau-publish` drives both with
the flags on and off. Turning a flag on is the only change needed; nothing bypasses
`enforce_review_pass` or `enforce_channel_policy` — the status change the paths make is
exactly what those triggers inspect, and the harness asserts the kill switch refusing the
mirror at the database.

## The disclosure is decided per video (deviation from 0035's rule)

`publishVideo` refused any publication whose `altered_content_disclosed` was not `true`,
because "every video this pipeline makes is generated". YouTube's own definition of the
`containsSyntheticMedia` flag is *realistic* altered or synthetic content; a chalk-line
stick-figure animation is not that, and the build prompt is explicit: false unless a
realistic scene is present. So for a Bureau publication the bundle records the decision
(`contains_synthetic_media = any shot.realistic`), the publication column carries the same
value, and the upload reads it — refusing if the two disagree or the bundle never decided.
Legacy (non-Bureau) publications keep the old rule unchanged; the harness asserts a legacy
`false` is still blocked.

## Scheduling

With the API audited, a Bureau upload goes up **private with `publishAt` = the slot**, so
YouTube makes it public at the slot and the platform-side look is still available to a human
before then. `v_publish_queue` therefore does not hold a Bureau publication back for a future
`scheduled_for` (it does for legacy rows), and blocks it with `youtube_api_unaudited` while the
flag is false (0041).

## Metrics

`22-bureau-metrics` (hourly): YouTube Analytics `views, engagedViews, averageViewPercentage,
subscribersGained` per video at 1h/24h/72h/7d after the slot; the refresh token needs the
`yt-analytics.readonly` scope. "Viewed vs swiped away" is not in the API — Studio CSV import on
the Metrics page fills it on the latest snapshot. Comments are read through the Data API unit
ledger (`commentThreads.list`, 1 unit) and stored with character-name mentions and a
Complaint Box score. A failed pull is an `unavailable` row with its reason, never zeros.
