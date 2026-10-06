# 0012 — Bureau of Reality: where the prompt and CLAUDE.md disagree, and what was chosen

Status: accepted · 2026-10-06

The Bureau of Reality build prompt (docs/bureau/kiln-prompts.md, Prompt A, as amended by the
session setup) asked for several things CLAUDE.md constrains. CLAUDE.md wins wherever they
conflict. Every deviation is listed here so the next reader does not re-derive it.

| # | The prompt asked for | What was built | Why |
|---|---|---|---|
| 1 | "Remote MCP server … official TypeScript MCP SDK" | The existing hand-rolled JSON-RPC server at `/api/mcp`, extended | The session setup says *extend, do not create a second server*. The existing `dispatch` is transport-free and harness-driven; swapping in the SDK would replace a verified protocol layer with an unverified one and add a dependency CLAUDE.md does not list. Same wire protocol (Streamable HTTP, POST, JSON-RPC 2.0, revisions 2025-06-18 / 2025-03-26). |
| 2 | OAuth if practical | Bearer tokens from `mcp_tokens` (SHA-256 at rest), scopes `approver` and `agent` | Claude custom connectors accept a static bearer in the connector's advanced settings; OAuth would need an authorisation server this app does not have. Recorded as a known limit: tokens do not expire; revocation is `revoked_at`. **Superseded for Claude chat and scheduled tasks by 0016 (06-Oct-2026):** the static-header option turned out to be a beta personal plans may not have, so `/api/mcp` now runs its own OAuth 2.1 server; static tokens remain for Routines and Claude Code. |
| 3 | Resources (`kiln://…`) | Implemented (`resources/list`, `resources/read`, templates) for Bureau tokens | 0011 / mcp.ts said the *Messages API* connector ignores resources. Claude's custom connectors in the apps read them, and Routines use them — so for the Bureau surface they have a reader. Studio session tokens still get tools only. |
| 4 | YouTube publish at slot time; Instagram "posts automatically" | Bundles (`publish_bundles`, Ready-to-schedule page) + upload/IG code paths behind `channel_policy.youtube_api_audited = false` and `instagram_publish_enabled = false` | CLAUDE.md current phase: no auto-publish until Meta app review clears. `enforce_review_pass` stays the gate; nothing bypasses it. A second DB trigger (`enforce_channel_policy`) adds the kill switch and the daily publish cap. |
| 5 | "No AI attribution in code comments" | No attribution anywhere | Matches the standing instruction; commits authored by Sahil Mathew. |
| 6 | Field `elevenlabs_voice_id` in characters.json | **Superseded by 0013**: `voice {provider, preset_id}` + optional `elevenlabs_voice_id`, with the schema in `src/lib/drivers/voice-route.ts` so the bible loader names no vendor | Rule 1 is satisfied by where the schema lives, not by renaming the field. |
| 7 | `HIGGSFIELD_API_KEY_ID/SECRET` | Catalogue keys renamed to `HIGGSFIELD_API_KEY_ID` + `HIGGSFIELD_API_KEY_SECRET`; old names accepted as env aliases | Nothing in Vault yet (hosted DB empty), so the rename is free now and expensive later. |
| 8 | "FX 88" in env | `profiles.usd_inr_rate` default 88 (migration 0037) | The env variable was deliberately deleted (DECISIONS-PENDING 5/7). The operator's chosen rate is recorded where the code reads it. |
| 9 | New tables `scripts, shots, gen_jobs, assets, cuts, publications, metric_snapshots…` | Reused existing tables; added `slots, briefs, episodes, gen_jobs, provider_limits, fact_sources, comments, dub_jobs, strategy_memos, mcp_tokens, authorship_log, channel_policy, notifications` | "Do NOT rebuild what exists." `cuts` = renders with `layer`; `variation_axes` = view `v_variation_ledger` over briefs (two homes for the same axes would drift). |
| 10 | RLS on everything | 0039: RLS on every public table, no permissive policies, anon/authenticated revoked from views, self-row policy on `profiles` only | Supersedes 0003, whose consequences section required RLS before channel tokens and publishing authority — both arrive here. |
| 11 | "Move generic pipeline code to /core" (bundle v2) | Not done | Session setup: keep the existing `src/` layout. Channel config lives in `channels/bureau-of-reality/`. |
| 12 | Jev (TypeSafe) router pattern | Not found in reachable repos or notes; built the spec's fallback in `src/lib/llm/router.ts` | Only `smatt92/video-pipeline` is in scope this session. |
| 13 | "Apply 0002–0036 to hosted" | 0002 applied; 0003 refused | The Supabase MCP requires interactive confirmation for any statement containing `DROP` and times out when unattended. Stopped at the first failure as instructed. Bundle for the SQL editor produced instead (see HANDOVER-NEXT). |
| 14 | Generation polling | Webhook for the primary character-beat vendor (existing route), polling for Veo / Act-Two / fal | Rule 4 prefers webhooks; only one of these vendors offers one we already verify. Polling is through the queue's per-provider concurrency, never a tight loop. |
| 15 | "Two approval gates via wait.forToken()" | Gate 1 (brief) *starts* the run; gate 2 (cut) is `wait.forToken` inside `20-episode` | Waiting on a brief approval inside a run would hold a run per pending brief for days; the approval itself is the trigger. |

## What this does NOT decide

The slot publish time (default 18:00 Asia/Kolkata, `channel_policy.default_slot_time`) is a
placeholder until Sahil sets it; the audience is English-first and may want a US evening.
