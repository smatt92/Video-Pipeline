# Kiln

AI video content pipeline. Trend → concept → script → shots → generate → assemble →
review → publish → measure.

**Current phase: 1 — the generator.** You paste a concept, and generated shots appear in
a grid with the rupee cost under each. No assembly, no publishing, no trend automation.
See `docs/ROADMAP.md`.

Read `CLAUDE.md` first. `docs/ARCHITECTURE.md` is the reasoning, `docs/SCHEMA.sql` is the
data shape, `docs/decisions/` records every place the code deviates from them and why.

## Setup

```bash
pnpm install
cp .env.example .env.local     # then fill it in — every variable is required
pnpm db:start                  # local Supabase (needs Docker)
pnpm db:reset                  # apply migrations + seed
pnpm db:types                  # regenerate src/lib/db/types.ts
pnpm dev
```

The app refuses to start with a missing or malformed environment variable and prints
every problem at once. That is deliberate: a half-configured pipeline spends real money
before it discovers what it is missing.

### Without Docker

`supabase start` and `supabase gen types` both need Docker. Against a plain Postgres:

```bash
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/kiln
pnpm db:push                        # applies migrations, records them, safe to re-run
psql "$DATABASE_URL" -f supabase/seed.sql   # or paste it; the seed is local-only
pnpm db:types:nodocker
```

See `docs/decisions/0005-type-generation-without-docker.md`.

## When something is wrong

```bash
pnpm db:doctor
```

Runs the environment checks in dependency order and names the one that is actually
broken: connection string, reachability, Vault, which migrations are applied, enums,
and whether the rows the wizard needs exist. Every failure in this project so far has
looked like three other failures until something distinguished them; this is that thing.

Exit codes: `0` all passed · `1` something failed · `2` something could not be checked.

### Applying migrations when the CLI will not

`supabase db push` needs the CLI, a login, and an open Postgres port. Two ways around it,
neither of which needs Docker or the CLI:

```bash
pnpm db:push                        # over DATABASE_URL, using the pg client
pnpm db:push --dry-run              # what it would apply, applying nothing
pnpm db:bundle                      # one .sql file to paste into the browser
```

Both write the same ledger the CLI uses — `supabase_migrations.schema_migrations` — so
a CLI that starts working later reads that history as its own and reports the project up
to date rather than replaying everything.

`db:push` applies each migration and its ledger row in **one transaction**. Postgres has
transactional DDL, so a failure leaves nothing behind and the ledger can never claim a
migration that did not land. It stops at the first failure and prints what it applied and
what it skipped.

`db:bundle` is the path that always works: it imports nothing from `node_modules` and
needs no open database port, only the browser, which reaches Supabase over 443 like any
other site. If `pnpm db:doctor` says the connection times out or has no route, stop
diagnosing the network and paste the file. The whole bundle is one transaction with a
guard at the top, so pasting it twice raises a plain-English error and rolls back rather
than half-applying.

**If the schema exists but nothing is recorded** — someone pasted SQL into the editor —
re-running fails on `already exists`, and the fix is the opposite of the usual one:

```bash
pnpm db:push --baseline 0001,0002   # record as applied WITHOUT running
```

`pnpm db:doctor` detects this case and says so. Confirm with it before baselining: a
baselined migration that never actually ran leaves a database claiming to be somewhere it
is not.

**Which connection string.** Use **Session mode** from Project Settings → Database →
Connection string — host ends `.pooler.supabase.com`, port 5432. It is IPv4 and safe for
schema changes. The direct `db.<ref>.supabase.co` host is IPv6-only on current projects,
which is what breaks most laptops, and port 6543 is the transaction pooler, which is for
application traffic rather than DDL. `pnpm db:doctor` warns about both.

## Checks

```bash
pnpm check                          # vendors + NEXT_PUBLIC_ guard + typecheck + lint
pnpm check:vendors                  # CLAUDE.md rule 1, the one with teeth
pnpm check:public-env               # only two vars may be client-published
pnpm check:enums "$DATABASE_URL"    # hand-written enums vs live CHECK constraints
pnpm check:drift "$DATABASE_URL"    # migrations ↔ committed types
pnpm check:catalog "$DATABASE_URL"  # every catalogue integration has a row after a push
```

