# 0016 — OAuth 2.1 for /api/mcp, so Claude chat and scheduled tasks can reach Kiln

Status: accepted · 2026-10-06 · amends 0012 #2 ("tokens do not expire") for OAuth connections only
· amended by 0018: a second, agent-only door at `/api/mcp/agent` with its own issuer

## Why

Claude chat (claude.ai and the phone apps) adds a custom connector by URL and authenticates it
with OAuth. `/api/mcp` accepted only static bearer tokens (`kb_…`, hashed in `mcp_tokens`),
and Claude's static "request headers" option is a beta that a personal plan may not have. So
Sahil could not reach Kiln from Claude chat, and the Bureau's approve-from-your-phone loop
depends on exactly that. Claude's scheduled tasks run in cloud containers whose egress blocks
`video-pipeline-seven.vercel.app`, so they too reach Kiln only through a Claude connector.

## What the client does, and what this was checked against

**Read, honestly:** this run was a scheduled, unattended session. The two pages the prompt
named — `https://claude.com/docs/connectors/building/authentication` and the MCP authorization
specification — could not be fetched: the fetch tool asks for a per-URL permission and nobody
was there to grant it (the request was withdrawn), and a web search returned titles without
content. What is implemented below follows the MCP authorization specification as of its
2025-06-18 and 2025-11-25 revisions (RFC 9728 protected-resource metadata, RFC 8414
authorization-server metadata, OAuth 2.1 code + PKCE, RFC 8707 resource indicators, Client ID
Metadata Documents, RFC 7591 registration as the fallback), and Claude's published callback,
`https://claude.ai/api/mcp/auth_callback`, plus its `claude.com` twin. Every place where a
detail of Claude's client could differ from that reading is listed under *If the connect
fails* with the one-line change it would need. 0008 §16 records that only Sahil connecting
proves it.

## What was implemented

| Piece | Where | Behaviour |
|---|---|---|
| 401 discovery | `src/lib/studio/serve.ts` (`unauthorized`) and `GET /api/mcp` | Every 401 carries `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp"`; `error="invalid_token"` is added only when a token was presented, so a dead token makes the client refresh instead of re-consenting. An unauthenticated GET answers the same 401 rather than 405, so a client that probes with GET can still discover OAuth. |
| Protected-resource metadata | `/.well-known/oauth-protected-resource` and `…/api/mcp` (RFC 9728 §3.1 path form) | `resource` = `<origin>/api/mcp`, `authorization_servers` = `[origin]`, `scopes_supported` = approver, agent |
| Authorization-server metadata | `/.well-known/oauth-authorization-server` | Issuer is the bare origin. `code` only; `authorization_code` + `refresh_token`; `code_challenge_methods_supported: ["S256"]`; `token_endpoint_auth_methods_supported: ["none"]`; `client_id_metadata_document_supported: true`; registration endpoint advertised |
| Client ID Metadata Documents (preferred) | `src/lib/oauth/clients.ts` | A `client_id` that is an https URL is fetched (5 s, 64 KB, no redirects), must name itself as that URL, and must list only allowed redirect URIs. **Only `claude.ai` and `claude.com` are fetched** — fetching any URL a request names would make the authorize page a request-forgery relay. Cached in `oauth_clients`. |
| Dynamic Client Registration (fallback) | `POST /api/oauth/register` | RFC 7591. Refused whole if any redirect URI is off the list. Public clients only: the response says `token_endpoint_auth_method: none` whatever was asked, and no secret is issued. |
| Authorize + consent | `/oauth/authorize` (page + Server Action) | Behind the auth gate; middleware now carries the query string through `/login?next=`. Only the signed-in `ALLOWED_EMAIL` user can approve (checked by middleware, the page and the action). Shows client name, client id, redirect URI and the signed-in address; scope radio, **approver preselected**, agent explained. No client JS. |
| Code + PKCE | `src/lib/oauth/flow.ts` | `S256` only (plain is refused as `pkce_method_not_s256`); challenge must be 43 base64url chars; codes are SHA-256 hashed, live 120 s, single use by an atomic `consumed_at` update. A code presented twice is `code_replayed` **and the connection it minted is revoked** (OAuth 2.1 §4.1.3). `redirect_uri` must match exactly at the token endpoint. `resource`, when sent, must be this origin's `/api/mcp` (`invalid_target`). The redirect carries `iss`. |
| Tokens are `mcp_tokens` rows | 0045 | One consent = one row, `kind = 'oauth'`, with the same `scope`, `channel_id`, `profile_id`, hashing and `revoked_at` as a minted `kb_` token. `token_hash` is the current access token (`kb_oa_…` approver / `kb_og_…` agent); it is replaced on refresh. `expires_at` = one hour. Revoking the row on Settings → MCP tokens ends the access token at once and refuses every refresh after it. |
| Refresh with rotation | `oauth_refresh_tokens` | `kbr_…`, 30 days sliding, single use. A rotated refresh token presented again means two holders: `refresh_token_replayed` and the connection is revoked. A refresh token is never a bearer (`401 invalid_token`). |
| Expiry, twice | `resolveBureauToken` and `bureau_require_scope` (0045) | TypeScript refuses an expired access token before any tool; the database's scope check refuses it too, like `revoked_at`. |
| Static `kb_` tokens | unchanged | `kind = 'static'`, no expiry (a CHECK refuses one), same surface. Routines and Claude Code `--header` keep working. |
| Scope rules | unchanged, server-side | Agent can never approve, publish, change caps or flip the kill switch — in `control.ts` and in every decision function. The OAuth scope *is* `mcp_tokens.scope`; there is no second copy to drift. |

