# Handover — Prompt M: the live app on the Studio Redesign canvas (07-Oct-2026)

The app now follows the Claude Design canvas "Kiln — Studio Redesign" (desktop and phone).
Every number on every screen comes from the database. Where the canvas showed a sample
figure that the database cannot back, the screen shows "—" and the reason. No pipeline
logic changed, nothing was spent, and nothing was published. There is still no
publish-now or skip-review control anywhere.

## What landed, one commit per step

| Step | Commit | What |
|---|---|---|
| 1 Tokens + brand v2 | `424701b` | `src/styles/tokens.css` (canvas tokens, paper set, motion, scale), `kiln.css` component sheet, `KilnMark`/`Wordmark`/`Lockup`, favicon, apple-icon, PWA manifest and icons |
| 2 UI components | `dbfea30` | `src/components/ui/*`: Button, Pill/EpisodeStatePill/Basis/Gate, Card/StatTile (null → "—" + why), Segmented/Switch/Menu, player with per-shot scrub and LUFS HUD, cones, countdown, busts, Bureau building, kiln object |
| 3 Shell | `f407d7d` | Rail (grouped nav, badges from real counts, channel menu, kill switch), phone tab bar and More sheet, ⌘K scoped to the active channel, sign-in splash; sign-in now lands on `/home` |
| 4 Screens | `6830007`, `3c80e33`, `67de459` | Home, All channels, Approvals, Board, Cuts, Ready, Calendar, Generation, Metrics, Costs, Authorship, Settings and Integrations, Library (Voices, Prompts, Music); legacy pipeline screens moved onto the shared components; v1 token aliases deleted |
| 5 Onboarding | `a45e54f` | `/setup` rebuilt (details below) |
| 6 Voice | `bf1ed9d` | Every `notify()` line rewritten per BrandVoice: what happened, then what to do and where. Sign-in email on the paper set. Not-configured page uses the brand colours |
| 7 Accessibility | `071de89`, `95ec612` | 44px touch targets at phone width, contrast fixes, focus rings (`:focus-visible` on `--ac`), the tour's 44px buttons restored |
| 8 Screens | `04ce362` | 96 screenshots in `docs/design/kiln-redesign/screens/` (48 routes × 1440/390); three pages that scrolled sideways on a phone fixed |

### Setup (step 5)

