# Bureau of Reality — Prompt Bundle v2.2 (06-Oct-2026)

Companion to *Bureau of Reality — Operating Plan v2.2*. Replaces the v1 (Kyona Labs) bundle entirely. Every prompt is labelled with its destination.

**v2.2 change:** voice, dubbing and sound effects run on the **Runway API** (ElevenLabs models, Runway preset voices), not ElevenLabs direct. Prompt A below is updated for any re-run; the build already running from the v2.1 text gets the change through **Prompt H**.

| ID | Destination | When | What it does |
|---|---|---|---|
| A | **Claude Code** — Kiln repo | Today, one long run | Retarget Kiln to Bureau of Reality, build the Kiln MCP server, workflows, router, QC, publishing, metrics, dubs, control room, calendar seed |
| B | **Claude chat** with the **Higgsfield** connector | Wed 07-Oct | Lock the cast: character sheets and reference frames, stop-and-ask before credits |
| C | **Claude Code Routine** — daily 06:00 IST | From 12-Oct | "Showrunner": drafts tomorrow-plus-two briefs through Kiln MCP |
| D | **Claude scheduled task** (Claude app; Kiln MCP + Slack) — daily 07:30 IST | From 12-Oct | "Morning desk": approval digest to Slack |
| E | **Claude Code Routine** — Mondays 06:30 IST | From 12-Oct | "Weekly review": gates, costs, sequels, dub queue, date checks |
| F | **Claude Code Routine** — alternate Thursdays 06:00 IST | From 15-Oct | "Long-form": plans the Sunday episode |
| G | **Claude Design** | From 12-Oct | Kiln Control Room v2 (approvals-first, phone-friendly) |
| H | **Claude Code** — Kiln repo | After Prompt A lands on `main` | Switch voice, dubs and SFX to the Runway API; forced alignment for word timings; preset audition script |

Before Prompt A: copy `kiln-topic-calendar.csv` into the Kiln repo at `data/kiln-topic-calendar.csv`.
After Prompt A deploys: add `https://video-pipeline-seven.vercel.app/api/mcp` to Claude as a custom connector, signed in with your **approver** token. Give Routines C, E, F and task D the **agent** token only.
Optional, exploration only: add the official Runway MCP (`https://mcp.runwayml.com/mcp`) to Claude chat as a custom connector. It spends your Runway **app** credits on images and video, has no voice tools, and is never used by the pipeline.

---

## A · Destination: Claude Code (Kiln repo) — retarget + Kiln MCP + full automation, Sprints 0–8