`check:public-env` also runs as `prebuild`, so it fires on every `pnpm build` — locally,
in CI, and on Vercel where it sees the real deployment environment.

Against the hosted project (not runnable in CI — they need real credentials):

```bash
pnpm verify:vault                   # extension → create → read back → delete
pnpm verify:storage                 # presign PUT → upload → read back → delete → gone
```

`pnpm check:vendors` fails if a vendor name appears anywhere in `src/` outside
`src/lib/drivers/`, `src/lib/publish/` and `src/lib/storage/`. When it fires, the fix is almost never to move
the string — it is that the driver interface is missing something the caller needed.

## Layout

```
src/lib/drivers/      all generation-vendor code, and nothing else anywhere
src/lib/storage/      StorageDriver interface + the object-store implementation
src/lib/db/           generated types + enums; browser.ts vs server.ts
src/trigger/          pipeline stages, numbered 01–11
src/app/              control plane only — IDs and URLs, never media bytes
supabase/migrations/  forward-only
```

## Three things that will bite you

1. **No media bytes through a Vercel route.** 4.5 MB hard cap, not configurable. Browser
   ↔ bucket by presigned URL; worker ↔ bucket direct. `src/lib/storage/` hands out URLs
   and nothing else — the vendor behind it is a config value.
2. **`APP_URL` must be publicly reachable.** Vendors POST webhooks to it. Pointed at
   localhost, deliveries silently never arrive and every generation hangs until timeout.
   Use a tunnel in development.
3. **The cost row is written before the result comes back.** Cost-per-video cannot be
   backfilled. A submit that cannot be priced refuses to run rather than proceeding
   uncosted.


## Environment: two targets, two sets

Vercel and Trigger.dev do **not** share environment variables. Every variable has to be
set on both, or on exactly one, deliberately. A variable set on Vercel and forgotten on
Trigger.dev produces a control plane that works and a pipeline that fails on its first
real run.

Do **not** use the Vercel Marketplace Supabase integration — it injects its own variable
names, which collide with the ones below.

Do **not** put migrations in the Vercel build step. Applying schema is a deliberate
terminal action (`supabase db push`), not something that fires on every preview push.

### Vercel — the control plane

UI, auth, CRUD, enqueue, webhook receivers. Never touches media bytes.

| Variable | Environments | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All | Inlined into the client bundle |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | All | Inlined into the client bundle |
| `SUPABASE_SERVICE_ROLE_KEY` | **Production only** | Bypasses RLS. Never set in Development. |
| `APP_URL` | All | Preview URL on previews is fine |
| `WEBHOOK_CALLBACK_BASE_URL` | **Production only** | Must be the stable production domain — see below |
| `ALLOWED_EMAIL` | All | The single address permitted to sign in |
| `STORAGE_DRIVER` | All | |
| `SUPABASE_STORAGE_BUCKET` | All | |
| `SUPABASE_S3_ACCESS_KEY_ID` | All | Presigning happens server-side |
| `SUPABASE_S3_SECRET_ACCESS_KEY` | All | |
| `SUPABASE_S3_REGION` | All | |
| `TRIGGER_PROJECT_REF` | All | Enqueue only |
| `TRIGGER_SECRET_KEY` | All | Enqueue only |
| `USD_INR_RATE` | All | Bootstrap default; `profiles.usd_inr_rate` wins once set |
| `ANTHROPIC_API_KEY` | Production | Only if a route calls the LLM directly |
| `VIDEO_DRIVER` | All | Webhook route resolves the driver by slug |
| `HIGGSFIELD_WEBHOOK_SECRET` | Production | Needed to verify inbound webhooks |

`HIGGSFIELD_API_KEY` / `HIGGSFIELD_API_SECRET` / `FAL_KEY` are **not** needed on Vercel —
nothing there submits a generation.

### Trigger.dev — the pipeline

Orchestration, ffmpeg, Remotion, every vendor call. Deployed separately with
`npx trigger.dev@latest deploy`.

