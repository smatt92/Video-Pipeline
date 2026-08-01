# 0004 — The Higgsfield SDK is `@higgsfield/client`, and we target its v2 surface

**Date:** 2026-08-01
**Status:** accepted
**Corrects:** `CLAUDE.md` stack line, `docs/ARCHITECTURE.md` §1 and §3

## Context

Both specs say the video driver is built on `higgsfield-js`. There is no npm package by
that name — it 404s. `higgsfield-js` is the *GitHub repository*
(`higgsfield-ai/higgsfield-js`); the package it publishes is **`@higgsfield/client`**,
currently `0.2.1`, authored by Higgsfield and MIT licensed.

That package ships two different clients:

| | v1 — `HiggsfieldClient.generate()` | v2 — `subscribe()` |
|---|---|---|
| Vendor's own label | deprecated | recommended |
| Auth | `hf-api-key` + `hf-secret` headers | `Authorization: Key <id>:<secret>` |
| Response | `JobSet` with jobs[] | `{request_id, status_url, cancel_url, …}` |
| Cancel | none | `cancel_url` on the response |
| Character refs | `createSoulId` / `listSoulIds` | consumes `custom_reference_id` only |

## Decision

Target the **v2 `subscribe()`** surface. Dependency is `@higgsfield/client@^0.2.1`.

## Consequences

- **Character references can be consumed but not created.** v2 takes a
  `custom_reference_id`; only v1 can mint one. Phase 1 therefore obtains Soul IDs out of
  band — via the hosted MCP or the Higgsfield dashboard, which ROADMAP.md Phase 0 already
  has you doing by hand — and records them in the `characters` table
  (`external_ref_id`). Nothing in the pipeline creates a character. If that becomes
  intolerable, the fix is to call v1 for character management only, inside
  `higgsfield.ts`; it does not change the driver interface.
- **`withPolling` defaults to `true` on both surfaces.** A naive `subscribe()` blocks and
  polls, violating CLAUDE.md rule 4 and burning undocumented rate limits. The driver must
  pass `withPolling: false` on every call. This is easy to forget and invisible when
  wrong — it just gets slow and starts failing silently.
- **There is no webhook signature.** The SDK's `webhook(url, secret)` helper documents
  the secret as being sent back in an `X-Webhook-Secret-Key` header. Higgsfield does not
  HMAC-sign webhook bodies. So "verify the signature" is really "compare a shared secret
  in constant time" — a bearer token, replayable by anyone who obtains it. The webhook
  receiver treats a delivery as a *hint that something changed*, and confirms against
  `status_url` before acting on it. One confirmation call is not polling.
- **Cancel is best-effort.** `cancel_url` exists, but the vendor documents `in_progress`
  as not cancellable, and the SDK exposes no method for it — it is a raw HTTP call. The
  driver interface must model cancel as "may not be supported, may refuse", not as a
  method that succeeds.
- The v2 typed endpoint map covers only `dop` (image→video), `speak`, and `soul`
  (text→image); endpoints are free-form strings and the real catalogue is fetched from
  the account. **Model choice for Phase 1 is still open** and needs a real account to
  settle — see the open question in the Task 1 report.

## Alternative rejected

Target v1, which has the fuller documented surface including character creation. Rejected
because the vendor marks it deprecated and it has no cancel path at all, and because
building the first driver on a surface that is already being retired trades a small
convenience now for a rewrite at an unpredictable time.
