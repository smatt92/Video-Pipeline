# Kiln — Architecture

> Working name. Rename freely. Kiln = you put raw material in, controlled heat, finished object out.
> Status: architecture v1, pre-code. Source input: *AI Content Business Research Framework v0.1* (Hari, for Sahil).

---

## 0. Read this first — five things the research framework gets wrong or under-weights

These are not style notes. Each one changes what you build.

### 0.1 Higgsfield is not the bet. The loop is the bet.

The framework treats "Assess Higgsfield as the primary AI video platform" as a Phase-2 gate. It isn't a gate — it's a config value. Higgsfield aggregates Sora 2, Veo 3.1, Kling 3.0, Seedance, Soul, Flux 2, DOP. Those models rotate quarterly. Higgsfield's own API is a gated, sparsely-documented surface with undocumented rate limits and credits that expire on a ~90-day clock.

**Consequence:** the generator is a driver behind an interface from commit one. `VideoDriver.submit() / status() / cancel()`. Higgsfield is `drivers/higgsfield.ts`. fal.ai and Replicate are `drivers/fal.ts`, `drivers/replicate.ts` — write them as 40-line stubs on day one so the interface is proven against two shapes, not one. If you find yourself writing `higgsfield` outside `src/lib/drivers/`, you have made a mistake that will cost weeks later.

The durable asset is the *loop*: trend → hook → shotlist → generate → assemble → publish → measure → feed back into hook selection. Nobody can copy your accumulated hook-performance data. Everybody can copy your model choice.

### 0.2 "Pipeline that mass-produces videos" is the exact thing YouTube demonetizes

This is the biggest business risk in the document and it is listed as one bullet under Phase 7.

<cite index="42-5">On July 15, 2025 YouTube renamed its "repetitious content" policy to "inauthentic content," making repetitive and mass-produced content ineligible for monetization under the Partner Program</cite>. <cite index="39-3">YouTube defines it as content that looks made from a template with little variation across videos, or content that is easily replicable at scale</cite>. <cite index="41-2">A July 2026 clarification broke this into three named categories that cannot be monetized</cite>. Enforcement is real: <cite index="40-6">January 2026 saw YouTube's largest single enforcement wave against AI-generated channels</cite>.

<cite index="39-6">The policy does not target AI. A channel using AI inside a genuinely original production — real script, real editorial decisions — stays eligible</cite>. But the failure mode it describes ("templated scripts with minor substitutions", "easily replicable at scale") is the literal output of a naive version of what you're building.

**Consequences, all architectural:**

| Requirement | Implementation |
|---|---|
| No template reuse across uploads | `scripts.structure_hash` + a uniqueness check that hard-blocks publish if the last N videos share a beat structure |
| Mandatory human editorial step | `reviews` table; `publications` has an FK to a review row with `human_edit_count > 0`. Not a soft warning — a DB constraint. |
| Provable originality for appeals | Store script provenance: which model drafted, what the human changed, diff, timestamps. <cite index="39-2">Appeals succeed on evidence of your production process and script work, not on explaining intent</cite>. Your DB *is* the appeal evidence. |
| Synthetic content disclosure | `publications.altered_content_disclosed` boolean, defaulted true, set on the YouTube upload call. <cite index="36-3">YouTube says disclosure alone does not limit audience or remove monetization eligibility</cite>. |

Design the throttle in, not on. A system that *can't* publish twelve near-identical videos is worth more than one that can and shouldn't.

### 0.3 Auto-publishing is the wrong thing to build first

You put it in "the future" — correct instinct, hold that line. Reasons:

- Instagram requires <cite index="22-1">a Facebook Business account, a linked Page, an Instagram Professional account, a Meta developer app, and approved `instagram_business_content_publish` permission; app review takes 2–4 weeks per submission</cite>. <cite index="23-1">The old `instagram_basic` / `instagram_content_publish` scopes were deprecated on 27 Jan 2025</cite>.
- YouTube's default quota is 10,000 units/day and an upload costs 1,600 — <cite index="24-1">roughly six uploads per day before you request an increase</cite>.
- Publishing saves ~90 seconds per video. Generation + assembly + review saves ~4 hours.

**Consequence:** Phase 1 ships a "Download + Copy Metadata" button. Start the Meta app review paperwork on week one *in parallel* because it's a 2–4 week wall-clock wait, not because you need it in week one.

### 0.4 GTA 6 as the beachhead niche is the highest-risk choice in the doc

