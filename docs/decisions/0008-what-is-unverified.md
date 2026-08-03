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

### 0. ~~CI has never run a single check~~ — RESOLVED, and it was every push

This one belongs at the top because it invalidates a claim made in every commit message
since the first: that CI enforces anything.

**It never ran.** 25 consecutive failures, runs 1 through 25, from the Phase 1 scaffold
(`1d524c4`, 13:03) to the pg swap (`d197d91`, 19:51). Every run died at the same step:

```
Run pnpm/action-setup@v4
  Error: No pnpm version is specified.
  Please specify it by one of the following ways:
    - in the GitHub Action config with the key "version"
    - in the package.json with the key "packageManager"
```

The shape is visible without reading a single log: every run lasted 29–47 seconds, which
is a Postgres service container starting, a checkout, and an immediate failure. Nothing
after `pnpm install` ever executed. Not the vendor-isolation rule, not the enum check, not
the drift check, not `check:catalog`, not the build.

**What that means for everything already claimed.** Nothing recorded in this file was
proven by CI, only by local runs against a real Postgres. Those runs happened and their
output is quoted, so the checks are not fiction — but "CI enforces CLAUDE.md rule 1", in
the first commit message and repeated since, was false the whole time. A green badge was
never present to contradict it, and nobody looked.

**The second failure was hiding behind the first**, which is the part worth remembering.
`pg` had been moved between dependency groups by editing `package.json` directly, leaving
`pnpm-lock.yaml` stale; `pnpm install --frozen-lockfile` would have failed on the very
next step. A pipeline that fails at step one hides every later defect, and each fix
reveals the next — so "fixed the CI failure" is never the same claim as "CI passes".

**Resolved by:** `packageManager: pnpm@10.33.0` in `package.json` rather than a `version:`
pin in the workflow, so corepack and the action read the same number; the lockfile
regenerated; and the action majors moved to the node24 runtime (`checkout@v7`,
`setup-node@v7`, `pnpm/action-setup@v6` — all verified against their published
`action.yml`, since the v5/v6 majors I would have guessed at do not all exist).

**Verified before pushing:** every CI step run locally in order against a database created
to match the service container, including `install --frozen-lockfile` and a build with
CI's environment and nothing else.

**Run 27 (`17e22cd`) is green** — all 15 steps, no skips, 1m50s. So:

> **`17e22cd` is the first commit in this project whose checks actually ran.**

Everything before it carries a weaker guarantee than its commit message claims. The
checks were real and their local output is quoted throughout this file, but between
`1d524c4` and `ed6c945` nothing was *enforced*: a violation would have been merged and the
badge would have looked the same, because it was already red for an unrelated reason. When
reading any earlier commit message in this repository, read "CI enforces X" as "X was run
locally by the author". From `17e22cd` onward it means what it says.

The vendor-isolation rule is the one to care about. It caught five real violations during
this session, every one of them found because I ran it by hand. From here it catches the
sixth without my cooperation.

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
proves that much, locally. It is *configured* to run in CI and, until run 26, never once
did: see §0. Read every "runs in CI" in this file as "is wired to run in CI" for anything
dated before that.

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

### 5b. Replay protection and the integrity alert

Added after the observation that the runbook's step 4 tested forgery twice and replay not
at all. What is proven and what is not divides cleanly along the transport.

**Proven, against a real Postgres.** The SQL. A generation was inserted, a delivery
recorded, `confirm_generation_once` called and returned true; a second delivery was
recorded and the same function called again with a hostile payload
(`'failed'`/`'forged'`). It returned **false**, and the row still read `succeeded` with a
null `error_code` — the attacker's write did not land. `webhook_deliveries` reached 2,
`webhook_received_at` did not move while `webhook_last_received_at` did, and the job
appeared in `v_replayed_callbacks` with an 87 ms spread. Separately, a terminal row
inserted with a null `confirmed_at` appeared in `v_unconfirmed_terminal_generations`, so
the forgery view detects the shape it claims to.

**Not proven: anything above the SQL.** `confirmAndIngest` calls these through supabase-js,
which talks to PostgREST rather than to Postgres, and there is no PostgREST here. So the
RPC call shape — argument names, the `Array.isArray` unwrap of a table-returning function,
whether `data === true` is how a scalar boolean arrives — is read off the generated types
and the PostgREST contract, not observed. The same applies to `IntegrityAlert`: its two
`count: 'exact', head: true` queries have never executed. It typechecks and builds; that is
all.

The failure mode if the RPC shape is wrong is safe rather than silent — `confirm.ts` throws
on an RPC error and the route logs `confirmation_failed` — but it would mean no generation
ever confirms, which is a Gate 4 blocker discovered at the worst moment.

**To verify:** step 4 of the runbook, all three attacks. The third one is the new one.

