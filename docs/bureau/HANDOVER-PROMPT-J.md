# Handover — Prompt J: OAuth for the Kiln connector, onboarding fixes, public legal pages (06-Oct-2026)

Decision: `docs/decisions/0016-mcp-oauth.md`. Register: `0008` §16. Migration **0045**.

## What landed

| # | Item | Where |
|---|---|---|
| 1 | OAuth 2.1 authorization server for `/api/mcp`: protected-resource metadata (`/.well-known/oauth-protected-resource[/api/mcp]`), authorization-server metadata (`/.well-known/oauth-authorization-server`), 401 + `WWW-Authenticate: Bearer resource_metadata=…`, code + PKCE (S256 only), Client ID Metadata Documents (claude.ai / claude.com only) and DCR (`/api/oauth/register`) as the fallback, token endpoint `/api/oauth/token` | `src/lib/oauth/*`, routes under `src/app/.well-known` and `src/app/api/oauth` |
| 2 | Consent screen `/oauth/authorize`: only the signed-in `ALLOWED_EMAIL` user; client name, client ID, redirect URI; scope approver (default) or agent. Access tokens are `mcp_tokens` rows (`kind = 'oauth'`, same hashing, scope and `revoked_at`), one hour; refresh tokens rotate, 30 days sliding; replay of a code or refresh token revokes the connection | `src/app/(setup)/oauth/authorize`, 0045 |
| 3 | Static `kb_` tokens unchanged (`kind = 'static'`, no expiry). Scope rules unchanged and server-side; the DB scope check now also refuses an expired token | `tokens.ts`, `bureau_require_scope` |
| 4 | Redirect allow-list: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`; everything else refused by name and never redirected | `src/lib/oauth/policy.ts` |
| 5 | `pnpm verify:oauth` (70 checks, CI) | `scripts/verify-oauth.mjs` |
| 6a | `/setup` → first incomplete step's slug; every numeric `/setup/<n>` link fixed; footer prev/next by list position (step 11 had broken it) | `steps.ts`, `setup/page.tsx`, `test:entry` §5–8 |
| 6b | Step 8 completes without inserting when an active channel exists (shows it, handle editable); inserts only when there is none | `channel-step.ts`, `verify:onboarding` (CI) |
| 6c | Steps 6 and 10 wait for step 11; deferral notes key off roles, not catalogue kinds (the voice note was unreachable, an embeddings deferral showed as video); stale vendor copy; ticks on steps 4/5 that predate Runway are cleared by 0045 unless Runway has verified | see commit `df056ae` |
| 7 | `/about` (home), `/privacy`, `/terms` — public, Server Components, no client JS; middleware exempts exactly these; `pnpm verify:public` runs the production server signed out | `src/app/(splash)/{about,privacy,terms}` |
| 8 | README connector section: OAuth click-path, `--header` for Claude Code, agent scope for scheduled tasks | `README.md` |
| 9 | 0008 §16: only Sahil connecting proves the handshake; what he will see | `0008` |

## CI

See the step list at the end (read step by step, not the log tail).

## Sahil — what to do, in order

1. **Paste** `docs/bureau/hosted-migrations-3-of-3-0044.sql` if not yet done, then
   **`docs/bureau/hosted-migrations-4-0045.sql`**. One transaction; a second paste refuses by name.
   Until 0045 is applied the consent screen's Approve fails (no `oauth_codes` table), so paste
   before connecting. Static tokens work either way (see "Found on the way" #0).
2. Confirm Vercel has deployed `main` (the login page's build marker shows the sha).
3. Connect Claude — click-path (c) below. Use scope **approver** for yourself.
4. If your Claude scheduled tasks should reach Kiln: they see every connector on the account,
   so the safe shape is the one in the README — see "Found on the way" #1.
5. Google: publish the "Kiln YouTube" OAuth app out of Testing with the URLs in (d). If the
   consent screen asks you to verify the domain, add `GOOGLE_SITE_VERIFICATION` (a) and redeploy.

### (a) Environment variables

| Variable | Environments | Value from | Required? |
|---|---|---|---|
| `GOOGLE_SITE_VERIFICATION` | Vercel — Production | Google Search Console → Add property → **URL prefix** `https://video-pipeline-seven.vercel.app/` → HTML tag → the `content="…"` value | Optional. Only if Google asks you to verify the domain for the consent screen. Rendered on `/about`; redeploy after setting |

No other new variables. OAuth needs no secret (public clients, PKCE; tokens are random and
hashed), and it does not read `APP_URL` — the issuer is the host the request arrived on.
Nothing to set in Trigger.dev.

### (b) Migration bundle to paste

`docs/bureau/hosted-migrations-4-0045.sql` (0045 only), after `hosted-migrations-3-of-3-0044.sql`.
Tested here on a database at 0044: applies, creates the three `oauth_*` tables, and a second
paste refuses with "Already applied: 0045".