Rockstar IP, an audience primed to interpret AI renders as leaks, and "realistic scene that never happened" is precisely the category where <cite index="36-4">YouTube requires altered-content disclosure</cite>. Speculative GTA 6 AI footage is one strike away from a channel-level problem, and it's a pure trend-dependency play with an expiry date on launch day.

I'd argue for it as *channel 2*, after a lower-risk niche has proven the pipeline. But the architecture shouldn't care — `channels` is a table, niches are rows. Keep the niche decision reversible and out of code.

### 0.5 Your bottleneck will be hooks, not generation

Cost per video is the framework's headline metric. It's the wrong one. At Higgsfield rates a 30s reel is a few hundred rupees of credits; the number that decides the business is what fraction of reels clear the 3-second retention cliff. That's a hook problem.

**Consequence:** variants are a first-class entity, not an afterthought. One concept → 5–10 hook variants → the same body. `renders` has a `variant_group_id`. The analytics loop scores hooks, not videos.

---

## 1. Stack

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| UI + control plane | Next.js 15 (App Router) on Vercel | You asked for Vercel and it's right — for the *control plane*. See §2 for what must not live there. |
| Durable orchestration | **Trigger.dev v3** | The pipeline is a multi-hour DAG with external async callbacks and fan-out. Vercel functions cannot hold that. Trigger runs your code in its own containers, so ffmpeg/Remotion live in the same system, and `wait.forToken()` is the exact primitive for "submit job, sleep until webhook, resume." Alternative: Inngest (better DX for pure fan-out) **+** a separate Fly.io render worker. Two systems instead of one. Pick Trigger unless you already know Inngest. |
| Database | Supabase Postgres | You already run Supabase on School Eatery — same mental model, RLS, auth, and an MCP you can wire into Claude Code. |
| Object storage | **Cloudflare R2** | Zero egress fees, and Instagram's container API needs <cite index="23-2">a publicly accessible `video_url`</cite>. Supabase Storage works but egress on video will bite. |
| Auth | Supabase Auth | Single user for now; don't build tenancy yet. |
| Video generation | Higgsfield via `higgsfield-js` official SDK | Webhook mode, not polling. See §3. |
| Voice | ElevenLabs | Swap-able behind `AudioDriver`. |
| Assembly | Remotion (composition, captions, safe areas) → ffmpeg encode | Remotion because captions/overlays/hook text need to be *programmatic and versioned*, not hand-placed. Hosted alternative if you want to skip infra: Creatomate or Shotstack. |
| LLM | Claude via Anthropic SDK | Scripts, shotlists, prompt compilation, metadata, concept scoring. |
| Trends | YouTube Data API + Reddit + Google Trends | Cron-triggered ingest. |

---

## 2. The constraint that shapes everything: Vercel can't touch video bytes

| Constraint | Value | What it forces |
|---|---|---|
| Function request/response body | <cite index="27-1">4.5 MB hard limit, returns 413 FUNCTION_PAYLOAD_TOO_LARGE</cite>; <cite index="32-2">infrastructure-level, not configurable in `vercel.json`</cite> | Media never passes through a Next.js route. Browser ↔ R2 via presigned URLs. Workers ↔ R2 direct. Vercel moves *IDs and URLs only*. |
| Max function duration | 800s Pro / <cite index="31-1">1800s beta on Pro+Enterprise with Fluid compute</cite> | Even 1800s doesn't cover a multi-shot generate-and-render run. Orchestration is external. |
| GPU | None on any tier | <cite index="29-2">CPU-only H.265 at 5–10fps means a 10-min video takes 15–25 min, past the 800s Pro timeout</cite>. ffmpeg does not run on Vercel. |

So the shape is fixed:

```
Browser ──presigned PUT──────────────────────────────► R2
   │
   ▼
Next.js on Vercel  (control plane: UI, auth, CRUD, enqueue, webhook receivers)
   │  trigger.dev SDK — enqueue only, returns in ms
   ▼
Trigger.dev v3 (containers: orchestration + ffmpeg + Remotion)
   │                    │                      │
   ▼                    ▼                      ▼
Higgsfield API    ElevenLabs API          R2 (read/write media)
   │
   └─ webhook ──► /api/webhooks/higgsfield (Vercel) ──► resume waiting run
```

Vercel routes stay under 200ms. Every one of them. If a route is slow, you've put work in the wrong place.

---

## 3. Higgsfield: MCP vs REST — use both, for different things

This is the correction to the brief. You said "use Higgsfield MCP to create the videos." Right tool, wrong layer.

