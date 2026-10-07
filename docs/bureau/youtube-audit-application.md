# YouTube API audit — answers for the form

Form: https://support.google.com/youtube/contact/yt_api_form?hl=en · Applicant: Sahil Mathew.
Why: uploads from an unaudited project are locked private. Kiln's uploader is already built
(`src/lib/publish/youtube.ts`) and gated on `channel_policy.youtube_api_audited`; this audit is
the only thing between it and a public Short. `[…]` = only you know it.

## Before you open the form (≈20 min)

| # | Do | Why |
|---|---|---|
| 1 | Google Cloud Console → the project holding `YOUTUBE_DATA_API_KEY` → copy the **project number** (digits, not the id) | Field 35 |
| 2 | Google Auth Platform → Audience → **Publish app** ("In production") | In *Testing* the refresh token dies after 7 days and the uploader silently stops |
| 3 | Branding: app name **Kiln** (never "YouTube"), home `https://video-pipeline-seven.vercel.app/about`, privacy `/privacy`, terms `/terms` | Must match the form |
| 4 | Screenshots, 1280×720+, **address bar visible**, PNG: `privacy-policy-page.png` (/privacy, YouTube section in view), `homepage-privacy-link.png` (/about with the Privacy link), `terms-of-service.png` (/terms), `upload-interface.png` (Ready screen with the S001 bundle), `oauth-consent.png` (Google consent screen showing the two scopes) | Fields 40–41; one file each, < 10 MB |

## Field-by-field

| Field | Answer |
|---|---|
| 1 Reason | Compliance audit for additional quota *(the only first-audit option; quota itself stays default)* |
| 2 Applying | As individual user |
| 3 Legal name | Sahil Mathew |
| 4 Organization legal name | Sahil Mathew |
| 5 Parent company | self |
| 6 Website | https://video-pipeline-seven.vercel.app/about |
| 7 Address | […] Hyderabad, Telangana, India |
| 8 Category | Media & Entertainment (or Content creation) |
| 9 Size | Individual / 1 person |
| 10–13 Contacts | Sahil Mathew · sahil.matt@gmail.com · technical and business: same as primary |
| 14 Work related to YouTube | *see block A* |
| 15 Audience | Content creators *(the only user is the channel owner)* |
| 16 Monetization | No monetization of the API client; the channel itself earns through the YouTube Partner Program |
| 17–18 Ads within content | Not applicable |
| 19 Partner manager | No |
| 23 Learned about API | Google Developers documentation |
| 24–25 | blank |
| 26 API client name | Kiln |
| 27 Contains "YouTube" | No |
| 28 Primary access URL | https://video-pipeline-seven.vercel.app |
| 29 Privacy policy | https://video-pipeline-seven.vercel.app/privacy |
| 30 Terms | https://video-pipeline-seven.vercel.app/terms |
| 31 Publicly accessible | No — private tool behind sign-in, single operator |
| 32 Demo account | *see block C* |
| 34 Projects | 1 |
| 35 Project number | […] |
| 36 Use case | Video Uploading & Account Management; Analytics & Reporting |
| 37 OAuth | Yes |
| 38 Derived metrics | **Tick it.** Trends stores public view counts of other channels' trending videos and derives a velocity from them — that is exactly what this permission covers |
| 39 Expected usage | ≤ 3 uploads/day plus a few hundred list calls — well under the 10,000-unit default |
| 42 Endpoints | `videos.insert`, `videos.list`, `playlistItems.list`, `commentThreads.list`, `search.list` |
| 42 Total quota | **No change / Default quota** |
| 43 Architecture diagram | Optional — *block B* as a one-page PDF if you want it |
| 46–48 | Tick all, after reading them |

### A — field 14 (paste)

> Kiln is a private production tool I built and operate for my own YouTube channel, Bureau of Reality (@BureauofReality), an animated science-explainer Shorts series. Kiln drafts each episode, renders it, and holds it for my review; nothing reaches YouTube until I approve the final cut on a review screen, and a database constraint refuses publication of any video without that recorded approval.
>
> The API is used for two things on my channel only. (1) Upload: once I approve a cut, Kiln uploads it to my channel with videos.insert as private with a publishAt time, with its title, description, tags, madeForKids=false and the altered/synthetic content disclosure set, so YouTube publishes it at the scheduled slot. (2) Measurement: Kiln reads my own videos' statistics (videos.list, playlistItems.list, commentThreads.list) and YouTube Analytics reports so I can see which episodes work. search.list is used read-only to find public topics trending in science, which inform what I write next.
>
> There are no other users and no access to anyone else's channel or data. The OAuth refresh token is stored encrypted on the server, never in a database column; I can revoke it at any time from my Google account, and the privacy policy explains deletion. For topic research Kiln stores the id, title and public view count of trending videos it finds and derives a view-velocity from them to rank topics; it never downloads, embeds or redistributes other creators' videos, and it sells no ads.

### B — how it works (for field 43 or "special instructions")

Approve cut (Kiln review screen, signed-in owner) → DB trigger `enforce_review_pass` allows the
publication row → background worker (Trigger.dev) streams the MP4 from storage to
`upload/youtube/v3/videos` with OAuth (`youtube.upload`) → stores the returned video id →
metrics job reads `videos.list` + YouTube Analytics (`yt-analytics.readonly`) daily.

### C — field 32 demo account

Kiln has a single operator and no self-signup. Two honest options:
- **Preferred:** leave credentials blank and write in Special Instructions: *"Single-operator
  private tool; screenshots of every screen that touches YouTube data are attached. Happy to
  give a live screen-share walkthrough on request."*
- Or create a separate reviewer login in Kiln (read-only approver) and give that — not your own
  account. Say so and I'll add a reviewer role.

## After approval

Set `youtube_api_audited = true` on the Bureau's `channel_policy` (one SQL line, given then),
connect YouTube once through OAuth, and the Ready screen's manual card becomes an upload.
Typical turnaround is weeks; Google may email follow-up questions — forward them.
