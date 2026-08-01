# 0007 — Supabase Storage instead of Cloudflare R2, behind a StorageDriver

**Date:** 2026-08-01
**Status:** accepted
**Reverses:** `docs/ARCHITECTURE.md` §1 and §2, `CLAUDE.md` stack line, Addenda 01–03
(every mention of R2)

## Context

ARCHITECTURE.md §1 picked R2 for zero egress fees, on the reasoning that egress on video
bites. That reasoning is sound at volume and premature at Phase 1: the pipeline currently
generates a handful of clips a day, watched by one person, and the egress bill for that is
not a number anyone will notice. What R2 did cost was a second vendor, a second set of
credentials, and a second thing to configure before the first video can exist.

Supabase is already the database, the auth provider and the Vault. Its Storage product
speaks the S3 protocol, so the presigned-URL flow the architecture depends on works
unchanged.

## Decision

Phase 1 stores media in Supabase Storage, accessed over its S3-compatible protocol.

The object store moves behind an interface — `src/lib/storage/`, exporting `StorageDriver`
with `presignPut`, `presignGet`, `delete` and `probe`. The vendor's name lives in the
implementation (`supabase.ts`), never in the module path, so a future swap back to R2 or
onward to B2 or MinIO is one new file and one env var.

`src/lib/storage/` joins `src/lib/drivers/` and `src/lib/publish/` on the CI
vendor-isolation exclusion list, for the same reason they are on it: it is the one place
allowed to know who the vendor is.

## What did not change

**The 4.5 MB rule.** Media bytes still never pass through a Next.js route — browser to
bucket by presigned PUT, worker to bucket direct. That constraint comes from Vercel's
infrastructure, not from the storage vendor, and swapping vendors does nothing to it.

**Onboarding step 2.** Still "Storage", still gates everything downstream, still a real
round trip: write an object, read it back, compare the bytes, delete it. Only the bucket
behind it changed. A credential that authenticates but cannot write is exactly the failure
this step exists to surface before the first generation, not during it.

## Consequences

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
  `R2_PUBLIC_BASE_URL` and `R2_ENDPOINT` are gone. `STORAGE_DRIVER`,
  `SUPABASE_STORAGE_BUCKET`, `SUPABASE_S3_ACCESS_KEY_ID`,
  `SUPABASE_S3_SECRET_ACCESS_KEY`, `SUPABASE_S3_REGION` and the optional
  `SUPABASE_S3_ENDPOINT` replace them.
- The seeded `r2` integration row is now `supabase-storage`.
- Two vendor-specific facts are worth knowing before debugging this at 1am. The S3 client
  must set `forcePathStyle: true`, because Supabase serves buckets as a path segment and
  the SDK's default virtual-hosted addressing resolves to nothing. And the S3 access keys
  are a *separate credential* from the service-role key — the service-role JWT
  authenticates the REST storage API, the S3 protocol wants its own pair, and using the
  wrong one returns a 403 that reads like a permissions problem rather than a
  wrong-credential-type problem.
- **Egress cost is now a real number that grows with volume.** It is small today. Revisit
  when publishing volume makes it not small; that is a Phase 3 or 4 question, and this
  decision is cheap to reverse by design.

## Deferred: the public URL for Instagram

ARCHITECTURE.md §5 notes that Instagram's container API fetches `video_url` itself and
cannot present a signature, so publishing needs a *publicly reachable* URL —
`assets.public_url`.

`StorageDriver.publicUrl()` is declared optional and is **not implemented**. Confirming
the public URL shape for a Supabase bucket, and whether a public bucket is acceptable for
finished renders at all, is a Phase 3 question that wants checking against a real bucket
rather than guessing now. The column stays; the method is a stub-shaped hole with a
comment on it.

## Alternative rejected

Keep R2 and put its credentials in Vault like every other vendor. Rejected because it
front-loads a second storage account and a second credential rotation path to save an
egress bill that Phase 1 volume does not generate — and because the interface introduced
here makes the reversal cheap if that changes.
