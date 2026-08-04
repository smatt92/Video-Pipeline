# Kiln — Roadmap

Sequenced by risk-retirement, not by feature appeal. Each phase ends with something you can watch.

---

## Phase 0 — Week 0, do these before writing code

Two are wall-clock waits that block later phases. Start them today; they cost an hour each and save four weeks.

| Item | Why it's first |
|---|---|
| Submit Meta app review for `instagram_business_basic` + `instagram_business_content_publish` | 2–4 weeks per submission, rejections restart the clock. Needs a screencast per scope. Nothing about Phase 3 is possible without it. |
| Request YouTube Data API quota increase | Default 10k units/day = ~6 uploads. Increases take weeks. |
| Set up IG Business/Creator account + linked FB Page | Prerequisite for the above; personal accounts have zero API publishing access. |
| Higgsfield plan on an API-enabled tier + note the credit expiry date | API is gated to higher tiers; credits expire ~90 days. |
| Connect hosted Higgsfield MCP to Claude Code | Your exploration surface for Phase 1. |

Also in week 0, non-blocking: run 20–30 shots by hand through the Higgsfield MCP in Claude Code across 3–4 models. You need real cost and quality numbers, and real prompt recipes, before the pipeline has anything to run. **This is also the honest answer to the research framework's Phase 2 — a week of hands-on beats a tool comparison matrix.**

---

## Phase 1 — Generator (weeks 1–3)

**Retires the risk: "can this produce something I'd actually publish?"**

- Next.js scaffold, Supabase schema applied, R2 buckets, Trigger.dev connected
- `VideoDriver` interface + `higgsfield.ts` + a `fal.ts` stub (the stub is not optional — it's what proves the interface)
- Prompt library CRUD + the MCP→library save path
- Manual concept entry (skip trend automation entirely for now)
- Script + shotlist generation via Claude, with an editor UI
- Stage 5 fan-out generate, webhook receiver, `assets` landing in R2
- Cost ledger wired to every call, with a dashboard card
- **Deliverable: you paste a concept, and six generated shots appear in a grid, with the rupee cost under each.**

No assembly, no publishing, no trends. Resist.

## Phase 2 — Assembly + review (weeks 4–6)

**Retires: "is the human-in-the-loop cost low enough for this to beat doing it manually?"**

- ElevenLabs VO + music bed
- Remotion composition: captions, hook text, platform safe areas
- Render variants: `shorts_9x16`, `reels_9x16`, `longform_16x9`
- **The review screen.** Watch, flag, reshoot shot N only, re-assemble. This is the highest-value screen in the product; give it real design time.
- Uniqueness check: `structure_hash` vs last N scripts, blocking
- Metadata generation + thumbnail
- Manual publish path: download button + copy-metadata button
- **Deliverable: concept in, finished 9:16 MP4 out, and you reshot one bad shot without regenerating the other five.**

Publish 10–15 videos by hand from this. That's the real viability test, and it produces the analytics you need for Phase 4.

## Phase 3 — Publishing (weeks 7–9, gated on Meta approval)

- YouTube Data API v3 resumable upload from the Trigger worker, with `altered_content_disclosed` set
- Instagram container → poll → publish, with the "new container on failure, never retry the same one" rule
- Token refresh cron + expiry alerting
- Scheduler with per-platform rate limits declared as data
- Publish queue UI
- **Deliverable: approve in the review screen, it's live in 4 minutes.**

## Phase 4 — Feedback loop (weeks 10–12)

**This is where it stops being a tool and starts being a business asset.**

- Analytics ingest at 6h / 24h / 7d / 30d
- Hook scoring: `retention_3s_pct` per variant, rolled up to prompt recipes and hook patterns
- `v_cost_per_1k_views` on the dashboard
- Trend intake automation (stage 1) + concept scoring against a rubric informed by *your own* performance data, not generic heuristics
- Prompt library `win_rate` backfill
- **Deliverable: the concept queue is ordered by something you learned, not something you guessed.**

## Phase 5 — Optional

- Your own MCP server over the pipeline, so Claude Code can drive it: `create_concept`, `regenerate_shot`, `approve`, `publish`
- Multi-channel / multi-niche
- Second video driver actually wired (fal.ai or Replicate), for cost arbitrage and Higgsfield outage insurance

---

## What "viable" looks like — decide the thresholds now, before you're attached

Write these numbers down before Phase 2 ends. Pre-commitment beats post-hoc rationalisation.

| Metric | Kill threshold (suggested — set your own) |
|---|---|
| Wall-clock human time per published video after Phase 2 | > 45 min → the pipeline isn't earning its build cost |
| Cost per published video (incl. wasted generations) | > ₹800 for a 30s reel |
| Median 3s retention across first 15 published | < 45% → hook problem, not a tooling problem; more automation won't fix it |
| Any monetization strike under the inauthentic content policy | Full stop and re-architect the editorial gate |
| Time from trend detection to published video | > 48h → you've lost the trend-riding advantage the whole thesis rests on |

## Studio surface — recorded, not built

From a competitor's App Mode screen, noted so they are not re-derived. Both are for after
the current sweep.

**1. Quota at the point of action.** Runs remaining beside the Run control, not in Settings.
Same argument as the limits card on the board and a better placement — the number matters
at the moment you are about to spend, not when you go looking for it. Note the constraint
the limits card already established: `in_flight` is real and `hits_*` is real, and there is
no windowed quota this codebase can observe, so "runs remaining" has to mean remaining
against the concurrency ceiling, not against a reset window. No countdown over a ceiling.

**2. A structured/freeform toggle over recipe params — with one condition.** Typed fields
for the common path, raw JSON for verbatim capture.

The condition is the whole of it: **exactly one is authoritative at any moment, and the
screen states which.** The reference implementation shows dropdowns reading
"Long Waves / Platinum White" beside a prompt reading "loose waves, copper red", with the
custom-prompt toggle OFF — two sources for one fact, visibly disagreeing, nothing indicating
which wins. That is the failure this project has spent a week removing: a display that is
wrong rather than a control that is absent, and the guardrails screen showing 12 against a
constraint enforcing 8 was the same shape.

So if it is built: the toggle sets which source is authoritative, the inactive one renders
as derived-and-stale rather than as an equal field, and `RecipeInputSchema` validates
whichever is authoritative. If the two cannot be kept in sync structurally, ship only the
raw JSON — verbatim capture is what the library is for.