```
You are extending the existing Kiln repo (Next.js on Vercel, Supabase project "VidGen"). Kiln already has: settings + onboarding, Claude script and shotlist stages, asset ingest + ffmpeg normalisation, rough-cut, an internal MCP "Studio lane", a review screen, and a headless-Chromium composition renderer with captions/hook burn-in. Do NOT rebuild what exists. Start by reading CLAUDE.md, docs/ARCHITECTURE.md, docs/STATE.md, docs/HANDOVER-NEXT.md, docs/SCHEMA.sql and supabase/migrations (0001–0036), and print a short inventory before changing anything. Obey every rule in CLAUDE.md (vendor isolation to src/lib/drivers|publish|storage, identical Remotion versions, decision records in docs/decisions for any deviation). The plan, this prompt and the calendar are in docs/bureau/ and data/.

NEW TARGET: a fully AI-generated, faceless YouTube Shorts channel called "Bureau of Reality" — an original stickman workplace sitcom where recurring characters run the department that keeps physics, time, history and myth working; each Short explains one real mechanism. It has NO connection to Kyona Labs: remove all Kyona / 3D-printing / product / real-footage assumptions from channel-facing code, prompts, seeds and env.

GIT RULES (strict):
- Work only on `main`. Never create branches, worktrees or PRs.
- Author every commit as Sahil Mathew <sahil.matt@gmail.com>: git config user.name "Sahil Mathew" && git config user.email "sahil.matt@gmail.com".
- No "Co-Authored-By" trailers, no "Generated with Claude Code" footers, no session links, no AI attribution in commits or code comments. Set the attribution setting in .claude/settings.json to off and verify with `git log -1 --format=%B` after the first commit.
- Small conventional commits; typecheck + tests before each; push after each sprint.

Run Sprints 0–8 as one continuous batch. After each sprint print a checklist of what's done and anything blocked on me (keys, approvals), then continue with whatever is unblocked.

SPRINT 0 — Unblock + retarget
- Diff supabase/migrations vs the hosted VidGen schema; generate missing migrations; print the exact `supabase db push` command and any destructive SQL — do not run destructive SQL against hosted yourself. Use the Supabase MCP if it is connected.
- Move generic pipeline code to /core; channel config to /channels/bureau-of-reality/.
- Settings + env: HIGGSFIELD_API_KEY_ID/SECRET, GEMINI_API_KEY, FAL_KEY (failover), RUNWAY_API_KEY (required: voice, dubs, SFX, Act-Two), ELEVENLABS_API_KEY (optional, per-character upgrade only), YouTube OAuth, Meta/IG credentials, SLACK_WEBHOOK_URL, caps (per-Short ₹150, daily ₹600 with long-form jobs allowed up to ₹1500, monthly ₹15000 until Gate 2 then ₹25000), daily publish cap 1, FX 88, kill switch.

SPRINT 1 — Channel bible + data model
- /channels/bureau-of-reality/characters.json + characters.md: Pip (intern, cyan), Marlo (Gravity Desk veteran, amber, floating mug), Mrs. Iyer (Time & Calendars, magenta, reading glasses, filter-coffee tumbler), Nib (archivist, graphite, pencil body), Kaz (Myth Desk, lantern head), Director Ohm (never seen, brass desk lamp), Complaint Box (talking suggestion box), The Auditor (S2, red, clipboard). Fields: id, role, personality, speech rules, catchphrase limit (max 1×/week), accent hex, visual_lock, reference_frame_ids (placeholders), voice {provider: "runway", preset_id} (placeholder) plus optional elevenlabs_voice_id for the upgrade path, never-do list. World: white chalk lines + one accent colour on navy blueprint paper; adult office satire; never kid-coded.
- /channels/bureau-of-reality/series/*.json: incident (Mon), desk_tour (Tue), pip (Wed, serialised with season/episode), archive (Thu, history mysteries, no true crime), myth (Fri, comparative, interpretations labelled), deep (Sat, space/ocean), complaint (Sun, from real comments). Each: beat timings (0–2 s paradox cold open, 2–8 s stakes, 8–40 s three mechanism beats with Three.js overlay specs, 40–55 s one sourced fact, 55–60 s button gag + loop line), ≥3 structure variants, ending types, music-bed pool (no licensed music).
- Tables: slots (seeded from data/kiln-topic-calendar.csv: S### dated shorts, L## long-form, B## bank), briefs, scripts, shots, gen_jobs (provider, model, params, estimate_usd, actual_usd, status, request_id, retries), assets, cuts, publications, metric_snapshots, comments, dub_jobs, cost_ledger, authorship_log, fact_sources, variation_axes, strategy_memos, mcp_tokens (hashed, scope). pgvector for script/title embeddings. RLS on everything.

SPRINT 2 — Kiln MCP server (the control plane)
- Remote MCP server at /api/mcp (Streamable HTTP, official TypeScript MCP SDK), deployed with the app. OAuth if practical; otherwise bearer tokens from mcp_tokens. Two scopes: `approver` (Sahil) and `agent` (Routines, scheduled tasks). Enforce scopes server-side.
- Tools: calendar_upcoming(days), briefs_create_batch(briefs[]) [agent], brief_get(id), briefs_pending(), brief_approve(id, punchline, edits) [approver], brief_reject(id, reason) [approver], variation_check(brief), policy_lint(script), episode_status(id), shot_regenerate(episode, shot, note) [agent], cut_approve(id) / cut_reject(id, note) [approver], publish_bundles() / mark_scheduled(id, at) [approver], metrics_summary(range), top_performers(n), complaint_candidates(), dub_queue(add|list) [agent], costs_ledger(range), caps_set(...) [approver], kill_switch(on) [approver].
- Resources: kiln://bible/characters, kiln://series/{id}, kiln://policy/rubric, kiln://calendar/next-14.
- An agent token can never approve, publish, change caps or flip the kill switch. Every approve/reject writes authorship_log with the exact text and timestamp. Add tests for scope enforcement.
- Document how to add the server to Claude as a custom connector in README.

SPRINT 3 — Agents, checks, model routing
- Typed model router in one module. If a "Jev (TypeSafe)" multi-model orchestration module exists in my other repos or notes, follow its pattern; otherwise: Opus = judge + policy edge cases + weekly strategy; Sonnet = briefs, scripts, shotlists; Haiku = dedup, metadata, QC triage, comment mining. Log tokens and cost per call.
- Brief generator: premise + 3 punchlines + beat sheet in character voices (≤150 words), one fact with a primary-source URL, 3 titles across different hook archetypes, a pinned-comment question, ₹ estimate.
- variation_check: differs from each of the last 14 episodes on ≥4 of 7 axes (series, lead, desk, premise_type, structure_variant, ending_type, music_bed); embedding cosine vs last 60 < 0.85 (configurable); hook archetype ≤2/week; catchphrase ≤1/week.
- policy_lint: reject finance/health advice, politics/elections, real living people, franchises/brands, true crime, devotional framing, kid-coded styling; require exactly one sourced fact.

SPRINT 4 — Episode workflow + router (data plane)
- Episode pipeline as Trigger.dev v4 tasks (Kiln's existing orchestrator — do not introduce Vercel Workflows), started by brief_approve; use wait.forToken() for the two approval gates and vendor webhooks: script polish → shotlist (shot types: overlay, character_beat, acted_beat, money_shot) → cost estimate vs cap (if over, swap shots to overlay) → generation fan-out → QC → voices → assembly → wait for cut_approve (hook) → publish → metric pulls at 1h/24h/72h/7d.
- Routing: overlay → Kiln Three.js render (≥50% of runtime); character_beat → Higgsfield REST API Kling 3.0 Std image-to-video from locked reference frames (≤8 s per Short; failover fal Kling v3 standard); acted_beat → Runway Act-Two if key present; money_shot → Gemini Veo 3.1 Lite/Fast 720p 9:16 (max 1 per Short).
- Generation queue in Postgres with SKIP LOCKED and per-provider concurrency (higgsfield 10, gemini 5, runway 3, fal 5); Higgsfield webhooks, polling elsewhere; 429/THROTTLED backoff; idempotency keys. Production never uses any MCP connector for generation.

SPRINT 5 — Voice, QC, assembly, localisation-ready render
- Runway API text-to-speech (Eleven v3), one locked Runway preset per character (from characters.json). Runway returns no word timestamps: run forced alignment against the known script on the Trigger worker and emit the same word-timing shape the voice stage already uses, since shot durations derive from it. Keep an ElevenLabs-direct driver behind the same interface for any character moved off presets.
- QC: ffmpeg blackdetect/freezedetect, loudness −14 LUFS, 1–2 fps frame sampling → vision scoring (artifacts, garbled text, extra limbs), character similarity vs reference frame; reroll ≤2, then to review.
- Render a clean master (no burned text) plus caption/text layer renders per language; final renders on the existing Remotion (@remotion/renderer) Trigger.dev worker.

SPRINT 6 — Publishing + metrics
- YouTube: while `youtube_api_audited=false`, do not upload; produce a bundle (MP4 + title, description, tags, madeForKids=false, containsSyntheticMedia=false unless a realistic scene is present, slot time) on a "Ready to schedule" page and via publish_bundles(). When true, resumable videos.insert scheduled public at the slot.
- Instagram Graph API Reels: container → poll FINISHED → media_publish at slot; 5–90 s 9:16; respect publishing limits.
- Metrics: YouTube Analytics (views, engaged views, average view %, subs gained) + IG insights; Studio CSV import for viewed-vs-swiped if the API doesn't expose it; comment ingestion with character-name mention counts and Complaint Box candidates.

SPRINT 7 — Dubs + long-form
- dub_jobs: ElevenLabs Dubbing via the Runway API (or Runway TTS per character preset) for hi, es, pt-BR on queued Shorts; export per-language audio + caption renders for multi-language audio upload in Studio.
- Long-form builder: assemble an 8–12 min episode from aired Shorts plus NEW connective scenes (never raw re-stitching); one approval brief.

SPRINT 8 — Control room + notifications
- Pages: Approvals (mobile-first: premise, 3 punchlines, edit field, A/F/K shortcuts), Cuts (9:16 player, approve/reject/regenerate shot), Ready to schedule, Pipeline board, Generation monitor (queues, concurrency, failures, spend vs caps), Calendar (slots, seasonal tags, bank), Metrics (KPIs with gate lines: VVSA 70%, APV 70%, 1 sub/1k, ₹150/Short, name mentions), Costs, Authorship log. Follow any Claude Design export in /design.
- Slack webhook: briefs pending, cuts ready, cap at 80%, policy flag, QC failures after rerolls.

DEFINITION OF DONE: from Claude chat, using only the Kiln MCP connector, I can list pending briefs, approve one with a chosen punchline, watch it render, approve the cut, and get a publish bundle — with cost logged under the cap and scope enforcement tested. Then print every remaining action for me.
```

