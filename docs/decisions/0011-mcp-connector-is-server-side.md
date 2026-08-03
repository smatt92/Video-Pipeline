# 0011 — The MCP connector is server-side, and what that costs

Status: accepted · 2026-08-03

## The fact

The Messages API's `mcp_servers` connector makes the MCP connection **from Anthropic's
infrastructure**. The client that calls `POST /v1/messages` does not open a socket to the
MCP server; Anthropic does, from its own network, on receiving the request.

This is checked against the API documentation rather than inferred from the shape of the
request, and it was checked *before* the Studio lane was built rather than after, because
it decides whether the lane's headline requirement — one real session, end to end — is
achievable from a development container at all.

It is not. A container with no public hostname cannot be dialled by Anthropic, and no
amount of local wiring changes that. `localhost`, a loopback port, a Unix socket and an
in-process handler are all equally unreachable from another network.

## What Addendum 01 already said, read correctly

§2 constraint 3: *"No local servers. The server must be publicly reachable over HTTP
(Streamable HTTP or SSE); local STDIO servers can't be connected."*

The addendum's emphasis is on the transport — STDIO versus HTTP — and that reading is
incomplete. The binding requirement is not "not STDIO", it is **reachable from Anthropic**.
An HTTP server on `127.0.0.1:39351` satisfies the letter of that sentence and cannot be
connected to. Nothing in the addendum is wrong; it names the symptom rather than the cause,
and the cause is the one that determines what a container can prove.

## The decision

Build the production path exactly as specified, and verify everything on this side of that
socket with the real components rather than substituting the whole lane for a mock.

**Production** — `src/lib/studio/session.ts`, `ToolChannel` of kind `connector`:

```ts
client.beta.messages.create({
  model: 'claude-opus-5',
  mcp_servers: [{ type: 'url', url, name: 'kiln', authorization_token: token }],
  tools: [{ type: 'mcp_toolset', mcp_server_name: 'kiln' }],
  betas: ['mcp-client-2025-11-20'],
})
```

Both halves are required. `mcp_servers` declares the connection; the `mcp_toolset` entry in
`tools` is what exposes the tools to the model. Omitting the toolset is a validation error,
not a request with no tools — which is the more useful failure of the two, because it costs
nothing and says so immediately.

**Verification** — `ToolChannel` of kind `bridge`. The same six tool objects declared as
ordinary tools with the same names and the same JSON Schemas, executed by this process by
POSTing `tools/call` to the same `/api/mcp` handler over real HTTP. Real Anthropic API, real
MCP server, real protocol framing, real bearer check, real rows. The only substituted
component is which machine opens the socket.

The two channels share the system prompt, the transcript, the spend cap, the ledger write
and the materialisation, and they read their tool definitions from one module — so they
cannot drift into describing different tools to the model.

## Why this is not a mock, and why it is also not a run

It is not a mock: every component in the path is the one that ships, including the JSON-RPC
dispatch, the token verification and the session-active check. A protocol bug is caught
here.

It is not a run of the production path either: the connector's own behaviour — its retries,
its timeout, how it presents a 401 from our server, whether it batches `tools/list` — is
unobserved. Calling this "verified" would be the exact substitution this project keeps
refusing, so `0008-what-is-unverified.md` §7 records the leg by name and the symptoms it
would produce.

## What closing it requires

A deploy with a public hostname and `STUDIO_MCP_TOKEN_SECRET` set, then one session. A
Vercel preview is sufficient — the connector needs the URL to resolve and answer, not to be
the production domain. Unlike the generation webhook, a preview hostname is fine here: the
URL is passed per request rather than registered ahead of time, so it cannot go stale
between the push and the callback.

## Rejected: point Opus 5 at the vendor's hosted MCP instead

Addendum 01 §2 settles this and the reasoning holds: a generation made through a vendor's
MCP server lands in the vendor's account and writes nothing here — no `generations` row, no
`cost_ledger` row, no idempotency key we issued. The review screen cannot see it and cost
per video is blind to it. It would also not have avoided this problem, since that connector
is server-side in exactly the same way.