| Variable | Environments | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | All | Same value; the prefix is vestigial here |
| `SUPABASE_SERVICE_ROLE_KEY` | **Production only** | Workers write rows; RLS does not apply |
| `WEBHOOK_CALLBACK_BASE_URL` | **Production only** | Submitted to vendors with each job |
| `STORAGE_DRIVER`, `SUPABASE_STORAGE_BUCKET` | All | Workers write media directly |
| `SUPABASE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_REGION` | All | |
| `ANTHROPIC_API_KEY` | All | Scripts, shotlists, prompt compilation |
| `VIDEO_DRIVER` | All | |
| `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET` | All | This is where generations are submitted |
| `HIGGSFIELD_WEBHOOK_SECRET` | All | Sent with each submit |
| `HIGGSFIELD_API_BASE_URL`, `FAL_KEY` | Optional | |
| `USD_INR_RATE` | All | Ledger rows are written here |
| `DRIVER_TIMEOUT_MS` and the circuit-breaker vars | Optional | Defaults in `src/lib/env.ts` |

`ALLOWED_EMAIL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **not** needed on Trigger.dev —
there is no browser and no sign-in.

### Two rules that are easy to get wrong

**`SUPABASE_SERVICE_ROLE_KEY` must never be set in Development** on either target. It
bypasses row-level security completely, and a Development environment is where keys end up
in shell history and screenshots.

**`WEBHOOK_CALLBACK_BASE_URL` is not `APP_URL` and is not `VERCEL_URL`.** Preview
deployments get a new hostname per commit, so a webhook registered against one dies on the
next push — silently, because the vendor gets a DNS failure and you get nothing. Point it
at the production domain, or a tunnel locally.

---

## Signing in

Two doors, one lock. Both land on `/auth/callback` and both are refused by the same
`ALLOWED_EMAIL` check — an address Google vouched for gets no more trust than an address
that clicked a link in an inbox.

**Google** is the path that works today. **Magic link** stays alongside it and becomes
practical once a domain exists: Supabase's built-in mailer rate-limits to a handful of
sends per hour and custom SMTP needs a domain, which turns every auth test into an hour's
wait.

### Google Cloud Console

1. **APIs & Services → OAuth consent screen.** External. App name, support email,
   developer contact. Scopes: leave the defaults — `email` and `profile` are all that is
   read, and asking for more would put the app into a review process it does not need.
   While the app is in *Testing*, add both permitted addresses under **Test users**, or
   Google refuses them before Kiln ever sees them.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
   Application type **Web application**.
3. **Authorised redirect URIs** — this is the field that is easy to get wrong. It is
   **Supabase's** callback, not Kiln's:

   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```

   Not `https://your-app.vercel.app/auth/callback`. Google returns to Supabase, Supabase
   mints a code, and *then* the browser lands on Kiln's `/auth/callback`. Putting Kiln's
   URL here produces a `redirect_uri_mismatch` that reads as if Kiln is misconfigured.
4. Copy the **Client ID** and **Client secret**.

### Supabase dashboard

1. **Authentication → Sign In / Providers → Google.** Enable it, paste the Client ID into
   *Client IDs* and the secret into *Client Secret (for OAuth)*.
2. **Authentication → URL Configuration → Redirect URLs.** Add Kiln's callback:

   ```
   https://<your-deployment>/auth/callback
   ```

   This is the allowlist for where Supabase will send a browser afterwards. Without it the
   round trip completes and dumps the user on the Supabase host.
3. Nothing to add to Kiln's environment. The provider credentials live in Supabase; Kiln
   only ever asks Supabase to start the flow.

### What refusal looks like

A Google account that is not in `ALLOWED_EMAIL` completes the Google sign-in, is refused at
the callback, and lands on `/login?denied=not_allowed`. The session the exchange created is
destroyed on the way out: `signOut()` runs *and* every `sb-*-auth-token` cookie is expired
directly on the redirect response, including chunked ones. The two mechanisms fail
differently — one needs the network, the other does not — and the cost of either failing
alone is a stranger holding a live session.

Verified against a production build with a stand-in auth host: a permitted address gets a
session cookie and a redirect to `/`; a non-permitted one gets `denied=not_allowed`, no
session cookie, and any pre-existing session cookie expired. What is *not* verified is the
Google leg itself — that needs a real console project, and it is the part Google is
responsible for.