---

## B · Destination: Claude chat with the Higgsfield connector — lock the cast

```
Help me lock the recurring cast for an original stickman workplace sitcom, "Bureau of Reality". Use the Higgsfield connector, but STOP AND ASK before every generation: tell me the model, the number of images and the credit cost, and wait for my yes. Reuse earlier results wherever possible; never regenerate the whole set to fix one character.

Style for everyone: clean white chalk-line stick figures with ONE accent colour each, on deep navy blueprint paper with faint grid lines; adult office-satire tone, NOT a children's cartoon; no resemblance to any existing franchise, mascot or real person.

Cast: Pip (intern; cyan scarf line; oversized lanyard) · Marlo (400-year Gravity Desk veteran; amber line; floating coffee mug) · Mrs. Iyer (Head of Time & Calendars; magenta line; reading glasses; steel filter-coffee tumbler) · Nib (archivist; graphite-grey line; pencil-shaped body) · Kaz (Myth Desk liaison; lantern for a head whose glow changes colour) · Director Ohm (never seen: a humming brass desk lamp) · Complaint Box (talking wooden suggestion box) · The Auditor (red line; clipboard).

Steps:
1. First, without generating anything, write a character sheet for each: silhouette rules, head:body ratio, line weight, accent hex, 6 expressions, 4 signature poses, props, never-do list, and a Higgsfield prompt block (positive + negative). Negative should include: realistic human, photorealism, 3D plastic, anime, chibi, pastel kids style, text, watermark, logos, existing cartoon characters, extra limbs, inconsistent accessories.
2. Recommend the cheapest Higgsfield image model that holds clean line art, with its credit cost per image.
3. After my yes: generate 4 variants for Pip, Marlo and Mrs. Iyer only. I pick one each.
4. After my yes: generate 8 test poses per picked character from that reference to prove consistency. Then the remaining five characters, 2 variants each.
5. Give me a table of the locked reference image IDs/URLs per character and the exact prompt blocks, formatted to paste into characters.json in the Kiln repo.
```

