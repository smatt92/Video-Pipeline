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
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
psql "$DATABASE_URL" -f supabase/seed.sql
pnpm db:types:nodocker
```

See `docs/decisions/0005-type-generation-without-docker.md`.

## Checks

```bash
pnpm check                          # vendor isolation + typecheck + lint
pnpm check:vendors                  # CLAUDE.md rule 1, the one with teeth
pnpm check:enums "$DATABASE_URL"    # hand-written enums vs live CHECK constraints
```

`pnpm check:vendors` fails if a vendor name appears anywhere in `src/` outside
`src/lib/drivers/`, `src/lib/publish/` and `src/lib/storage/`. When it fires, the fix is almost never to move
the string — it is that the driver interface is missing something the caller needed.

## Layout

```
src/lib/drivers/      all generation-vendor code, and nothing else anywhere
src/lib/storage/      StorageDriver interface + the object-store implementation
src/lib/db/           generated types + enums + clients
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
