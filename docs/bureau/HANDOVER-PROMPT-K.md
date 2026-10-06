# Handover — Prompt K: secrets from Vercel only, the agent connector, YouTube Save and test, stages that refuse the unverified (06-Oct-2026)

Decisions: `docs/decisions/0017-env-from-vercel.md`, `docs/decisions/0018-agent-connector.md`.
Register: `0008` §17–§20. **No migration** (nothing to paste).

## What landed

| # | Item | Where |
|---|---|---|
| 1 | `syncVercelEnvVars` in `trigger.config.ts`, production only, wrapped by `vercelEnv()`. Its source was read first: it **swallows** a missing token, the CLI **swallows** any throw from `onBuildComplete`, and it **silently skips** every variable whose value Vercel will not return — every *Sensitive* one. The wrapper refuses in `onBuildStart` (the one hook the CLI does not catch) when the token is missing or a required name is absent / branch-only / Sensitive, and exits after the sync if a required name did not arrive | `src/lib/trigger/vercel-env.ts`, `vercel-env-check.ts`, `trigger.config.ts` |
| 2 | `check:trigger-env`: with `VERCEL_ACCESS_TOKEN`, every required name must exist in Vercel production, readable by the sync (names and types only, listed without `decrypt`); without it, `SKIP` with the reason and a GitHub notice — never a silent pass. `test:trigger-env` (new, `pnpm check` + CI) drives the extension and the real sync against stub fetches | `scripts/check-trigger-env.mjs`, `scripts/test-trigger-env.mjs` |
| 3 | Integrations screen: a key may live in Vercel's environment instead of Vault; empty fields + Save and test tests the environment key; verified still needs that click. Fields the environment holds show *environment* instead of *not set* (names only) | `settings/integrations/page.tsx`, `integration-card.tsx`, `environmentFields()` |
| 4 | YouTube probe, two checks: **credentials** (refresh-token exchange; `invalid_grant` → "Refresh token revoked or expired (7-day Testing expiry)") and **channel** (Analytics v2 reports, `ids=channel==<Bureau channel row's external_id>`, last 7 days; 403 → "Token belongs to a different channel", or the missing scope by name; `channel==MINE` fallback, said so). No Data API units, never uploads. `test:youtube-probe` (new, CI) + `verify:integration-gate` §5 | `src/lib/publish/youtube-probe.ts`, `drivers/probes.ts`, catalogue checks |
| 5 | `/api/mcp/agent`: a second door with its own protected-resource metadata, its own issuer (`/oauth/agent`), authorize page (agent fixed, no approver option) and token endpoint (refuses to mint approver; refuses owner-door codes; revokes an approver refresh presented there). The handler refuses approver tokens of both kinds with `403 approver_not_allowed_here`. `verify:oauth` §12 (+ 3 `verify:public` checks) | `src/lib/oauth/*`, `src/lib/studio/serve.ts`, `next-route.ts`, routes |
| 6 | Dispatch, voice, dubs and embeddings refuse, by name, an integration that has never verified — `verifiedCredentials()` over `usability()`, whose predicate (`hasVerified`) is the one the Settings banner counts with. Refused before any claim, synth, submit or ledger row; a refused dub stays queued with the reason in `error`. `verify:integration-gate` (new, CI) and `verify:episode` drive refusal and accept through each consumer | `src/lib/integrations/state.ts`, `verify.ts`, `bureau/{dispatch,voice,dubs,embed}.ts` |
| 7 | README: Vercel as the single source, Vault optional, the deploy command, two connectors. 0017, 0018 | |
| 8 | 0008 §17 (sync not run until the first deploy), §18 (YouTube probe real only on Save and test on the deploy), §19 (agent handshake only once connected from Claude), §20 | |

## (a) Deploy the worker — the exact command, and what to set once

```bash
pnpm dlx trigger.dev@4.5.9 login          # once, opens a browser
VERCEL_ACCESS_TOKEN=… TRIGGER_PROJECT_REF=proj_… pnpm trigger:deploy:dry   # builds, uploads nothing
VERCEL_ACCESS_TOKEN=… TRIGGER_PROJECT_REF=proj_… pnpm trigger:deploy
```

`pnpm trigger:deploy` is `trigger.dev deploy` from the pinned 4.5.9 CLI — the version whose
hook-calling and error-swallowing 0017 was written against. `npx trigger.dev@latest deploy`
runs a different CLI version than the one read; use the pinned one. (`--dry-run` builds
locally, so the dry run exercises the pre-build check too.)