---

## C · Destination: Claude Code Routine (cloud, Kiln repo) — daily 06:00 IST — "Showrunner"

```
You are the showrunner for "Bureau of Reality". Use ONLY the Kiln MCP tools (agent token). Never approve, publish, change caps or invent analytics.
1. calendar_upcoming(4): find the slot for today+3 (and any empty slot within 3 days). Read kiln://bible/characters, kiln://series/{series} and kiln://policy/rubric.
2. metrics_summary("7d") and top_performers(5): note what's working (hook archetype, length, lead character) and use it.
3. For each slot, draft a brief: series, lead + supporting characters, season/episode if Pip's First Year, a premise in one line, 3 alternative punchlines, a beat sheet per the series template, a script in character voices (≤150 words), a shot list (≥50% overlays; ≤8 s character beats; at most one money shot), exactly one fact with a primary-source URL (.gov/.edu/NASA/NOAA/museum/peer-reviewed), 3 titles using different hook archetypes, a pinned-comment question, and a ₹ estimate (target ≤125).
4. Run variation_check and policy_lint. On failure, rewrite up to twice; if it still fails, submit with flag=true and the failing axes.
5. Sunday slots: build from complaint_candidates(); credit the viewer by handle only if the comment is public.
6. briefs_create_batch(...). Print a 6-line summary: slots covered, flags, estimated spend.
```

---

## D · Destination: Claude scheduled task (Claude app; Kiln MCP + Slack connectors) — daily 07:30 IST — "Morning desk"

```
Using the Kiln MCP connector, call briefs_pending() and metrics_summary("1d"). Post one Slack DM to me:
- yesterday's Short: views, viewed-vs-swiped and APV if available, subs gained, top comment mentioning a character;
- each pending brief as: slot date · series · premise · punchlines A/B/C · ₹ estimate · any flags;
- spend this month vs the cap.
End with: "Reply in Claude: approve <n> <A|B|C|your line>, or reject <n> <reason>." Do not approve anything yourself.
```

---