- **Ten pages** in `src/lib/onboarding/pages.ts`:
  - Studio: Profile & storage, Writing & embeddings, Video & voice (the canvas's "Runway"; the vendor rule keeps the name in the driver layer), Rate card.
  - Channel, repeatable: Basics, Cast & voices, Series & slots, Caps & trends.
  - Optional: Connections.
  - Finish: First episode.
- **How the pages work.** Studio pages reuse the wizard's own step forms and actions. "Save and test" is still the only thing that ticks a step.
- **When a channel page counts as done.** Channel pages call the 0022 bible actions (`createChannelAction`, `lockVoiceAction`, `updatePolicyAction`, `updateTrendSourcesAction`). Each one is done when the channel's own rows say so; no tick is stored:
  - Cast is done when every character routes to a voice, checked with `voicesScreen`, the same check the voice stage uses.
  - Schedule is done when a slot lies ahead.
  - Caps is done when both the daily and per-Short caps are set.
- **The spine** (`src/lib/onboarding/spine.ts`) names what still blocks the first video, one sentence per blocker. `/setup` resumes at the first page that is not done.
- **Old step slugs still work.** `/setup/profile`, `/setup/channel` and the other old step slugs redirect to the page that now shows that step.
- **+ Add channel** (rail menu, More sheet, All channels, Integrations, Channels) now goes to `/setup/basics?new=1`. `/channels/new` redirects there. The second add-channel form and `addChannelAction` are deleted, because two code paths for one concept is worse than one.
- **Keys** show one of three states: "found in environment" (name only), "stored in Vault ••••last4", or missing. Connections are marked optional and never "blocks step". Instagram is marked manual until Meta app review clears.
- **Cast audition** plays takes that are already stored. Nothing on a setup page can generate anything, so nothing there can spend.
- **Finish** shows the blockers while any remain. Once none remain, it shows the latest episode's cones and estimate, then Approvals → Cuts → Ready with live counts.
- **Onb-States is implemented** on every page: a dashed empty state, and a red error with one sentence and one action. The two exceptions are listed in (b).

## (a) Migration bundle to paste

**None from Prompt M.** No file in `supabase/migrations/` was added or changed by these commits. 0047 and 0048 on main came from Prompt N (`c1d69c8`); their bundle is in Handover N.

One dashboard paste is optional. The sign-in email on the paper set is `supabase/templates/magic_link.html`. Local Supabase reads it through `config.toml`. The hosted project reads its templates only from Auth → Email Templates → Magic Link, so paste it there if you want the hosted email to match.

## (b) Screens that differ from the canvas, and why

| Screen | Canvas | Live | Why |
|---|---|---|---|
| Sign-in | Passkey button | Google, then email link | There is no passkey sign-in. A button for it would be a control that does nothing |
| Onboarding · Runway | "Runway" title, vendor logo | "Video & voice" | Rule 1: no vendor name outside the driver layer, comments included |
| Onboarding · keys | Env keys shown with last 4 | Env keys by **name only**; Vault keys last 4 | Decision 0017: the environment is not this app's to display. The prompt asked for last 4. The decision record wins until it is amended |
| Onboarding · Cast audition | Plays a fresh sample of each preset | Plays the last stored take | Generating a sample spends. The page must not spend |
| Onboarding · Schedule | Add series and weekdays | Read-only series table and next 7 slots | Slots come from the topic calendar (`scripts/calendar-sql.mjs` → migration). No screen writes a slot yet |
| Onboarding · Schedule error | "Two series are on Monday" | Not shown | The Bureau runs two Monday series on purpose. The check would fire against correct data |
| Onboarding · Caps & trends error | "r/askscienc → r/askscience" suggestion | The action's own refusal sentence | No subreddit lookup exists in this build to suggest a correction from |
| Metrics | Sample chart data | Only measured snapshots; "—" where none | Absent ≠ zero. The canvas samples are not data |
| Home · Partner Program | Subscriber count | Subscribers "—" | No subscriber metric is measured |
| Home | YouTube quota tile | "Publish cap today" | Phase 1 publishes manually, so there is no quota spend to show |
| Settings | Tabs for every section | Unbuilt sections are disabled tabs, each with its reason | They do not exist yet |
| Rail | Pipeline group absent | Pipeline group kept (Trends … Publish) | Those screens are live and reachable only from there |
| All channels · kill switch | One switch | Loops the per-channel action | There is no all-channels kill action, and adding one is pipeline logic |
| Cuts | "I listened" checkbox always | Only when lines are unaligned | That is when it is needed: the alignment rule already checked the aligned ones |
| Script board, Concepts, Prompts (phone) | — | Tables scroll inside their card | They were wider than 390px and scrolled the whole page |
| Script board total | — | "— nothing priced yet" instead of "₹0.00 across 0" | Absent ≠ zero |

## (c) Production URLs to check, desktop and phone

- https://video-pipeline-seven.vercel.app/home — channel Home
- https://video-pipeline-seven.vercel.app/all — all channels
- https://video-pipeline-seven.vercel.app/bureau/approvals · /bureau/cuts · /bureau/ready · /bureau/board · /bureau/calendar · /bureau/monitor · /bureau/metrics · /costs · /bureau/authorship
- https://video-pipeline-seven.vercel.app/library/voices · /library/prompts · /library/music
- https://video-pipeline-seven.vercel.app/settings/integrations
- https://video-pipeline-seven.vercel.app/setup — resume, then each page: /setup/studio, /setup/models, /setup/generation, /setup/rate-card, /setup/basics, /setup/basics?new=1, /setup/cast, /setup/schedule, /setup/caps, /setup/connections, /setup/finish
- https://video-pipeline-seven.vercel.app/login — signed out

## Found on the way

- **`.lg` shadowed `.btn.lg`.** A global `.lg` class (the integration logo tile) shared its name with the large-button modifier. Every large button since step 4 rendered as a 40px square with overlapping text. It is renamed `.ig-logo`. Nothing failed, because no guard reads layout.
- **A comment named the vendor while explaining why not to.** `check:vendors` caught it, as CLAUDE.md predicts.
- **The tour contrast check depends on layout.** CI runs 184 and 185 went red on "The tour backdrop renders…". Moving the tour buttons to `.btn` shrank them from 44px to 36px. The footer got shorter, so the paragraph slid over a brighter part of the scene and measured 2.81:1. Fixed in `95ec612`, and run 186 is green. Any change to the tour's vertical layout can move text over the bright part of the scene.
- **Cost-stage and recipe rows were dimmed with `opacity`.** That took `t3` text below 3:1. Opacity is a contrast change, not a style. Those rows now rely on their "—" and "retired" labels.
- **Local dev cannot screenshot all 48 routes in one go.** `next dev` runs out of memory in this container after about 30 compiled routes. The screenshots were taken in batches, restarting the dev server between them.

## CI and deploy

- Run 186 (`95ec612`) is green on every step.
- Runs 184 and 185 were red on the tour step only; the cause and fix are above.
- Runs 187 (`04ce362`) and 188 (`f58159c`, this handover) are green, step list read.
- The Vercel production deployments for `071de89`, `95ec612`, `04ce362` and `f58159c` are all READY.