| Variable | Set where | Value from |
|---|---|---|
| `VERCEL_ACCESS_TOKEN` | **Your shell only**, at deploy. Not in Vercel (it would be synced into the worker), not in Trigger.dev | vercel.com/account/settings/tokens → Create → Scope: **sahilmatt-6245s-projects** → any expiry you like |
| `TRIGGER_PROJECT_REF` | Your shell (or `.env`), as before | Trigger.dev dashboard → project → Project settings → `proj_…` |
| `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | **Nothing** — constants (`video-pipeline`, `team_2UHmmkh8jSZXWBQg8dIICYP5`); set only to override | the team id was read from Vercel's own 403 body for that scope |

**And in Vercel production, once — names, not values.** Every one of these must be set for
Production (not only a branch) and **not Sensitive**; the deploy refuses by name otherwise:

`ALLOWED_EMAIL`, `APP_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`STORAGE_DRIVER`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `VIDEO_DRIVER`,
`WEBHOOK_CALLBACK_BASE_URL`, `ANTHROPIC_API_KEY`, `RUNWAY_API_KEY`, `GEMINI_API_KEY`.
Optional and synced if present: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`,
`YOUTUBE_REFRESH_TOKEN` (stage 22 metrics and publishing skip without them),
`SUPABASE_S3_REGION`, `SUPABASE_S3_ENDPOINT`, `GENERATION_FAILOVER` (leave unset).

If a name is Sensitive (Vercel → Environment Variables shows it masked with no reveal; the
Vercel CLI makes production variables Sensitive by default):

```bash
vercel env rm  RUNWAY_API_KEY production
vercel env add RUNWAY_API_KEY production --no-sensitive   # paste the value
```

then redeploy Vercel so the web side reads the re-added value. Check before deploying the
worker: `VERCEL_ACCESS_TOKEN=… pnpm check:trigger-env` — names only, never values.

Then: Settings → Integrations → **Save and test** (fields empty) on each Bureau integration and
on YouTube. Expected YouTube result: credentials ✓, channel ✓ "The token reads
UCsAOylowJKXg7TENr5GskGQ's Analytics (last 7 days)". If it says the token lacks
`yt-analytics.readonly`, re-consent with that scope and replace `YOUTUBE_REFRESH_TOKEN`.

## (b) Migration bundle

**None.** No schema change this prompt: the agent door is derived from the code's stored
`resource` (0045) and the grant's scope; the integration gate reads existing columns. If
`hosted-migrations-4-0045.sql` is not pasted yet, paste it — OAuth (either door) needs it.

## (c) Adding the agent connector in Claude

Keep your existing **Kiln** connector on `/api/mcp` (Approver) for the phone. Then:

1. Be signed in to Kiln in the browser: `https://video-pipeline-seven.vercel.app/login`.
2. Claude → **Customize → Connectors → Add custom connector**.
3. Name **`Kiln (agent)`**; URL **`https://video-pipeline-seven.vercel.app/api/mcp/agent`**;
   leave the advanced OAuth client ID / secret empty → **Add**.
4. **Connect** → Kiln's consent tab opens at `/oauth/agent/authorize`: "Connect Claude to Kiln?",
   the client, "Sends you back to `https://claude.ai/api/mcp/auth_callback`", your email, and
   **Scope: Agent** — fixed, no radio. (If you see an Approver/Agent radio, this is the owner
   door: the URL in step 3 was `/api/mcp`.)
5. **Approve** → back in Claude, connected, **13 tools** (no `brief_approve`, `cut_approve`,
   `caps_set`, `kill_switch` …).
6. In each of the four Bureau scheduled tasks: enable **Kiln (agent)**, disable **Kiln**.
7. Check: Kiln → Settings → MCP tokens shows a second *OAuth connection* row, scope agent.

## Still unverified

- The sync (§17) — until the first deploy with the token. Whether your production variables
  are Sensitive is the likeliest blocker; the deploy will name them.
- Google answering the YouTube probe (§18) — until Save and test on the deploy.
- Claude's handshake against `/api/mcp/agent` (§19) — until you add it.

## Found on the way

0. **`syncVercelEnvVars` reports success three ways while copying nothing** (0017's table): a
   missing token becomes "No env vars detected"; a throw from any extension's
   `onBuildComplete` is logged and the deploy continues; and a Sensitive variable is skipped
   without a word. Used bare, the first deploy would very likely have shipped a worker with no
   secrets and a green "Successfully deployed". This is CLAUDE.md's "read what an extension
   installs" rule paying out a second time.
1. **The worker manifest could not see the credential reads.** `resolveCredentials` reads
   `process.env[field.key]` by a computed name, so `check:trigger-env`'s import-graph walk
   never listed `RUNWAY_API_KEY` & co. With Vault empty those were the reads the worker most
   depended on. `workerCredentialFields()` (catalogue) now names them for the deploy and the
   check.
2. **The pill and the refusal deliberately differ in one case** — verified once, failed a
   re-test. `rotateIntegration` keeps such an integration enabled (a re-test failure is as
   likely a blip as a dead key), so the stages keep using it while the pill says *failed*. A
   first cut of item 6 refused it, which would have taken the pipeline down on a transient;
   reverted, and the banner now states both counts with what each means. If you would rather a
   failed re-test stop spending, it is a one-line change in `usability()` — say so.
3. **The vendor-isolation guard caught a comment of mine** in `vercel-env.ts` naming the
   generation vendor. Reworded; the rule is right.
4. `README` used to say "deployed separately with `npx trigger.dev@latest deploy`". The CLI's
   behaviour is what 0017 rests on, so the README now says `pnpm trigger:deploy` (pinned).

## CI step list

Run 149 on `0986b74` (the last commit before this handover; job `check`): **success**, every
step read in the step list, not the log tail. Guards: gates, script names, worker binaries,
**worker env manifest** (the Vercel half printed SKIP with its reason — CI holds no Vercel
token by design), Remotion lockstep, font scale, guardrails, vendor isolation (which caught a
comment of mine locally first), calendar, public env. Typecheck, lint, voice timings, tour,
Bureau rules, entry flow, **Worker env from Vercel** (new), **YouTube probe** (new).
Migrations 0001–0045, enums, drift, catalogue rows, duplicates. Align, ingest, assemble,
review, stages 1/2/5/9/10/11, webhook, referral, costs, voice, limits, pilot, Studio MCP, Bureau
MCP, Bureau publishing, onboarding step 8, **MCP OAuth** (now with §12, the agent door),
**Stages refuse an unverified integration** (new), runway-video, Build, render, **episode end to
end** (now with the voice and dub refusals), **public pages** (now with the agent door's
routes), scaling, tour.

Earlier runs this session: 147 (`e462124`, the env sync) success; 148 (`e6c9876`, the
integration gate and the YouTube probe) success. The commit carrying this file also rewords
one line of `check:trigger-env`'s output ("Required by the worker — set in Vercel production").
