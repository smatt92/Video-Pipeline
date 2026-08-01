# Addendum 01 — Studio lane, settings/integrations, schema deltas

> Transcribed into the repo from the working session. Supersedes nothing in
> ARCHITECTURE.md; extends §3 and §4. Read after it.

Scope change requested: an Opus 5 conversational lane that drives Higgsfield via MCP, a
review + stitch surface, and a settings page that makes the platform the dashboard
workspace for the whole pipeline.

---

## 1. Two lanes, one data model

The earlier advice — "MCP is not for production" — stands, but it was answering the wrong
question. It's not MCP-vs-REST. It's **agentic vs deterministic**, and you now want both.
They're different products sharing a database.

| | **Studio lane** (new) | **Pipeline lane** (Phase 1 as built) |
|---|---|---|
| Entry | You type a brief into a chat surface | Cron / batch / approved concept |
| Brain | Opus 5 via Messages API, MCP tools attached | No LLM in the hot path; params pre-compiled |
| Tool call | `mcp_servers` connector | `VideoDriver.submit()` |
| Unit of work | A session, many turns, unbounded shape | A job, one shape, retryable |
| Failure | You see it and retype | Backoff, circuit breaker, dead-letter row |
| Cost attribution | Per session (tokens + credits) | Per generation, idempotent |
| Good at | Discovering what to make | Making the same thing 200 times |

**The rule that keeps this from becoming two codebases:** the Studio lane does not get its
own tables. A Studio session materialises a `scripts` row on first generation
(`drafted_by='studio-agent'`, `human_edit_count` incremented per user turn that changes
direction). Everything downstream — `shots`, `generations`, `assets`, `renders`,
`reviews` — is identical. Review, stitch, cost, and the originality evidence trail work on
Studio output with zero special-casing.

This also preserves the §0.2 compliance posture. A conversational lane is *more*
defensible than a batch one — the turn history is literal proof of human editorial
judgment. Store the transcript.

---

## 2. Wiring Opus 5 to Higgsfield MCP

The MCP connector lets the Messages API connect to remote MCP servers without a separate
MCP client. Current shape — note that the header in most blog posts is out of date:

```ts
const res = await anthropic.beta.messages.create({
  model: "claude-opus-5",
  max_tokens: 4096,
  messages,
  mcp_servers: [{
    type: "url",
    url: "https://mcp.higgsfield.ai/mcp",
    name: "higgsfield",
    authorization_token: token,        // you must have acquired this yourself
  }],
  tools: [{ type: "mcp_toolset", mcp_server_name: "higgsfield" }],
  betas: ["mcp-client-2025-11-20"],
});
```

The `mcp-client-2025-04-04` header is deprecated; the current one is
`mcp-client-2025-11-20`, and tool configuration moved out of the server definition into
the `tools` array as `MCPToolset` objects, which adds allowlisting, denylisting, and
per-tool config.

### Four constraints that will bite

1. **The connector does not run OAuth for you.** It accepts an `authorization_token` the
   caller pre-acquired through OAuth; the connector does not perform the flow itself.
   Higgsfield's hosted MCP is OAuth-gated. So Kiln has to be an OAuth client — discovery,
   DCR, callback, token store, refresh cron — before a single MCP tool call happens. That
   is a day of work and a permanent moving part.
2. **Only tools.** The connector calls `tools/list` and `tools/call` only; resources,
   prompts, and sampling are not exposed even if the server implements them. Higgsfield
   exposes its model catalogue as an MCP *resource* — you won't see it through the
   connector. Mirror the catalogue in your own DB.
3. **No local servers.** The server must be publicly reachable over HTTP (Streamable HTTP
   or SSE); local STDIO servers can't be connected. Rules out self-hosted community
   wrappers unless you deploy one.
4. **Generations made through MCP land in Higgsfield's account, not in your tables.** The
   agent gets a URL back; nothing wrote a `generations` row, a `cost_ledger` row, or an
   idempotency key. Your review screen can't see it, your cost dashboard is blind to it.

### The move to make instead: your own MCP server, wrapping your own driver

Point Opus 5 at `https://kiln.yourdomain/api/mcp` instead of at Higgsfield. Tools:
`generate_shot`, `check_generation`, `list_prompt_recipes`, `save_prompt_recipe`,
`stitch_rough_cut`, `list_session_shots`. Each one is a thin call into the `VideoDriver`
already built.

| | Higgsfield MCP direct | Own MCP over own driver |
|---|---|---|
| Time to first agent call | ~1 day (OAuth) | ~1 day (MCP server + auth) |
| Rows written | none | every one |
| Cost ledger | blind | complete |
| Idempotency / retries | vendor's | yours |
| Review + stitch integration | manual import step | free |
| Driver swap to fal.ai later | rewrite the lane | change one env var |
| Auth | OAuth 2.1 + DCR + refresh | static bearer you mint |

Same effort, strictly more capability. **Recommendation: skip Higgsfield MCP in the
product entirely.** Keep using it in Claude Code for exploration — that's what it's
genuinely best at — and have the platform expose its own.