### 5c. Ingest and rough cut — RUN, and what that did not cover

Both were executed here against real ffmpeg 6.1.1 and a real Postgres. What follows is
the boundary of that, because two of these paths have a piece nothing local can reach.

**Ingest — `pnpm verify:ingest "$DATABASE_URL"`.** Three synthetic clips, deliberately
nothing alike: 1920x1080@24 h264 with audio, 720x720@60 mpeg4 with none, 540x960@29.97
vp9/yuv444. All three normalised to 1080x1920@30 h264/yuv420p. A file that is not a video
wrote `error_code = normalise_failed` and **no** `assets` row. A generation with a null
`confirmed_at` was refused before any fetch. The clips were served over real HTTP from the
harness, so the code performed a genuine network fetch rather than being handed a path.

**Not covered:** the vendor's own URL. That is the only simulated step in the path, and it
is simulated by an HTTP server rather than mocked away.

**Rough cut — `pnpm verify:assemble "$DATABASE_URL"`.** Six clips of five different shapes
concatenated to one 10.05s MP4 against 10.03s expected, 301 frames decoded against 301
predicted — every frame, not just the header. A set with one non-normalised clip was
refused, and the refusal names the clip and both shapes. The harness then forced the same
concat past the guard to show what the refusal prevented: 8.55s instead of 10.03s, a file
that plays and is wrong.

**Not covered:** assembling from an object store. ffmpeg reads files, so that needs each
asset downloaded to the container first, and `07-assemble` throws rather than pretending
otherwise for any driver but `local-fs`.

**The `local-fs` driver** is new and is the second implementation of `StorageDriver`. It
exists so these paths could run at all; it refuses to construct without an explicit root so
it cannot be selected by accident. Writing it found no fault in the interface, which is
itself a small result.

**Never executed:** the Trigger tasks under Trigger's runtime, the ffmpeg build extension,
and the deploy. See 0010.

### 5d. The bucket assemble path — RUN. The ffmpeg build extension — NOT.

**Run.** `07-assemble` used to throw for any driver but `local-fs`, so the production path
had never executed. It now downloads every clip through `presignGet` and a plain `fetch`,
assembles, and pushes the render back through `presignPut` — and that whole leg was
exercised against **s3rver**, a real S3-compatible server, using the real Supabase driver
with only the endpoint changed. `pnpm verify:assemble` now reports:

```
  PASS  s3 round trip through the real driver
  PASS  six clips uploaded through presigned PUT
  PASS  renders row — kind=rough_cut status=ready 10.05s
  PASS  render read back from the bucket — 10.05s, 1599kB, canonical
  PASS  missing object refused — presigned GET returned 404
  PASS  failure is a row — renders.status = 'failed'
  PASS  temp cleanup — no kiln-assemble-* directories left behind, success or failure
```

The download goes through the presigned URL rather than the SDK deliberately. A worker
holding the service key could read objects directly and that would be simpler — and the
presign path could then be broken for weeks while every worker kept working, discovered the
first time somebody opened a review screen. Same door, so they stay honest about each other.

**Not run: the ffmpeg build extension.** `trigger.config.ts` now declares
`build: { extensions: [ffmpeg()] }` and `@trigger.dev/build` is installed. Exercising it
means running a deploy, which needs an account this environment does not have.

> **Symptom if it is wrong or missing:** `05b-ingest` fails with `spawn ffmpeg ENOENT` on
> its first run — **after** the generation has been paid for. The generation row records it,
> so nothing is lost beyond the wait and the credits.

Declared rather than omitted on purpose: a config error surfaces at build time and costs a
minute, a runtime error surfaces after money moved. That is the cheaper of the two failures
even though neither has been observed.

**Duration is now asserted in the task, not only the harness.** `runAssemble` compares the
render against the sum of its shots' recorded asset durations and writes a **failed** render
on a disagreement. That is a stronger check than the one inside `assembleRoughCut`, which
compares against the files it was handed: six identical files probe as six identical
durations, so the input-sum check passed while the cut was one shot repeated six times.
Exercised — a script whose six assets all point at one object is refused with
`Render is 9.22s but its 6 shots sum to 10.03s`.

Three bugs in this area have now produced a file that plays: a mismatched codec set, a
dropped segment, and the basename collision. Duration caught all three and nothing else
caught more than one.

**Also not run:** clock skew. The 403 branch in `materialise` says signature windows are the
usual cause, which is read from the SigV4 spec rather than observed — s3rver and this
container share a clock.

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

### 7. The Studio lane — RUN, except the one leg that needs a public hostname

**Run.** `pnpm verify:studio "$DATABASE_URL"` creates a scratch database, applies all
seventeen migrations to it, stands the MCP server up behind a real `node:http` socket, and
drives it with real HTTP requests against the *same* `serveMcp` the Next route calls. Thirty
checks, repeatable:

```
2. The MCP protocol over real HTTP
  PASS  initialize — protocolVersion=2025-06-18
  PASS  advertises tools only — the connector calls tools/list and tools/call and nothing else
  PASS  a notification gets no response — 202, empty body
  PASS  a batch drops the notification — 3 in, 2 out
3. Authentication
  PASS  no token is refused
  PASS  a forged signature is refused
  PASS  a valid signature over an unknown session is refused
  PASS  a stopped session refuses its own token
4. The six tools against a real database
  PASS  generate_shot refuses on an untouched workspace — 2 things must be true first
  PASS    · names the unverified video integration
  PASS    · and the empty prompt library
  PASS  a refused generation writes nothing — no script, no shot
6. The spend cap stops the session
  PASS  the next turn is refused before any model call
  PASS  the session is capped, in a row
  PASS  its token stops working at the MCP server
  PASS  the cost rows survive the stop — nothing is rolled back
```

Three of those are worth naming individually.

**The refusal is the expected outcome, and it is a result rather than an error.**
`generate_shot` on a fresh install returns `{ refused: true, blockers: [...] }` listing
*every* closed gate — an unverified video integration and an empty prompt library — not the
first one hit. Refusing on credentials and then, one paid turn later, on the library is half
an answer for the price of a whole one. Nothing is written: no concept, no script, no shot.

**The cap stops before the model call, not after it.** A session already at its ceiling
cannot buy one more turn to discover that it is at its ceiling. Exercised with no API key
present at all, which is itself the proof: the pre-call check fired before anything reached
the network.

**The number the cap is enforced against is derived, not asserted.** 0017 makes
`studio_sessions.cost_inr`, `input_tokens` and `output_tokens` trigger-derived from
`cost_ledger`. The harness hand-edits the total to zero and shows the next ledger row
correcting it. A spend cap enforced against a counter the spender maintains is not a control.

**NOT RUN — and this is the whole of what is missing.** The Messages API's `mcp_servers`
connector is **server-side**: Anthropic's infrastructure opens the HTTP connection to the
MCP server URL. The client that called the Messages API does not. Addendum 01 §2 constraint
3 says "no local servers", and the requirement it is really stating is that the URL be
reachable *from Anthropic* — not from the process making the call. This container has no
public hostname, so that one socket cannot be opened here by any arrangement of local
wiring.

What the harness does instead is stated plainly rather than papered over. Section 7 runs the
real model against the real MCP server over a **bridge**: the same six tool objects declared
as ordinary tools, executed by this process by POSTing `tools/call` to the same
`/api/mcp` handler over real HTTP. Real Anthropic API, real MCP server, real protocol, real
rows. The only substituted component is *which machine dials the socket*.

> **Symptom if the connector leg is wrong:** the first production turn returns a
> `mcp_tool_result` with `is_error` and a connection failure, or a 400 from the Messages API
> before any tokens are spent if the `mcp_servers` / `mcp_toolset` pair is malformed. Both
> are cheap and both are loud. The expensive failure mode — spending money and getting
> nothing — is not available here, because the tools that spend money all refuse first.

**Also not run: section 7 itself.** No `ANTHROPIC_API_KEY` was present in the container the
lane was built in, so the live turn is skipped with a message saying what it would prove.
Re-run with a key set and it executes: one real Opus 5 turn, the tool calls it makes, the
refusal surfaced as a refusal, the transcript stored, and the two ledger rows. Until that
has run, the parts of the lane that are proven are everything below the model call and
nothing above it.

**Also not run: `stitch_rough_cut` reaching the worker.** It refuses correctly when there is
nothing to stitch, which is what the harness exercises. Enqueuing to Trigger.dev needs the
deploy in `0010-trigger-deploy.md`.

## Gates, and where each can run

| Gate | Runnable in this environment? |
|---|---|
| 1 — design system | Yes. Needs no network. |
| 2 — driver interfaces | Yes. Done. |
| 3 — first real ElevenLabs response | Only if `api.elevenlabs.io` is opened. TTS is synchronous, so no callback is needed. |
| 4 — first real Higgsfield generation | **No.** Replies by webhook and needs a publicly reachable callback URL. Run against a Vercel preview deploy. |
| 5 — guided first video end to end | **No.** Same reason, plus it spans every vendor. |
| Studio connector — Anthropic fetching `/api/mcp` | **No.** Needs a public hostname. Run against a Vercel preview deploy with `STUDIO_MCP_TOKEN_SECRET` set. |

## Closing this file

Delete it when every section is verified and the results are recorded. Until then,
treat anything it lists as a plausible implementation rather than a working one.
