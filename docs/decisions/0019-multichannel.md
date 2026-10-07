# 0019 — Several channels: a bible per channel, an active channel per browser

**Date:** 2026-10-07
**Status:** accepted
**Migration:** 0046 (`docs/bureau/hosted-migrations-5-0046.sql`)

## Context

Kiln ran one channel. `src/lib/bureau/bible.ts` exported the Bureau's id and its bible as
module constants, and 55 call sites in 19 files under `src/` read the id from there — so
every screen, server action, MCP resource and Trigger task was the Bureau's whether or not
the row it acted on was. A second channel would have been drafted against the Bureau's cast,
linted against the Bureau's names and alerted as "Bureau of Reality".

## Decision

1. **The channel comes from the row, then the token, then the browser.** An action on a
   brief, episode, slot or publication reads that row's `channel_id` and acts through a token
   for that channel (`ui-actions.ts`: one "Control room (web)" token per person *per channel*,
   so the 0040 decision functions — which compare the token's channel with the row's — hold
   across channels). An MCP call uses its token's channel. Only screens and the two row-less
   actions (kill switch, CSV import) use the **active channel**: a cookie (`kiln_channel`),
   set by the switcher at the top of the sidebar, defaulting to the oldest channel with a
   bible. Switching channels can never re-target a decision.
2. **A bible is files, per channel:** `channels/<slug>/{characters.json, policy.json,
   series/*.json, trends.json}`, keyed by `channels.slug`. Both bundles (Vercel and the
   worker) need the JSON, and a runtime `readFile` of a folder the bundler never saw exists in
   git and not in production — so `scripts/channels-registry.mjs` generates
   `src/lib/channels/registry.generated.ts` (static imports), and `check:channels` (in
   `pnpm check` and CI) fails when it disagrees with the folders. Every folder, the template
   included, is Zod-parsed at import. `bibleForChannel(db, id)` is the one way in.
3. **Add channel is two halves.** Vercel cannot commit, so `pnpm channel:new <slug>` copies
   `channels/_template/` on a laptop; the Add channel form (`/channels/new`) then creates the
   row, its policy, its publish targets and its cast — and refuses a slug whose folder is not
   in the deployed build, by name, with that command.
4. **Publish targets are a table** (`channel_publish_targets`, (channel, platform)), not a
   rewrite of `channels.platform`, which stays as the primary. `/channels` edits them.
5. **Voice overrides are a table** (`channel_voice_overrides`), read by the same routing
   predicate (`voiceRouteFor(c, override)`): an override wins; a malformed override refuses by
   name rather than falling back silently to the bible.
6. `BUREAU_CHANNEL_ID` survives only as a fixture (`src/lib/fixtures/seed-channel.ts`) for
   harnesses and audition scripts.

## What is still single-channel, on purpose

- **The prompts in `src/lib/prompts/20-bureau.v1.ts`** name the Bureau's world and format. A
  second channel with a different format needs its own prompt version; the brief generator
  passes the channel's cast and series, but the system prompt is the Bureau's.
- **Series ids are the `bureau_series` enum.** A channel runs any subset of them; a new
  series id is a migration.
- **Integrations are workspace-wide** (one Runway key, one YouTube OAuth, one Meta token).
  The probes compare the token's account with the active channel's target.

## Consequences

- `verify:channels` proves two channels in one database stay apart through the functions the
  screens and tools call, and that a token for A is refused on B.
- Every reader of 0046's tables tolerates their absence (no rows, the old single platform),
  so `main` deploys before the bundle is pasted.