## E · Destination: Claude Code Routine (cloud, Kiln repo) — Mondays 06:30 IST — "Weekly review"

```
Kiln MCP tools only (agent token).
1. metrics_summary("7d") and ("28d"): viewed-vs-swiped median (last 20), APV median, subs per 1k views, character-name mentions per 1k views, cost per Short, spend vs cap, any policy or QC flags.
2. Compare with gates: VVSA ≥70%, APV ≥70%, ≥1 sub/1k, ≤₹150/Short, 0 policy warnings. Say pass/fail per gate and what to change. If a gate fails two weeks running, recommend dropping to 1/day and say so first in the memo (you cannot change caps).
3. From 18-Nov onward: dub_queue(add) the top 20% of Shorts by APV for hi, es, pt-BR. From 18-Dec: if all gates pass, recommend enabling 2/day on Tue/Thu/Sat from the bank.
4. Pick up to 2 sequels to top performers into bank slots (as briefs via briefs_create_batch, flagged "sequel").
5. Re-verify dates for seasonal slots 14–45 days ahead (Diwali 8-Nov-2026, Sankranti 14-Jan, Lunar New Year 6-Feb, Holi 22-Mar 2027 etc.) against two sources; report conflicts.
6. Progress toward 500 subs + 3M Shorts views/90d, and the 10M/90d floor from 1-Feb-2027.
7. Write a strategy memo (≤300 words) and print it. No commits unless a file in the repo must change; if so, commit on main as Sahil Mathew <sahil.matt@gmail.com> with no co-author or AI-attribution lines.
```

---

## F · Destination: Claude Code Routine (cloud, Kiln repo) — alternate Thursdays 06:00 IST — "Long-form"

```
Kiln MCP tools only (agent token). Find the next long-form slot (L##) within 4 days via calendar_upcoming(4). Build an 8–12 minute episode plan around its title: which aired Shorts to include (by slot ID), the NEW connective scenes needed between them (premise, characters, ≤90 s total generated character beats, overlays preferred), a cold open, a mid-episode Complaint Box moment, and an ending that sets up the next fortnight. Never re-stitch Shorts without new framing. Estimate ₹ (target ≤1,500). Submit as one brief via briefs_create_batch with series="long_form" and print the outline.
```

---

## G · Destination: Claude Design — Kiln Control Room v2

```
Design "Kiln Control Room" for a solo creator running a fully generative YouTube Shorts sitcom ("Bureau of Reality") through an automated pipeline. Two jobs matter most and must be fastest on a phone: approving premises/punchlines and approving finished cuts. Aesthetic: calm studio tool, dark-first with light mode; deep navy + chalk-white accents echoing the show's blueprint world; monospaced tabular numerals; colour only for status.
Screens:
1) Approvals (mobile-first) — card per brief: slot date, series chip, lead character avatar, premise, punchlines A/B/C as large tap targets plus "write my own", fact + source, ₹ estimate, check results (variation axes, policy); approve/reject; keyboard A/B/C/R on desktop.
2) Cuts — 9:16 player, shot strip with per-shot regenerate, QC scores, approve/reject.
3) Ready to schedule — bundles with copy buttons for title/description/tags and the slot time; "mark scheduled".
4) Pipeline board — columns: Draft, Needs approval, Rendering, QC, Needs cut review, Ready, Scheduled, Live.
5) Calendar — month grid of slots with series colour, seasonal tags, bank count, produce-by warnings.
6) Metrics — KPI tiles with gate lines (viewed-vs-swiped 70%, APV 70%, subs/1k 1.0, ₹150/Short), character-name mentions trend, top performers.
7) Generation monitor + costs — per-provider queues and concurrency, failures, spend vs daily/monthly caps; kill switch with confirmation.
8) Cast — the eight characters with reference frames, voice sample, accent colour, never-do list.
Include empty, loading, error, cap-reached and kill-switch-on states.
```

---

## H · Destination: Claude Code (Kiln repo, `main`) — voice, dubs and SFX on the Runway API

Run this after the Sprints 0–8 build has finished and pushed to `main`. Do not run it while that build is still committing.

