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

**Still never executed against Supabase Vault.** The write path now exists — migration
0007's three SECURITY DEFINER wrappers, and `src/lib/integrations/vault.ts` above them —
and the *wrappers* have been exercised against a stand-in schema with Vault's exact
function signatures on a local Postgres. That proves my SQL: three secret fields become
three rows with three separate `last_4` values, the plaintext survives the round trip,
rotation replaces in place and stamps `rotated_at` without adding a row, an empty value is
refused, and a delete removes the pointer and the vault row together.

It proves nothing about Supabase's encryption, because `supabase_vault` is not installable
on this machine — `pg_available_extensions` lists only `pgcrypto`. The third check in the
script below is still the one that matters and still has not run.

What *has* been proven, and is the part I would most want checked if I were reading this:
the grant. With the Supabase roles present, `anon` and `authenticated` have EXECUTE on
neither `integration_secrets_read` nor `integration_secret_put`, and no SELECT on
`integration_secrets`; `service_role` has all three. Verified by `has_function_privilege`
and then by actually running `set role anon; select * from integration_secrets_read(...)`,
which is refused with "permission denied for function". With no RLS in Phase 1 that grant
is the whole security model — a grant to `anon` would put every vendor credential one
fetch away from anyone who loaded the page, since the anon key is in the client bundle.

Everything in the settings design depends on Vault working, because every vendor
credential ends up there. `scripts/verify-vault.mjs` checks four things in order: the `supabase_vault`
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

Migrations 0001–0007 have only ever been applied to a local Postgres 16. They apply
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

### 3a. ~~`db push` produces a database the wizard cannot be walked on~~ — RESOLVED in 0014

Found while the first `supabase db push` was running, and it would have blocked the wizard
at step 2 with an error that named the wrong cause.

`db push` applies migrations. It does not apply `supabase/seed.sql` — that runs on
`db reset`, and its own first line said it "never runs against production". Four of the
five catalogue integrations lived only in that file, and the application never creates
them: `configureAndVerify` and `verifyIntegration` both look the row up by slug and
*throw* when it is absent. It is a lookup, not an upsert.

Measured, not reasoned about — 0001–0013 applied to an empty database with no seed:

| Table | After a migrations-only apply |
|---|---|
| `integrations` | `elevenlabs` only — from 0004, which used a migration |
| `driver_health` | empty |
| `rate_card` | `anthropic` (0006) + `elevenlabs` (0004); no video placeholders |

So steps 2 (storage), 3 (LLM) and 4 (video) each threw "this database has not been
seeded". Step 5 (audio) worked, by the accident of 0004 having put its integration row in
a migration while the rest went to the seed. That inconsistency is the tell: this repo had
already demonstrated the right placement once and not followed it.

**Which of the two kinds: evolution.** No document specified these rows as seed data and
then required them elsewhere on its own page — this is not the `cost_ledger_has_subject`
shape. They were fixture data behind a settings screen that rendered fixtures, and they
became a precondition the day the onboarding Server Actions began reading them by slug.
The second case that tested the original decision was a hosted deployment, which is the
first environment where "local-only" and "required" could contradict each other.

The rule it settles: **a row the application requires in order to function belongs in a
migration, in every environment.** `seed.sql` is for local convenience and nothing else.
One row survives there — a dev channel — and it passes that test, because onboarding step
8 creates a real channel itself.

The duplication between `INTEGRATION_CATALOG` and the migration is real and is what
produced the bug, so it is now checked rather than remembered: `pnpm check:catalog`
applies the migrations to a scratch database — no seed — and fails if any catalogue slug
has no row, or has one with the wrong `kind`. Both failure modes were provoked
deliberately before the check was trusted.

**Verified:** migrations-only apply now yields 5 integrations, 2 `driver_health` rows and
10 `rate_card` rows; `check:catalog`, `check:drift`, `pnpm check` and `pnpm build` all
pass. **Not verified:** that the hosted project has had 0014 pushed. Re-run
`supabase db push` before walking the wizard.

### 3b. The onboarding step actions have never called a vendor

Steps 1, 2, 3, 6 and 8 are Server Actions writing rows this codebase controls, and their
logic has been read but not run. Steps 4 and 5 additionally depend on vendor hosts that
this environment refuses.

Specifically unproven:

- **The storage round trip.** Same two vendor-specific details as §2 — `forcePathStyle`
  and the S3 keys being a separate credential from the service-role key. The wizard now
  drives that probe with credentials read from Vault rather than the environment, which is
  a second thing to be wrong.
- **The voice probe's two endpoints.** `/v1/voices` and `/v1/user/subscription` are read
  from the vendor's documentation and have never been called from here. If the
  subscription response shape differs, step 5 fails on a required check and the plan tier
  — which the queue reads as its concurrency ceiling — is never stored.
- **The video probe** calls `getMotions()`, which is the cheapest authenticated read the
  SDK actually exposes. It does **not** read the credit balance, because the v2 client has
  no account or balance surface at all. That check is reported as failed-informational
  with an explanation rather than guessed at; the ~90-day credit clock is not being
  watched by anything, and the screen says so.
