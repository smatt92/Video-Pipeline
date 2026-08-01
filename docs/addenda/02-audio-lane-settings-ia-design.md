# Addendum 02 — Audio lane, full settings IA, design system

> Transcribed into the repo from the working session. Extends ARCHITECTURE.md and
> Addendum 01. Read after both.

Scope added: ElevenLabs voiceover, settings as the control surface for the *whole*
pipeline, and a design direction that isn't a template.

---

## 1. The finding that reorders the pipeline: audio-first timing

ElevenLabs' `with-timestamps` endpoint returns character-level start/end times in seconds,
plus a `normalized_alignment` block mapping to what was *actually spoken* (`"$5"` →
`"five dollars"`). Group characters between spaces and you have word-level timings in one
pass.

This is not just a captions feature. It inverts stage ordering.

**Current spec (wrong):** script assigns `shots.duration_s` → generate video → generate VO
→ hope they fit.

**Corrected:** script → **VO first** → word timings define beat boundaries → beat
boundaries set `shots.duration_s` → generate video to fit.

| | Video-first (spec as written) | Audio-first (corrected) |
|---|---|---|
| Sync | VO is stretched, padded, or clipped to fit clips | Clips are generated to fit real speech |
| Cost of a bad estimate | Regenerate video shots (~₹50–200/shot) | Regenerate VO (~₹8/minute) |
| Captions | Post-hoc alignment pass, drifts | Free, exact, from the same response |
| Hook timing | "roughly 2 seconds" | You know the hook ends at 1.84s |

VO is roughly a hundredth the cost of video generation. Always let the cheap artifact
define the timeline that the expensive artifact must satisfy.

**Consequence:** stage 6 (voice) moves ahead of stage 5 (generate) in the DAG.
`shots.duration_s` becomes derived, not authored — add `shots.duration_source`
(`'authored' | 'derived_from_vo'`) so you can tell which shots were planned versus fitted.

### Word timings storage

Implemented as `vo_takes` in migration 0004. Use `normalized_alignment`, not `alignment`:
burned-in captions must show what was said, not what was typed.

---

## 2. AudioDriver — a genuinely different shape from VideoDriver

Useful pressure on the interface. The two vendors behave nothing alike:

| | Higgsfield (VideoDriver) | ElevenLabs (AudioDriver) |
|---|---|---|
| Execution | Async job, submit → webhook | **Synchronous** (or HTTP/WS stream) |
| Completion signal | Webhook + status poll | The response body |
| Cancel | Not supported | Irrelevant |
| Throttle unit | Rate limits (undocumented) | **Concurrency**, hard per tier |
| Long inputs | N/A | Chunking required |
| Failure | Retry the job | Retry the call |

Do **not** force these into one interface. Two interfaces, both returning a common
`GenerationResult`. The shared abstraction is the *result and cost shape*, not the
execution model.

### The concurrency wall

ElevenLabs caps **parallel requests**, not requests per minute: Free 2, Starter 3,
Creator 5, Pro 10, Scale 15, Business 15. On a 429:

- `too_many_concurrent_requests` → **queue**, do not retry-storm
- `system_busy` → exponential backoff with jitter, 1s → 32s cap

Store the tier in the ElevenLabs integration record and have the Trigger.dev task read its
concurrency limit from the DB. A hardcoded `concurrency: 10` on a Creator plan produces a
permanent 20% failure rate that looks like a flaky vendor.

### Model selection policy (settings, not code)

| Format | Model | Reason |
|---|---|---|
| Long-form narration 16:9 | `eleven_multilingual_v2` | Most consistent across chunks; 10k char limit |
| Shorts/Reels hooks | `eleven_v3` | Expressive, audio tags (`[excited]`, `[whispers]`); 5k char cap |
| Bulk / cost-sensitive | `eleven_flash_v2_5` | Half price, but text normalization off by default — bad for numbers, dates, currency |
| Telugu | `eleven_v3` **only** | Not in the v2/Flash language lists. Hindi is on all models. |

Chunk long scripts to 200–500 words and stitch with
`previous_request_ids`/`next_request_ids`. Language and accent drift on long single
generations is a documented, repeatable failure — don't feed a 10-minute script in one
call.

### Pronunciation dictionaries are not optional for this niche

Indian place names, brand names, gaming acronyms, and "GTA" itself will be mispronounced.
Phoneme tags only work on `eleven_v3` and `eleven_flash_v2`; other models silently ignore
them, so use alias substitutions there. CMU phonemes are more predictable than IPA. Max 3
dictionary locators per request. This belongs in settings as an editable table, because
you will add entries weekly.

### Cost reality check