If you want Higgsfield MCP in the product anyway (fair — you may want the agent reaching
tools you haven't wrapped yet), attach both servers in the same request and mark rows from
the Higgsfield one as `origin='studio_unmanaged'` with `cost_inr = null`. Just know that
anything generated that way is invisible to the numbers the research framework asks for.

---

## 3. Review + stitch

"Stitch if required" is Phase 2's assembly stage arriving early, and that's correct — an
unstitched pile of 5-second clips isn't reviewable as a video. But keep the split sharp:

| | **Rough cut** (Phase 1.5, build now) | **Final render** (Phase 2, unchanged) |
|---|---|---|
| Tool | ffmpeg concat + trim, in Trigger | Remotion composition → ffmpeg |
| Has | ordered shots, cuts, optional scratch VO | captions, hook text, safe areas, music, variants |
| Purpose | "does this hang together?" | publishable artifact |
| Time | seconds | minutes |
| Row | `renders` with `kind='rough_cut'` | `renders` with `kind='final'` |

Rough cut needs: reorder shots, set per-shot in/out, drop a shot, regenerate shot N in
place, re-stitch. That's the whole review screen and it's the highest-value surface in the
product. Everything else is CRUD.

One trap: ffmpeg `concat` demuxer requires identical codec/resolution/framerate across
inputs, and Higgsfield output params vary by model. Normalise every asset to a canonical
intermediate on ingest (`h264 yuv420p 1080x1920 30fps`) rather than at stitch time, or
you'll debug this at 1am.

---

## 4. Settings / integrations — and the change it forces

Right now credentials come from env vars. A settings page means they come from the
database at runtime. That is not a UI change; it changes the driver constructor signature,
so it must land **before** the driver interface is finalised.

```
Driver: constructed per-call from an Integration record, not from module-level env.
  ❌ new HiggsfieldDriver()                    // reads process.env at import
  ✅ createDriver(await getIntegration('higgsfield'))
```

Env keeps exactly two jobs: bootstrap (`SUPABASE_URL`, service role, Vault key) and CI.
Every vendor credential moves to Vault.

### Design

| Concern | Decision |
|---|---|
| Storage | Supabase Vault. `integrations` holds config + a `vault_secret_id`; the secret value is never a column. |
| Exposure | Secrets never reach the browser. Server Actions only. Read paths return `last_4` and `configured_at`, nothing else. |
| Editing | Write-only fields. You can replace a key; you can never read one back. |
| Verification | Every integration has a `Test connection` action that makes the cheapest real call the vendor offers and writes `last_verified_at` + `last_error`. An unverified integration cannot be selected by a pipeline task. |
| Auth | Single-user: Supabase Auth with a hardcoded allowed email. This page is the highest-value target in the app; do not put it behind "logged in" alone. |
| Audit | `integration_events` — created / rotated / verified / failed, with timestamps. Cheap now, essential when a key leaks. |

### Sections on the page

1. **Anthropic** — API key, default model (`claude-opus-5`), max tokens, spend cap per
   session. The spend cap is not optional; an agent loop with tool access can burn a lot
   of tokens on a bad turn.
2. **Higgsfield** — API key + secret, webhook secret (≥32 chars), base URL, and a live
   **credit balance + expiry countdown**. Credits expire ~90 days; that clock belongs on
   screen, not in a doc.
3. **MCP servers** — a list, not a single field. Each row: name, URL, auth mode
   (bearer / OAuth), enabled tools allowlist, connection status. Your own server is row
   one and ships enabled.
4. **Rate card** — per driver, per endpoint, per unit, with `is_verified`. Claude Code's
   refusal to invent Higgsfield prices was right; this page is where you fix it.
   **Nothing displays a rupee figure sourced from an unverified rate.**
5. **Storage** — R2 credentials, bucket, public base URL, plus a "write and read back a
   test object" check.
6. **Channels** — YouTube / Instagram OAuth, token expiry, quota remaining. Greyed out
   until Phase 3.

---

## 5. Schema deltas

Implemented as `supabase/migrations/0003_studio_lane_and_integrations.sql`, with six
corrections recorded in `docs/decisions/0006-addendum-01-sql-corrections.md`.

- `studio_sessions` — session log with full `transcript` as editorial evidence, token
  counts, `spend_cap_inr`, status `active|archived|capped`.
- `generations` gains `origin` (`pipeline|studio|studio_unmanaged`), `studio_session_id`,
  and `parent_generation_id` — because soul(text→image) → dop(image→video) is a chain,
  not one call.
- `renders` gains `kind` (`rough_cut|final`) and `origin`.
- `integrations`, `mcp_servers`, `integration_events`.
- `rate_card` gains `endpoint`, `is_verified`, `source_note`.

### And the `v_render_cost` bug

The original view joined renders→shots→generations on `script_id`, so every variant render
of one script reported the full script cost and summing double-counted. The corrected
version computes `v_script_cost` once and divides shot spend across the final renders that
share it, with render-specific spend attached directly.

The shared-cost division is a modelling choice, not a fact — variants genuinely share the
shot spend. If you'd rather see full cost per variant, drop the divisor and never sum the
column.

---

## 6. What this does to the roadmap

Superseded by Addendum 02 §7. Retained for the record:

- **1a — Driver + Settings.** Interface, `higgsfield.ts`, `fal.ts` stub, integrations
  table + Vault + settings page. Settings first, because the driver's constructor depends
  on it.
- **1b — Pipeline leg.** Fan-out generate, webhook, grid, cost ledger.
- **1c — Studio lane.** Own MCP server over the driver, Opus 5 chat surface, session →
  script materialisation.
- **1.5 — Review + rough cut.** ffmpeg concat, reorder, per-shot regenerate, re-stitch.