| Context | Interface | Reasoning |
|---|---|---|
| Claude Code dev loop, art direction, prompt tuning, "make me twenty variations of this shot and show me" | Hosted MCP `https://mcp.higgsfield.ai/mcp` — <cite index="5-1">OAuth through your Higgsfield account, no API key</cite> | Conversational, exploratory, human-in-loop. This is where MCP is genuinely better than an SDK. Use it to *discover* the prompt/motion/model combos that work. |
| Production pipeline runs | `higgsfield-js` SDK → REST, webhook mode | MCP is an agent-tool protocol over an interactive OAuth session. It is not a job queue. It has no idempotency keys, no retry semantics you control, no per-job cost attribution, and the OAuth token expires. You cannot run a cron-driven pipeline on it and reconcile a credit ledger. |
| Claude Code driving *your* pipeline | Your own MCP server (Phase 3) | `create_concept`, `approve_shot`, `regenerate_shot`, `publish`. This is the fun one and it fits how you work. |

**The MCP → production handoff is the workflow.** Explore in Claude Code with the hosted MCP; when a shot recipe works, `POST /api/prompts` to save it to the prompt library with its exact params. Production reads the library. The MCP session is a lab, the library is the factory floor.

Higgsfield API notes that will cost you time if you don't know them:

- Use webhooks, not polling. The SDK takes `{ webhook: { url, secret } }` and <cite index="18-1">appends `?hf_webhook=<url>` to the endpoint</cite>. Polling burns rate limit you can't see — <cite index="11-1">rate limits are undocumented and cause silent failures</cite>.
- <cite index="11-1">Credits expire after 90 days and API access is gated to higher-tier plans</cite>. Build the cost ledger before you build anything fun, or you'll never answer the framework's break-even question.
- <cite index="12-2">Documentation is sparse; expect to reverse-engineer auth</cite>. Budget a day. Wrap every call in the driver so you only pay that cost once.
- Character consistency across shots is the hard part of any multi-shot AI video. Higgsfield's Soul character refs are the mechanism — model them explicitly (`characters` table, `character_ref_id` on shots), don't hope prompts hold identity.

---

## 4. The pipeline — eleven stages

Maps to the framework's Phase 5 workflow, made concrete. Each stage is a Trigger.dev task; each writes rows; each is independently replayable.

| # | Stage | Trigger | Input → Output | Human gate? |
|---|---|---|---|---|
| 1 | **Trend intake** | Cron, 4×/day | YouTube trending + Reddit + Google Trends → `trend_signals` | No |
| 2 | **Concept generation** | Cron / manual | `trend_signals` → `concepts`, each scored by Claude against a stored rubric (velocity, saturation, IP risk, evergreen tail) | **Yes** — approve/kill |
| 3 | **Script + shotlist** | On concept approve | `concepts` → `scripts` (hook 0–2s, 3–5 beats, CTA) + `shots[]` | **Yes** — edit; edits are logged as originality evidence |
| 4 | **Prompt compile** | On script approve | `shots` + `prompts` library → concrete driver params (model, motion, aspect, duration, seed, character_ref) | No |
| 5 | **Generate** | Fan-out, N shots | Driver submit → `generations` (status=queued) → webhook → `assets` | No — but auto-retry with prompt mutation on failure |
| 6 | **Voice + audio** | Parallel with 5 | Script → ElevenLabs → `assets(kind=audio)`; music bed selection | No |
| 7 | **Assemble** | Fan-in, all shots ready | Remotion composition + ffmpeg → `renders` per variant (9:16 1080×1920, 16:9 1920×1080) | No |
| 8 | **QA gate** | On render complete | Review UI: watch, flag, request reshoot of shot N only | **Yes** — hard gate |
| 9 | **Metadata** | On QA pass | Title/desc/tags/hashtags/thumbnail; uniqueness check vs last N videos | **Yes** — light |
| 10 | **Publish** | Manual (P1) → scheduled (P2) | YouTube Data API resumable upload / IG container→publish | **Yes** in P1 |
| 11 | **Measure** | Cron, 6h / 24h / 7d | Platform analytics → `metrics_snapshots` → hook scoring feedback into stage 2 | No |

The reshoot path in stage 8 is the feature that makes this worth building instead of using a SaaS. Regenerating shot 3 of 6 without touching the other five, then re-assembling, is where the time actually goes.

---

## 5. Platform publishing constraints

Build these into the scheduler as declarative limits, not as comments.