A ~150-word (60s) VO costs roughly **$0.09** on Multilingual v2, **$0.045** on Flash.
Against Higgsfield video generation this is noise. The dashboard should therefore **not**
show audio and video cost in the same visual weight — a stacked bar where one segment is
1% tall teaches nothing. Show video cost as the headline, audio and LLM tokens as a
secondary line.

Commercial use requires a paid plan; free tier requires attribution and forbids
monetization. **Creator ($22/mo)** is the correct starting tier: Professional Voice
Cloning, 220k Multilingual chars, 5 concurrency.

### Multilingual: generate, don't dub

For Hindi/Telugu variants, translate the script and generate native VO with your cloned
host voice rather than using the Dubbing API. You get word timings for free (dubbing gives
none), avoid the Dubbing v2 API gap, and keep QA control. Reserve dubbing for cases where
you must match existing on-screen lip movement — which, for AI-generated B-roll, you
don't have.

---

## 3. Phase 0 addition: record the host voice

Professional Voice Cloning needs 30 minutes minimum, ideally 2–3 hours, of clean
single-speaker audio, plus consent verification, on Creator tier. Instant Voice Cloning
works from 1–5 minutes but is noticeably less consistent when delivery diverges from the
reference — which is exactly what happens across hundreds of videos.

This is a wall-clock item like the Meta app review. Book a recording session now; PVC
training and verification take days, not minutes.

---

## 4. Settings IA — the whole pipeline, one surface

Nine sections. The principle: **anything that would otherwise become a magic number in
code lives here.**

| Section | Contents | Notes |
|---|---|---|
| **Workspace** | Name, timezone (IST), default channel, currency + USD→INR rate | The FX rate is a setting, not a constant |
| **Integrations** | Anthropic, Higgsfield, ElevenLabs, R2, MCP servers, YouTube, Instagram | Vault-backed, write-only, per-integration Test connection |
| **Voice** | Host voice per channel, model per format, language variants, pronunciation dictionary editor, normalization mode, chunk size | The dictionary editor is a real CRUD table, used weekly |
| **Generation** | Model per shot type, aspect/duration defaults, seed policy, retry policy, prompt library defaults | Reads credit balance + **expiry countdown** |
| **Assembly** | Caption style presets, safe-area overlays per platform, canonical intermediate codec, music bed library, loudness target | Caption style is where the channel's visual identity lives |
| **Rate card** | Per driver, per endpoint, per unit, `is_verified` | Unverified rate ⇒ no rupee figure displayed, and submit refuses |
| **Guardrails** | Spend caps (session / day / month), concurrency per vendor, circuit-breaker thresholds, max shots per video | The Studio lane can burn tokens fast |
| **Publishing** | Schedule windows, per-platform rate limits, disclosure flags, metadata templates | Greyed out until Phase 3 |
| **Danger zone** | Rotate all keys, purge R2 orphans, reset rate card | |

Two hard rules stay: secrets never reach the browser (Server Actions, `last_4` only,
write-only fields), and the page is gated to a single allowlisted email — not merely
"authenticated."

---

## 5. Design direction

### The stack decision that matters

**shadcn/ui on the Base UI backend, not Radix.** Base UI hit stable v1.0.0 in December
2025, built by the MUI/Radix team, and shadcn defaults to it for new projects as of July
2026. Radix development slowed after the WorkOS acquisition — Combobox and multi-select
issues lag. Base UI also ships built-in RTL and a CSP provider. React Aria (`--base aria`)
is the stronger accessibility choice if you'd rather trade ecosystem for correctness;
given a keyboard-driven review workflow, it's a defensible pick.

### Escaping the "default shadcn" tell

The recognisable signature is three things stacked: default Inter, default `zinc`/`slate`
tokens, default radii. Break all three:

1. **OKLCH token ramps, not Tailwind defaults.** Tailwind v4 ships OKLCH natively.
   Perceptually uniform lightness means equal steps *look* equal and contrast stays
   predictable across hues — which matters when your accent sits next to arbitrary video
   thumbnails.
2. **Three-layer tokens:** primitives (raw OKLCH ramps) → semantic (`--surface-1`,
   `--border-subtle`, `--accent`, `--danger`, `--generating`) → component. Nothing in a
   component file references a primitive directly. This is what makes an accent swap a
   one-line change instead of a refactor.
3. **Typography.** Inter now reads as "didn't think about it." Geist + Geist Mono is the
   technical-tool register; Satoshi is warmer for marketing surfaces. Mono options beyond
   Geist Mono: Martian Mono for maximum character disambiguation, Commit Mono, JetBrains
   Mono as the safe default.
4. **Custom radii and spacing scale.** Two minutes of work, removes most of the remaining
   tell.

Never mix a styled library (HeroUI, Flowbite) into a shadcn app. The seam is instantly
visible.

### Dark-first, one accent