## Redirect-URI allow-list

`src/lib/oauth/policy.ts`: `https://claude.ai/api/mcp/auth_callback` and
`https://claude.com/api/mcp/auth_callback`. Everything else is refused with
`redirect_uri_not_allowed` (at registration and in a metadata document) or
`redirect_uri_not_registered` (at authorize), and those refusals are **shown on the page, never
redirected** — sending an error to an unvalidated URI is the open redirect the check exists to
stop. Claude Code's localhost callback is deliberately absent: it uses a static token.

Constants, not environment variables: each is a security boundary, and one that a dashboard
edit can widen will be widened while debugging and never narrowed.

## Choices and their reasons

- **Kiln is its own authorization server.** The alternative, Supabase Auth as the AS, would
  issue Supabase JWTs that know nothing of `mcp_tokens`, scope or revocation, and would let any
  Supabase user in. The allowlist and the scope live here.
- **One row per connection, hash rotated in place.** A row per access token would fill Settings
  with an entry an hour and make revoking a connection mean revoking a family.
- **Origin from the request, not `APP_URL`.** The resource a token is bound to must be the URL
  the client actually dialled; a preview deployment is then its own issuer and its tokens are
  useless elsewhere. `APP_URL` stays what it was (links and the Settings page). Read from the
  `x-forwarded-host` / `host` headers by one function (`originFromHeaders`) on every surface —
  not `request.nextUrl.origin`, which `verify:public` caught `next start` reporting as
  `localhost` while the Host was `127.0.0.1`: the consent page (headers only) and the token
  endpoint would have disagreed and every code would have failed as `resource_not_this_server`.
  Vercel sets `x-forwarded-host` itself; a client that forges it only changes the issuer named
  in its own responses.
- **Public clients only.** PKCE carries the proof; a client secret stored in someone else's
  infrastructure adds a thing to leak and nothing to check.
- **No revocation endpoint (RFC 7009).** Revocation is Settings → MCP tokens. A client-side
  "disconnect" in Claude simply stops using the tokens; they expire within the hour and the
  refresh token is useless once the row is revoked.

## Tests

`pnpm verify:oauth` (CI step "MCP OAuth — code + PKCE, refresh rotation, revocation, scope"),
70 assertions over a real socket through the shipped `serveOAuth` and `serveMcp`, against
Postgres with every migration: discovery as a connector walks it; DCR and metadata-document
clients; the full code + PKCE flow ending in MCP calls; a revoked connection refused on the next
call and on refresh; an agent OAuth token refused on `brief_approve` in TypeScript and in the
database; a wrong `redirect_uri` refused (registration, document, authorize, token); a replayed
code refused and its connection revoked; refresh rotation and replay; expiry; Deny; static tokens
unchanged. Mutating the PKCE comparison or the replay revocation fails it (checked).

What it cannot cover: Claude's own client, and the consent screen's session check (the harness
stands in for the signed-in owner; middleware keeping the page behind sign-in is in
`verify:public`).

## If the connect fails — what each symptom means

| Symptom in Claude | Likely cause | Change |
|---|---|---|
| "Couldn't reach the server" / no consent page opens | Claude did not follow the 401 (unlikely) or the deploy predates this | Check `curl -i -X POST <url>/api/mcp` shows `www-authenticate` |
| Kiln page says `client_host_not_allowed` | Claude's metadata document is on a host other than claude.ai / claude.com | Add that host to `ALLOWED_METADATA_HOSTS` |
| Kiln page says `redirect_uri_not_allowed` or `redirect_uri_not_registered` and names a URI | Claude's callback differs from the two on the list | Add the exact URI it names to `ALLOWED_REDIRECT_URIS` |
| Claude says the connection failed after you pressed Approve | Token exchange refused | Vercel logs for `/api/oauth/token`: the `error_description` names it (`pkce_mismatch`, `resource_mismatch`, …) |
| Works for an hour, then fails | Refresh refused | Same log; `grant_revoked` means the row was revoked on Settings |