### (c) Adding the connector in Claude

1. In the browser (or phone) you'll use, sign in to Kiln: `https://video-pipeline-seven.vercel.app/login`.
2. Claude → **Customize → Connectors → Add custom connector**.
3. Name `Kiln`; URL **`https://video-pipeline-seven.vercel.app/api/mcp`**; leave the advanced
   OAuth client ID / secret empty → **Add**.
4. **Connect** → Kiln's consent screen opens ("Connect Claude to Kiln?", sends you back to
   `https://claude.ai/api/mcp/auth_callback`, your email).
5. Scope **Approver** (preselected) → **Approve** → back in Claude, connected, 21 tools.
6. Check: Kiln → Settings → MCP tokens shows a new *OAuth connection* row. Try "list pending briefs".

If the Kiln tab says the request was refused, it names the reason; 0016's last table maps each to
a one-line fix (most likely: Claude's callback or metadata host differs from what the spec
reading assumed).

### (d) Public URLs for Google

| Consent-screen / audit field | URL |
|---|---|
| Application home page | `https://video-pipeline-seven.vercel.app/about` |
| Privacy policy | `https://video-pipeline-seven.vercel.app/privacy` |
| Terms of service | `https://video-pipeline-seven.vercel.app/terms` |
| Authorized domain | `video-pipeline-seven.vercel.app` |

The privacy policy commits to deleting stored YouTube data within 7 days of a request or of
access being revoked. That is a manual promise today (no code does it): delete the
`YOUTUBE_*` integration secrets, the channel's `publications` YouTube IDs and its
`metrics_snapshots` rows if it ever comes to that.

## Still unverified

- **Claude's connector handshake** — 0008 §16. The two Claude pages the prompt named could not be
  fetched by this unattended run (per-URL permission, nobody to grant it); the server follows the
  MCP authorization spec, and 0016 lists every assumption with its fix.
- The consent screen with a real Supabase session (harness stands in for the owner).
- Google accepting the pages' wording.

## Found on the way

0. **A production regression of mine, live for about half an hour and fixed.** `c752323` made the
   token lookup select `mcp_tokens.expires_at`, which the hosted project does not have until 0045
   is pasted — so from that deploy until `020d9a6` deployed, every static `kb_` request (the
   Routines) answered 503. Now it selects `*`, and `verify:oauth` §11 hides the column and fails
   on the old select. Rule it breaks: code deploys before the hand-pasted migration does, so a
   read must tolerate the column being absent.
1. **One account, every connector.** A Claude connector is visible to every scheduled task on the
   account, so an approver connection for Sahil's phone is also visible to the four Bureau
   automations. Scope is enforced per *connection*, and Claude offers one connection per
   connector URL. If both are wanted at once, the clean fix is a second URL that only issues agent
   connections (e.g. `/api/mcp/agent`) — not built; say if you want it.
2. **`request.nextUrl.origin` is `localhost` under `next start`** (found by `verify:public` on
   its first run). The consent page and the token endpoint would have computed different
   resources and every exchange would have failed. All OAuth surfaces now read the origin from
   the headers through one function.
3. **A leftover `next-server` answered a later harness run** with the previous build (npx's child
   outlives a kill of npx). `verify:public` now refuses an occupied port and kills its process
   group; `verify:tour` has the same pattern and was not changed.
4. **Bureau stages do not check that an integration has *verified*, only that a key exists**
   (dispatch, voice, dubs, embeddings), while the Settings banner says tasks refuse an
   unverified integration. Out of scope for this prompt; not changed. A guard whose message
   promises more than it does — worth its own item.
5. The legacy stage 6 (`06-voice.ts`) still resolves the old audio vendor, which the wizard no
   longer asks for. Consistent with 0015's "legacy lane untouched".

## CI step list

Run 145 on `020d9a6` (the last code commit): job `check` **success**, all 53 steps read in the
step list. Guards: gates (51 wired), script names, worker binaries, worker env manifest, Remotion
lockstep, font scale, guardrails, vendor isolation, calendar, public env. Typecheck, lint, voice
timings, tour beats, Bureau rules, **entry flow** (now with `/setup` over 6,144 states, the footer
walk, the 4/5/11 mapping and the no-numeric-link scan). Migrations 0001–**0045** applied, enums
(three new), drift (types regenerated), catalogue rows, duplicates (which caught two OAuth module
names first: `config.ts`, `serve.ts` → `policy.ts`, `endpoints.ts`). Align, ingest, assemble,
review, stages 1/2/5/9/10/11, webhook, referral, costs, voice, limits, pilot, Studio MCP, Bureau
MCP, Bureau publishing, **Onboarding step 8** (new), **MCP OAuth** (new), runway-video, Build,
render, episode end to end, **Public pages** (new), scaling, tour.

Earlier runs this session: 142 (`c752323`, OAuth) success; 143 (`f3b18dc`, public pages) success;
144 (`28a9457`, docs) success.
