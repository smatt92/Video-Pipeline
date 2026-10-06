# 0018 — A second connector URL that can only ever be agent: /api/mcp/agent

**Date:** 2026-10-06
**Status:** built; `verify:oauth` §12 and `verify:public` drive it over HTTP. Claude's
handshake against it is **not** verified until Sahil connects (0008 §19). Amends 0016.

## Problem (J's "Found on the way" #1)

A Claude connector is visible to every scheduled task on the account, and Claude offers one
connection per connector URL. Sahil wants an **approver** connection on his phone, and the four
Bureau automations need an **agent** connection. With one URL, whichever he connected last is
what every scheduled task holds — and if that is approver, any scheduled task can approve,
publish, change caps or flip the kill switch.

## Decision

Two doors onto the same MCP server, the same tools, the same token rows and the same scope
enforcement (TypeScript and database):

| Door | MCP URL | Protected-resource metadata | Issuer | Authorize | Token | Scopes |
|---|---|---|---|---|---|---|
| owner | `/api/mcp` | `/.well-known/oauth-protected-resource/api/mcp` | origin | `/oauth/authorize` | `/api/oauth/token` | approver (default) or agent |
| agent | `/api/mcp/agent` | `/.well-known/oauth-protected-resource/api/mcp/agent` | origin`/oauth/agent` | `/oauth/agent/authorize` | `/api/oauth/agent/token` | **agent only** |

Registration (`/api/oauth/register`) and the client-ID-metadata allow-list are shared.

**Why a separate issuer, not just a separate resource.** The agent door's refusal must not
depend on a connector sending RFC 8707 `resource`. With its own issuer, a client that omits
`resource` still walks the agent door's metadata to the agent authorize page and the agent
token endpoint — and neither of those can mint approver. RFC 8414 path insertion gives the
issuer's metadata at `/.well-known/oauth-authorization-server/oauth/agent`; the existing
catch-all route serves it. A well-known path naming neither door is now a 404 instead of the
owner's document.

## Where approver is refused on the agent door

Each one alone is sufficient; all are tested:

1. **Consent screen** — scope shown as Agent, fixed; no radio. Its server action is bound to
   the agent door in code (not a hidden field), and posts of `approver` are refused with
   `invalid_scope` / `scope_not_allowed_here` before a code exists.
2. **Authorize request** — asking for `approver` alone is sent back as `invalid_scope`;
   `approver agent` is answered with agent. `resource=/api/mcp` here is `invalid_target`.
3. **Token endpoint** — a code is bound to its door's resource, so an owner-door code is
   `resource_not_this_server`; a code row that says approver is `scope_not_allowed_here`
   (no code path writes one; the endpoint does not rely on that); an approver refresh token is
   refused **and that connection revoked** (it can only have come from the other door).
4. **MCP handler** — an approver token of either kind (static `kb_a_`, OAuth `kb_oa_`) gets
   `403 approver_not_allowed_here` before any tool runs; 403 rather than 401 so a connector
   does not refresh and retry the same token. Studio session tokens are 401 there.

And the property the prompt names: an agent connection made through `/api/mcp/agent` is
refused on `brief_approve` by the tool (`scope_denied`) and by `bureau_brief_approve` in SQL.

## No migration

The door is derived from the code's `resource` (already stored by 0045) and the grant's scope.
Nothing new is stored, so there is nothing to paste and nothing for a deploy to outrun.

## Click-path (also in the README)

Phone: connector `Kiln` on `/api/mcp`, Approver. Automations: a second connector,
`Kiln (agent)` on `/api/mcp/agent`, which shows Agent fixed.
