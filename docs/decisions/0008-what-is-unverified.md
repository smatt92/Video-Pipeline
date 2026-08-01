# 0008 — What is unverified, and what verifying it requires

**Date:** 2026-08-01
**Status:** open — this file gets deleted when the last box is ticked

## Context

The build environment has no network route to any Supabase, Higgsfield, ElevenLabs or
Trigger.dev host. Every one is refused at the organisation's egress policy with a 403 to
CONNECT, and raw TCP on non-443 ports is blocked outright, so a direct Postgres connection
is impossible too. Anthropic is the only vendor reachable.

That makes a category of work writable but not provable here. Writing it anyway is the
right call — it is the same code either way, and the alternative is waiting — but code
that has never executed against the thing it targets is not the same as code that has.
CLAUDE.md rule 8 is explicit: *a feature is done when it's visible and triggered in a real
run against real APIs.* None of the below is done.

## Unverified, in order of how much rests on it

### 1. Supabase Vault — `scripts/verify-vault.mjs`

**Never executed.** Reasoned from the Vault API, not observed.

Everything in the settings design depends on Vault working, because every vendor
credential ends up there. The script checks four things in order: the `supabase_vault`
extension exists, `vault.create_secret()` returns an id, `vault.decrypted_secrets` returns
*the same plaintext*, and deleting actually removes the row. The third is the one that
matters — an extension that installs and a function that returns an id prove nothing about
whether the value survives the round trip.

If the extension is absent the script says so and stops. It does not enable it.

**To verify:** `pnpm verify:vault "<direct connection URI>"` — Dashboard → Settings →
Database → Connection string → URI.

### 2. Storage — `scripts/verify-storage.mjs`

**Never executed.** Two vendor-specific details are reasoned from the S3 protocol rather
than observed, and are the likeliest cause of a first-run failure:

- `forcePathStyle: true` is required, because Supabase serves buckets as a path segment
  rather than a subdomain. Without it the SDK builds a virtual-hosted URL that resolves to
  nothing.
- The S3 access keys are a **separate credential** from the service-role key. A 403
  usually means the service-role key was pasted into `SUPABASE_S3_ACCESS_KEY_ID`.

The script does four real operations against the real bucket: presign a PUT, upload
through it with plain `fetch` (not the SDK — the thing that must work is a URL a browser
can use with no credentials), read it back and compare bytes, delete and confirm a
subsequent GET no longer finds it.

**To verify:** `pnpm verify:storage` with `.env.local` populated.

### 3. Schema against the hosted project

Migrations 0001–0005 have only ever been applied to a local Postgres 16. They apply
cleanly from empty, in order, and the committed types match them — `pnpm check:drift`
proves that much and runs in CI.

What that check explicitly does **not** prove is anything about the hosted project. It
never connects to it. A hosted database can have drifted arbitrarily and this check still
passes. Hosted drift needs `supabase db diff --linked`, which requires Docker and network
access to the project.

Two things in particular have never run against a real Supabase instance:

- **The `enforce_review_pass` trigger.** It exists in 0001 and applies without error, but
  "the trigger exists" and "the trigger fires" are different claims. It should be proven
  by attempting an insert into `publications` with a non-`pass` review and confirming the
  insert *raises*. A compliance gate that exists but does not fire is worse than no gate,
  because it is trusted.
- **`profiles.id` has no FK to `auth.users`.** Deliberate — the auth schema does not exist
  on a plain Postgres and a hard FK would make the migration sequence unrunnable in CI
  (see 0005). Worth confirming the ids actually line up in practice.

**To verify:** `supabase link --project-ref <ref> && supabase db push`, then
`pnpm check:enums "<uri>"` against the hosted database, then the trigger test above.

### 4. The onboarding gate fails closed and is not wired

`src/middleware.ts` cannot answer whether setup is complete — the answer lives in
`profiles.onboarding_step` and no database is reachable. It therefore **refuses**: without
`ONBOARDING_GATE_BYPASS=1` it throws on every route outside `/onboarding`, `/settings` and
`/api/webhooks`.

This is the inverse of where it started. The first version returned `true` unconditionally,
which meant forgetting to wire the real check would leave the app permanently unguarded
with nothing ever surfacing the omission. A setup gate that defaults open when
unconfigured is backwards.

Two consequences to know before they surprise you:

- **A deployed preview will 500 on every app route** until 1c wires the check. That is the
  gate working. `/onboarding` and `/settings` still serve, which is the correct surface for
  someone who has not finished setup.
- **The bypass must never be set on Vercel or Trigger.dev.** A deployment with it set has
  no gate. It exists so local development is possible, and nothing else.

**To close:** implement the `profiles.onboarding_step` read and *delete the bypass branch*
rather than leaving it as a fallback. A bypass that outlives its reason is a backdoor with
a comment on it.

### 5. The Higgsfield driver surface

Not written yet, but the interface in `src/lib/drivers/types.ts` encodes assumptions taken
from reading the SDK rather than from calling it — chiefly that webhooks carry a shared
secret in a header rather than a signature, that `withPolling` must be explicitly disabled,
and that cancel is best-effort. See 0004.

## Gates, and where each can run

| Gate | Runnable in this environment? |
|---|---|
| 1 — design system | Yes. Needs no network. |
| 2 — driver interfaces | Yes. Done. |
| 3 — first real ElevenLabs response | Only if `api.elevenlabs.io` is opened. TTS is synchronous, so no callback is needed. |
| 4 — first real Higgsfield generation | **No.** Replies by webhook and needs a publicly reachable callback URL. Run against a Vercel preview deploy. |
| 5 — guided first video end to end | **No.** Same reason, plus it spans every vendor. |

## Closing this file

Delete it when all five sections are verified and the results are recorded. Until then,
treat anything it lists as a plausible implementation rather than a working one.