```
Switch Kiln's voice, dubbing and sound-effect stages from ElevenLabs direct to the Runway API. Decision made by Sahil on 06-Oct-2026: one vendor and one credit pool for voice, dubs and Act-Two; no ElevenLabs subscription.

GIT RULES: work only on main; author every commit as Sahil Mathew <sahil.matt@gmail.com>; no Co-Authored-By trailers, generated-with footers, session links or AI attribution anywhere. Small conventional commits; pnpm check before each; push when done.

READ FIRST: CLAUDE.md, docs/decisions/0008-what-is-unverified.md, the voice stage (06-voice and everything it calls), dub_jobs, the voice driver interface, env schema and .env.example, channels/bureau-of-reality/characters.json. Print a short inventory of what the build actually produced for voice before changing anything. CLAUDE.md wins wherever it conflicts with this prompt.

FACTS TO DESIGN AROUND (verify each against Runway's API docs; record anything that differs):
- Runway API audio: text_to_speech (models eleven_multilingual_v2, eleven_v3, eleven_v4), speech_to_speech, voice_dubbing (29 languages), sound effects, voice isolation.
- Text-to-speech uses Runway PRESET voices only. Runway's custom voices (voice design / cloning) attach to avatars, not to text_to_speech.
- No word timestamps are documented in the response.
- Pricing: eleven_v3 and eleven_multilingual_v2 at 1 credit per 50 characters; eleven_v4 at 2.2 credits per 1,000 characters only until 12-Oct-2026; $0.01 per credit. No public dubbing rate.
- Runway app credits and API credits are separate pools.

BUILD:
1. Decision record docs/decisions/00NN-voice-on-runway.md: why; trade-offs (presets only, no timestamps, unpublished dubbing rate, one more dependency on one vendor); the per-character upgrade path to ElevenLabs direct; and whether Runway offers task webhooks. CLAUDE.md rule 4 says webhooks over polling — if Runway has none, poll with backoff inside the Trigger task and record the exception here.
2. Runway voice driver in src/lib/drivers/ implementing the existing voice driver interface: text_to_speech with eleven_v3 by default, preset id per character. Zod-validate every response. Idempotency key per line. Pass every option whose default is the behaviour you are avoiding explicitly (CLAUDE.md).
3. characters.json: voice = {provider: "runway", preset_id: null} for all eight until the audition locks them; elevenlabs_voice_id optional. A character with provider "elevenlabs" routes to the ElevenLabs-direct driver — keep that driver working, and share one routing predicate.
4. Word timings: forced alignment of the generated audio against the known script on the Trigger worker (pick a CPU aligner that installs on the worker image; read what any extension actually installs before adding it). Emit the exact word-timing shape the voice stage already produces. Assert aligned word count === script word count. If alignment fails or confidence is low, the timings are null, not 0, and derived_from_vo must not be set — stage 5 must keep refusing that script, and v_pipeline_blockers must name the reason.
5. Cost: cost_ledger row at submit time — credits = ceil(characters / 50) for v3/v2 from a rate table row, not a constant. cost_source marks it an estimate until a measured balance change exists; never write a reconcile you did not measure.
6. Dubbing: dub_jobs → Runway voice_dubbing for hi, es, pt-BR; ledger row at submit; the rate is unknown, so record the estimate source honestly and surface "rate unverified" wherever dub cost is shown.
7. Sound effects: optional SFX path for button gags, same ledger rules.
8. Env: RUNWAY_API_KEY required for the voice stage; ELEVENLABS_API_KEY optional. Update the env schema, .env.example and docs. Grep every harness for ELEVENLABS and for `??=` scaffolding that would restore a removed requirement.
9. Vendor isolation: "runway" and "eleven" appear only under src/lib/drivers/ (and publish/storage where already allowed). pnpm check:vendors must pass.
10. `pnpm voice:audition`: lists Runway's preset voices and renders the same two lines for each character brief (Pip, Marlo, Mrs. Iyer, Nib, Kaz, Director Ohm, Complaint Box, The Auditor) into storage, with a cost row per render and a hard spend limit flag. It writes nothing to characters.json — Sahil picks, then a second command locks the chosen preset ids.
11. Harness verify:voice: drive the real driver once with one short line; assert the ledger row, the aligned word count, and that stage 5 then accepts the script — and that it refuses when alignment is null. Assert outputs the code produced, not rows the harness seeded.
12. Update docs/decisions/0008-what-is-unverified.md with what ran for real and what did not.

FINISH: push to main, read the CI step list for the commit (not the log tail), and print: (a) Vercel and Trigger.dev environment variable changes — names, environments, where each value comes from; (b) the command for Sahil to run the audition; (c) what is still unverified.
```
