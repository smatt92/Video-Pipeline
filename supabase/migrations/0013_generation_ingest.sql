-- Migration 0013 — what stage 5 needs to ingest a generation honestly
--
-- Two findings, both the evolution kind. Nothing in the spec was wrong; two decisions taken
-- after these columns were written made them unable to say what they now have to say.

-- ─────────────────────────────────────────────────────────────
-- 1. `assets.r2_key` names a vendor that was dropped
--
-- ADR 0007 replaced Cloudflare R2 with Supabase Storage, and the column kept the old name.
-- It is not merely untidy: the storage layer exists so the object store is a config value
-- (CLAUDE.md rule 1), and a column named after one vendor is the exact assumption that
-- layer is built to prevent. Someone reading the schema learns the wrong thing about how
-- swappable storage is.
--
-- Cheap now — the table is empty. It stops being cheap the moment it is not.
-- ─────────────────────────────────────────────────────────────

alter table assets rename column r2_key to storage_key;

comment on column assets.storage_key is
  'Key within the configured bucket. Deliberately not named after a vendor: which object '
  'store is behind the StorageDriver interface is a config value, and this column outlived '
  'the first answer to it.';

-- ─────────────────────────────────────────────────────────────
-- 2. An asset has to say whether it was normalised, and from what
--
-- Addendum 02 §3: normalise on ingest, not at stitch — h264 / yuv420p / 1080x1920 / 30fps.
-- The reason is that a stitch is the wrong place to discover a clip is 24fps: by then every
-- other clip is already in place and the failure is a re-render of the whole timeline
-- rather than one download.
--
-- `assets` records what a file *is* and had no way to record what it *was*, so "did this
-- clip need conversion?" and "did conversion happen?" were both unanswerable. The second
-- matters most: an un-normalised clip that reaches the assembler looks identical to a
-- normalised one until ffmpeg refuses to concatenate it.
--
-- Three states again, from the same shape as everywhere else: never attempted (both null),
-- attempted and failed (`normalize_error` set), succeeded (`normalized_at` set).
-- ─────────────────────────────────────────────────────────────

alter table assets
  add column normalized_at   timestamptz,
  add column normalize_error text,
  add column source_meta     jsonb;

comment on column assets.source_meta is
  'What the vendor actually delivered, probed before conversion: codec, pixel format, '
  'dimensions, frame rate, duration. Kept because "the vendor changed its default output" '
  'is invisible without a record of what it used to send.';

comment on column assets.normalize_error is
  'Set when normalisation was attempted and failed. With normalized_at this separates '
  'never-attempted from failed from done — an un-normalised clip is indistinguishable from '
  'a normalised one until the assembler refuses to concatenate it.';

-- ─────────────────────────────────────────────────────────────
-- 3. A completion that was confirmed, versus one that was merely claimed
--
-- The webhook carries a shared secret, not a signature — there is nothing to verify
-- cryptographically (ADR 0004), so a leaked secret is a forged completion. The receiver
-- therefore confirms against the vendor's own status endpoint before writing anything.
--
-- `webhook_received_at` records that a callback arrived. This records that the vendor
-- independently agreed with it. They are different claims and only the second one licenses
-- writing an asset.
-- ─────────────────────────────────────────────────────────────

alter table generations
  add column confirmed_at timestamptz;

comment on column generations.confirmed_at is
  'When the vendor''s status endpoint independently confirmed the outcome a webhook '
  'claimed. webhook_received_at says a callback arrived; this says it was true. An asset '
  'is only written after this, because the callback carries a bearer secret rather than a '
  'signature and a leaked secret is a forged completion.';

-- Every generation that reached a terminal state without confirmation. Should be empty;
-- a row here is either a bug in the receiver or something writing results it should not.
create view v_unconfirmed_terminal_generations as
select g.id, g.shot_id, g.status, g.webhook_received_at, g.completed_at, g.external_job_id
from generations g
-- The terminal set from the status CHECK in 0001. Written out rather than negated, so a
-- new non-terminal status does not silently start appearing here. `nsfw_blocked` is not
-- one of them: the driver interface has a content-rejected error code, but the column's
-- CHECK does not, so a rejection lands as `failed` with an error_code.
where g.status in ('succeeded', 'failed', 'cancelled', 'timeout')
  and g.completed_at is not null
  and g.confirmed_at is null;

comment on view v_unconfirmed_terminal_generations is
  'Should always be empty. A row is a generation whose outcome was written without the '
  'vendor being asked to confirm it — which is the shape of a forged callback landing.';
