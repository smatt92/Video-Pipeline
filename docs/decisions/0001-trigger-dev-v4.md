# 0001 — Trigger.dev v4, not v3

**Date:** 2026-08-01
**Status:** accepted
**Reverses:** `CLAUDE.md` stack line, `docs/ARCHITECTURE.md` §1

## Context

Both spec documents name Trigger.dev **v3**. At the time they were written that was
current. It no longer is: the current major is `@trigger.dev/sdk@4.5.9`, and v3 is frozen
at `3.3.17` — no new features, no fixes.

The primitive ARCHITECTURE.md §2 depends on — `wait.forToken()`, the "submit job, sleep
until webhook, resume" park — exists in both majors, so this is not a capability
question. It is a question of which one we want to be on when Phase 3 arrives.

## Decision

Pin `@trigger.dev/sdk@^4` and `trigger.dev@^4`.

## Consequences

- Task authoring syntax differs from v3 in details. Anything written against a v3
  example needs checking rather than copying.
- The two spec lines naming v3 are now wrong. They are left as written — the specs are a
  record of what was decided when, and this file is the amendment. Do not silently edit
  a spec to match the code.
- Migrating v3 → v4 later would have been a Phase 3 detour at exactly the point where
  publishing deadlines land. Paying it now, with one config file and no tasks written,
  costs nothing.

## Alternative rejected

Pin v3.3.17 as specced. Rejected because the only argument for it is literal compliance
with a document that predates the release, and the cost of the eventual migration grows
with every task written.