| Platform | Limit | Source note |
|---|---|---|
| YouTube | 10,000 quota units/day default; upload = 1,600 units | <cite index="24-1">≈6 uploads/day</cite>. Request an increase early; it takes weeks. |
| YouTube | Resumable upload protocol for the media itself | Not a simple POST. Runs on the worker, not Vercel. |
| Instagram | Business/Creator account + linked FB Page + reviewed app | <cite index="19-1">All access goes through the Graph API; Basic Display shut down 4 Dec 2024</cite>. Personal accounts have no publishing access at all. |
| Instagram | Scopes `instagram_business_basic`, `instagram_business_content_publish`; separate app review with screencast per scope | <cite index="23-1">2–4 weeks</cite> |
| Instagram | Container model: `POST /{ig-user-id}/media` → poll status → `POST /{ig-user-id}/media_publish` | <cite index="26-2">Reels need the extra polling step because video processing isn't instant</cite>. <cite index="23-2">If a container fails, generate a new one rather than retrying the same one.</cite> |
| Instagram | Posts per rolling 24h: sources disagree — 25 vs 100 | <cite index="26-3">One says a hard 25/24h with Reels and Stories in the same bucket</cite>; <cite index="23-2">another says 100</cite>. **Verify against Meta's own docs before relying on either.** Irrelevant at your volume; relevant if you scale to multiple channels. |
| Instagram | 200 API calls/hour per account | <cite index="24-1">Reduced from 5,000 in 2025</cite>. Pace your container polling. |
| Instagram | Reels via API: 90s max for most accounts | <cite index="20-1">Per the Reels API</cite>. Fits a shorts strategy fine. |
| All | Token expiry | <cite index="26-3">The most common cause of broken integrations after rate limits</cite>. Store refresh tokens, run a refresh cron, alert on failure. |

---

## 6. Cost telemetry — build it in phase 1

The framework wants cost-per-video, break-even, and an ROI calculator. You cannot retrofit this; you have to instrument every external call from the first one.

Every row in `generations` and `audio_jobs` carries `credits_spent`, `unit_cost_snapshot`, `currency`, `cost_inr`. A `v_video_cost` view rolls up per render. A dashboard card shows cost/video, cost/published-video (higher — includes killed drafts), and credits-burn-rate against the 90-day expiry clock.

Two derived numbers matter more than cost/video:
- **Yield**: published ÷ generated. If you generate 6 shots and reshoot 4, your real cost is 1.67×.
- **Cost per 1k views**, joined against `metrics_snapshots`. This is the only number that touches the business question.

---

## 7. Repo layout

```
kiln/
├── CLAUDE.md                      # read this first, Claude Code
├── docs/
│   ├── ARCHITECTURE.md            # this file
│   ├── SCHEMA.sql
│   ├── ROADMAP.md
│   └── decisions/                 # ADRs, one file per reversal
├── src/
│   ├── app/
│   │   ├── (dashboard)/           # pipeline board, cost, analytics
│   │   ├── concepts/[id]/         # script editor + shotlist
│   │   ├── review/[renderId]/     # QA gate — the most important screen
│   │   ├── prompts/               # prompt library
│   │   └── api/
│   │       ├── webhooks/higgsfield/
│   │       ├── webhooks/elevenlabs/
│   │       └── uploads/presign/
│   ├── lib/
│   │   ├── drivers/               # ← ALL vendor code lives here, nowhere else
│   │   │   ├── types.ts           # VideoDriver, AudioDriver, PublishDriver
│   │   │   ├── higgsfield.ts
│   │   │   ├── fal.ts             # stub — proves the interface
│   │   │   └── elevenlabs.ts
│   │   ├── publish/
│   │   │   ├── youtube.ts
│   │   │   └── instagram.ts
│   │   ├── db/                    # generated types + queries
│   │   └── cost/                  # ledger, rate tables
│   ├── trigger/                   # Trigger.dev tasks, one per pipeline stage
│   │   ├── 01-trends.ts … 11-measure.ts
│   └── remotion/                  # compositions, caption renderer, safe areas
└── supabase/migrations/
```

Rule with teeth: `grep -r "higgsfield" src/ --exclude-dir=drivers` returns nothing. Same for `elevenlabs`. Put it in CI.

---

## 8. Open decisions for you

1. **Trigger.dev vs Inngest + Fly worker.** I lean Trigger for the single-system property. If you've used Inngest before, that familiarity outweighs my reasoning.
2. **Remotion vs hosted (Creatomate/Shotstack).** Remotion = full control, more infra, licence check for commercial use. Hosted = ship in a week, ~$0.10–0.40/render, less control over captions.
3. **Niche.** GTA 6 first (high risk, high ceiling, expiring) vs a low-risk niche to de-risk the pipeline first. Architecture is indifferent; the channel strategy isn't.
4. **Repo name.** Kiln is a placeholder.