- **`profiles.id = auth.users.id`.** Step 1 writes the profile against the session user's
  id and there is no FK to enforce the correspondence (§3). If it does not hold, the gate
  reads a row that is not the signed-in user's.

**To verify:** walk the wizard on the preview. That is the whole point of it.

### 4. ~~The onboarding gate fails closed and is not wired~~ — RESOLVED

**Resolved.** `src/middleware.ts` reads `profiles.onboarding_completed_steps` through a
session-scoped Supabase client and compares it against the required set, and
`ONBOARDING_GATE_BYPASS` is gone — the variable, the branch, and the line in
`.env.example`. It was deleted rather than kept
as a fallback: a bypass that outlives its reason is a backdoor with a comment on it, and
this one would have been the only thing standing in front of a public preview URL with
live vendor credentials behind it.

The gate still fails closed, now for a better reason. No profile row, an unreadable
database, a query that errors — every one of them means "cannot confirm setup is
complete" and routes to the wizard rather than to the app. What changed is that a correct
answer now exists and is reachable.

Two things landed with it:

- **Auth is an allowlist, not "is authenticated".** A Supabase project accepts signups
  from anyone by default, so a session proves only that someone typed an address. Every
  request is checked against `ALLOWED_EMAIL`, so revoking access is a config change rather
  than a session-expiry wait. `signInWithOtp` is called with `shouldCreateUser: false` and
  the allowlist is checked three times — before the link is sent, when the code is
  exchanged, and on every subsequent request.
- **`getUser()`, never `getSession()`.** `getSession()` reads the cookie and trusts it.
  The gate verifies with the auth server instead; a gate that trusts a value the client
  controls is not a gate.

A second failure of the same kind was found and fixed afterwards: the gate *threw* on
missing configuration, which took down `/login` with everything else and made a
half-configured deploy indistinguishable from a bug. It now returns a 503 naming the
absent variables. Verified against production builds in three states — no config (503
everywhere except `/login`, which serves; `/api/webhooks/*` uninterceptable; no value
anywhere in the page), partial config (names only the one that is missing), and config
without a session (307 to `/login`). Fail closed means deny, not crash.

**Still unverified, and this is what the preview deploy tests:** none of it has run
against a real Supabase project. Specifically unproven — that the anon key can read
`profiles` at all (no RLS policies exist, so it should, but "should" is doing work there),
that `profiles.id` actually equals `auth.users.id` in practice given there is no FK
(§3), and that the magic-link round trip lands on `/auth/callback` with a usable code.
Walking the wizard on the preview is the test.

### 4b. Stage 6 has never called the voice vendor

`api.elevenlabs.io` is refused by this environment's egress policy, so every shape in
`src/lib/drivers/audio-tts.ts` is read from documentation. What is unproven, in order of
how likely it is to be wrong:

- **The response shape.** `normalized_alignment` with three parallel arrays. If the real
  field is named differently or nested, the Zod parse fails and stage 6 returns
  `bad_response` rather than producing wrong timings — which is the correct failure, but it
  is still a failure that only a real call reveals.
- **`request-id` as a response *header*.** Stitching depends on it entirely. If it arrives
  in the body instead, every chunk becomes an independent generation and the voice drifts
  mid-script — and that failure is silent, because nothing errors.
- **The error strings.** `too_many_concurrent_requests` and `system_busy` are mapped to
  different dispositions (queue versus jittered backoff) and matched by regex against the
  response body. A different spelling collapses both into `upstream`, which backs off when
  it should queue.
- **The character caps.** 5k for `eleven_v3`, 10k for `eleven_multilingual_v2`. Chunking
  refuses to exceed them, so a wrong cap means either rejected requests or chunks smaller
  than they need to be.

What *is* proven is the part that does not need the vendor. `pnpm test:timings` exercises
the character→word converter and the shot-duration derivation across sixteen cases: word
boundaries, whitespace belonging to no word, mismatched array lengths throwing rather than
pairing silently, offsets across a chunk seam, a silent shot keeping its authored duration,
and a drifted span falling back rather than collapsing to zero. It also asserts the schema
**rejects** a response carrying only the raw `alignment` — on the fixture's own numbers,
timings drawn from the raw alignment put a shot boundary 0.4s early on a line containing a
currency substitution.

Two of those tests failed on first run. Both were wrong expectations of mine, not wrong
code — which is the argument for having written them.

The fixture in `src/lib/voice/__fixtures__/` is **hand-built from documentation, not
captured.** Its README says so, and replacing it is the verification.

**To verify:** with a key in `.env.local` and the host reachable,

```
curl -s -X POST \
  "https://api.elevenlabs.io/v1/text-to-speech/<voice_id>/with-timestamps" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "content-type: application/json" \
  -d '{"text":"GTA cost $5.","model_id":"eleven_v3"}' \
  -D headers.txt -o src/lib/voice/__fixtures__/documented-shape.json
grep -i '^request-id' headers.txt   # proves the stitching assumption
pnpm test:timings                    # must pass unchanged against the real response
```