Roughly three-quarters of design-led tools are dark-default with a single restrained
accent — Linear purple, Raycast red, Cursor cyan, Mercury lime. The discipline is the
*single* accent used sparingly, not the darkness itself. For Kiln it's doubly right: video
previews read better against dark chrome, and status colour carries semantic weight
precisely because nothing else competes.

### Patterns worth stealing, by name

- **State-at-a-glance (Vercel).** One glyph tells you generating / needs review / blocked
  / live; detail waits a layer down.
- **Command-first navigation (Linear, Raycast, Cursor).** A palette on `⌘K`. Hint the
  shortcut in the empty state or nobody finds it.
- **AI-native, not AI-added (Attio, Hex).** The Studio lane's output is a first-class
  surface, not a chat widget floating over the old UI.
- **Calm density (Linear).** Answer "is everything okay?" first; drill down on demand.
- **Sidebar 240–280px + CSS Grid card canvas.** Avoid top tabs past ~10 sections.

### Generation-queue UX — the failure modes are known

- Show queue **position and ETA**, and say *why* something is pending ("waiting its
  turn"), or users read it as broken.
- In-progress must show the actual current step, not a spinner. "Generating shot 3 of 6"
  beats any animation.
- **Never overwrite on regenerate.** Variants extend the workspace; they don't destroy
  prior work. Each variant carries its generation params as visible metadata.
- Surface predicted *and* actual cost per job.

### Review screen composition

| Element | Library | Why |
|---|---|---|
| Preview canvas | **Remotion Player** (`@remotion/player`) | Renders the exact composition you'll export — frame-accurate WYSIWYG |
| VO waveform + caption regions | **wavesurfer.js** | Regions map cleanly onto word timings |
| Finished-render playback | **Vidstack** | Headless, a11y-first, HLS/DASH, ships a Remotion provider |
| Shot strip | custom | Thumbnail per shot, per-clip regenerate, drag to reorder, in/out handles |

The targeted-edit pattern from Claude Artifacts and ChatGPT Canvas is the one to copy:
highlight a region, regenerate only that. In Kiln that's one shot or one VO line — never
the whole video.

### Accessibility

- Honour `prefers-reduced-motion` via a CSS duration variable set to `0.01ms` rather than
  `0` — keep it non-zero so `transitionend` still fires and state machines don't hang.
  Listen for live changes with `matchMedia().addEventListener('change')`.
- Ship a real WebVTT track on the review player in addition to burned-in captions, so
  caption timing can be verified independently of the render.
- Full keyboard control of the review loop: approve, reject, regenerate shot, scrub, mark
  in/out. A mouse-only review screen quietly kills the workflow.
- Base UI / React Aria give correct focus management and ARIA roles at the primitive
  level.

---

## 6. Deployment notes now that Vercel is connected

- **Trigger.dev does not deploy to Vercel.** `npx trigger.dev@latest deploy` is its own
  pipeline. Two deploy targets, two sets of env vars, and they must agree on the Supabase
  and R2 config.
- **Webhook URLs must be stable.** Preview deployments get a new URL per commit, so a
  webhook registered against a preview URL dies on the next push. Point webhooks at the
  production domain, and use a tunnel for local development. Store the callback base URL
  as a setting, not as `VERCEL_URL`.
- **R2 CORS** must allow presigned `PUT` from both the production origin and preview
  origins, or uploads silently fail only in preview.
- Set `VERCEL_SUPPORT_LARGE_FUNCTIONS=0`. If you exceed the standard bundle, something has
  leaked into the control plane that shouldn't be there.
- Vercel env vars carry only bootstrap config now. Every vendor credential lives in Vault.

---

## 7. Revised phase order

Supersedes Addendum 01 §6.

- **1a — Settings + integrations.** Vault, integrations/mcp_servers tables, settings shell
  with Integrations + Rate card + Guardrails live. Ships first because drivers construct
  from it.
- **1b — Drivers.** `VideoDriver` and `AudioDriver` as two interfaces, `higgsfield.ts`,
  `elevenlabs.ts`, `fal.ts` stub. The two execution models stress-test the abstraction.
- **1c — Audio-first pipeline leg.** VO → word timings → derived shot durations → fan-out
  video generate → webhook → shot grid with cost.
- **1d — Studio lane.** Own MCP server over both drivers, Opus 5 chat, session → script
  materialisation.
- **1.5 — Review + rough cut.** Remotion Player, wavesurfer, shot strip, per-shot
  regenerate, ffmpeg concat.
- **2 onward** — unchanged: full Remotion assembly with captions from `word_timings`, then
  publish, then analytics.

Design system (tokens, type, Base UI, command palette shell) lands inside 1a, not as a
later polish pass. Retrofitting a token layer over forty components is a week you won't
want to spend.