If `test:timings` fails against a captured response, the converter was written against a
fiction and the failing assertion names which part.

### 5. Stage 3 has never called the model

`src/trigger/03-script.ts` and everything under it — the prompt, the schema, the structure
hash, the ledger write — is written and has never made a request. There is no
`ANTHROPIC_API_KEY` in this environment. That is the *only* thing missing:
`api.anthropic.com` answers here (401, so the host is reached and the request is
unauthenticated), which makes this the one vendor leg that a key alone would unblock.

What has been proven, and it is not nothing:

- **The schema catches what a constrained decode cannot.** Nine cases run against the real
  compiled schema: a beat silently dropped from `vo_text`, a missing hook, non-monotonic
  timestamps, a stage direction that would be read aloud, beat counts outside 3–5, a null
  CTA (legal), and `vo_text` repunctuated relative to the beats (also legal). All nine
  behave.
- **The structure hash survives word substitution.** Rewriting every word of a script —
  hook, all four beats, CTA — produces the *same* hash. Changing the beat count or the
  pacing produces a different one. That is the anti-template guard doing the job §0.2 of
  ARCHITECTURE.md gives it; a hash that changed with the words would call the same video
  made twelve times "unique", which is the claim the policy disbelieves.
- **The ledger constraints hold against real rows.** Charging one script twice is rejected
  by `cost_ledger_script_entry_key`; replaying a failed draft is rejected by the
  idempotency key; a row with no subject is rejected by `cost_ledger_has_subject`; and
  `v_script_cost` attributes a failed draft to the concept's first script version exactly
  once (₹1.3275 on v1, ₹1.3275 on v2 in the worked case, not ₹1.77 on both).

What is unproven is everything downstream of an actual response: whether the model returns
this schema reliably, what a real draft reads like, what the real token counts and
therefore the real cost per script are, and whether `stop_reason: 'refusal'` and
`max_tokens` are handled correctly in practice rather than in principle.

**To verify:** `ANTHROPIC_API_KEY=… pnpm verify:script`. It runs `runScriptDraft` — the
same function the Trigger task calls, not a copy — against a real Supabase project, and
prints the generated script and the cost rows it reads back from the database. It has no
offline mode on purpose.

One rate card note that belongs here: the two `anthropic` rows are the **only**
`is_verified` rows in the table, and the reason is narrow — the vendor publishes the
number. Every video and voice rate stays unverified until someone watches a credit balance
move, because nobody publishes those.

### 6. The Higgsfield driver surface

Not written yet, but the interface in `src/lib/drivers/types.ts` encodes assumptions taken
from reading the SDK rather than from calling it — chiefly that webhooks carry a shared
secret in a header rather than a signature, that `withPolling` must be explicitly disabled,
and that cancel is best-effort. See 0004.

### 6. Stage 5 — every part of it

Submit, callback, confirmation and ingest are all written and none has run. The vendor host
is refused here and a webhook cannot reach a sandbox, so this is the leg with the least
evidence behind it in the whole project.

Unproven, in order of how much rests on it:

- **The confirmation is the security control and has never been exercised.** The callback
  carries a shared secret rather than a signature, so a leaked secret forges a completion.
  The only thing preventing a forged completion from landing an asset is that the status
  URL is *constructed* in `drivers/video-status.ts` from our own stored job id, never taken
  from the request. Steps 4 and 6 of the Gate 4 runbook exist to break this deliberately.
- **The status vocabulary.** `confirm.ts` matches the vendor's status strings with regexes
  read from documentation. A different spelling leaves a confirmed generation stuck at
  `queued` — visible, at least, rather than silently wrong.
- **`/v1/job-sets/{id}` as the status path**, and `results.raw.url` as the asset location.
- **Ingest is not wired at all**, and says so: `confirmAndIngest` returns the URL and marks
  the enqueue `TODO(gate-4)`. A generation that succeeds with no `assets` row is the
  expected state at this gate, not a bug.
- **The ffmpeg normalisation has never been executed.** h264 / yuv420p / 1080x1920 / 30fps,
  scale-then-pad rather than crop. Runs in a Trigger container this environment cannot reach.

**To verify:** walk `docs/decisions/0009-gate-4-runbook.md`. It is written step by step
with what each should produce and what a failure at that point means, because three of
those failures look identical from the outside and have different causes.

## Gates, and where each can run

| Gate | Runnable in this environment? |
|---|---|
| 1 — design system | Yes. Needs no network. |
| 2 — driver interfaces | Yes. Done. |
| 3 — first real ElevenLabs response | Only if `api.elevenlabs.io` is opened. TTS is synchronous, so no callback is needed. |
| 4 — first real Higgsfield generation | **No.** Replies by webhook and needs a publicly reachable callback URL. Run against a Vercel preview deploy. |
| 5 — guided first video end to end | **No.** Same reason, plus it spans every vendor. |

## Closing this file

Delete it when every section is verified and the results are recorded. Until then,
treat anything it lists as a plausible implementation rather than a working one.
