-- Migration 0035 — publishing, and the one quota this codebase can honestly count
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: a stage that was never built, plus one specification error
-- found on the way in (`channels.vault_secret_id`, at the bottom).
-- ─────────────────────────────────────────────────────────────
--
-- ── The quota is the interesting half, and it is interesting because it is REAL ──
--
-- `src/lib/pipeline/observability.ts` is this project's register of numbers a screen must
-- withhold because nothing can observe them. Every vendor limit in it is there for the same
-- reason: the vendor does not publish a counter, we cannot see our own consumption, and a
-- countdown would therefore be a fabricated measurement. The limits card says so instead of
-- inventing one, which is correct and has been correct for four rounds.
--
-- YouTube's Data API quota is the first one that breaks that pattern, and the reason is
-- worth stating precisely: **we make every call and each call's cost is a documented
-- constant.** `videos.insert` is 1,600 units, `playlistItems.list` is 1, `search.list` is
-- 100. So consumption is not something we ask the vendor for and are refused — it is
-- something we already know, because we did it. Counting our own actions is not a
-- measurement of theirs.
--
-- That makes two figures with different epistemic status and they must not be merged:
--
--   units consumed  — OBSERVED. Every row here was written by a call this code made
--   the 10,000/day ceiling — DOCUMENTED. Google's published figure; nobody has watched us
--                     hit it, and the day we do, the refusal is the observation
--
-- `quota_source` carries that distinction the way `concurrency_source` and
-- `cost_ledger.cost_source` do. A remaining figure derived from a documented ceiling is
-- honest only while it says which half is which — and the day a 403 quotaExceeded arrives
-- at a different number, the ceiling becomes observable and the column records that.
--
-- ── The window is a real window, and it does not reset at your midnight ─────
--
-- Google resets Data API quota at **midnight Pacific**, not UTC and not local. Stored as a
-- column rather than hardcoded, because a hardcoded timezone is the shape of bug that is
-- invisible for eight months and then wrong by a day near a DST boundary. `America/
-- Los_Angeles` handles its own DST; a fixed `-08:00` does not.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. What a quota is, per integration
-- ═════════════════════════════════════════════════════════════════════════════

alter table integrations
  add column daily_quota_units integer
    check (daily_quota_units is null or daily_quota_units > 0),
  add column quota_source text not null default 'documented'
    check (quota_source in ('documented', 'observed')),
  -- IANA name, not an offset. See above.
  add column quota_window_tz text not null default 'UTC';

comment on column integrations.daily_quota_units is
  'The vendor''s published daily ceiling in whatever unit they count. Null means this '
  'vendor has no counted quota, which is every integration but YouTube — and null rather '
  'than a large number, because "no ceiling we know of" is not "a ceiling of infinity".';

comment on column integrations.quota_source is
  'documented = the vendor''s published figure, which nobody here has watched hold. '
  'observed = we hit it and the refusal told us the real number. The consumption figure is '
  'always observed (we made the calls); this column is about the CEILING only, and the two '
  'must not be presented as equally solid.';

comment on column integrations.quota_window_tz is
  'IANA timezone the daily window resets in. YouTube Data API resets at midnight Pacific, '
  'which is neither UTC nor the operator''s local time. A name rather than an offset so DST '
  'is the database''s problem rather than a bug that appears twice a year.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Every call that spends quota writes a row, at the time it spends it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Deliberately the same shape as `cost_ledger` and for the same reason (rule 5): the row
-- is written when the call is made, not when it succeeds. A failed upload still spent its
-- units — Google charges `videos.insert` for the attempt — and a ledger that only records
-- successes would report a comfortable remaining figure on the exact day a retry loop had
-- burned the day's quota.
--
-- Not folded into `cost_ledger`. That table is money, in rupees, with an FX rate and a
-- reconcile; quota units are not money, have no rate, and never reconcile. One table with
-- a nullable currency and a nullable unit-count would answer neither question cleanly, and
-- `v_video_cost`'s exhaustiveness assertion — every ledger row lands in exactly one of two
-- views — would have to grow an exception for rows that are not costs.

create table api_quota_usage (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  -- The vendor's own endpoint name, e.g. 'videos.insert'. Their vocabulary, because their
  -- price list is quoted in it and a translated name makes the two impossible to check.
  endpoint       text not null,
  units          integer not null check (units > 0),
  occurred_at    timestamptz not null default now(),
  -- What it was spent on, when there is one. Null for a call that belongs to no video —
  -- a token refresh, a channel lookup.
  publication_id uuid references publications(id) on delete set null,
  -- Whether the call this row paid for actually worked. Not a filter on the arithmetic:
  -- the units are spent either way, and this exists so "we burned 8,000 units and shipped
  -- nothing" is answerable.
  succeeded      boolean,
  detail         text
);

create index on api_quota_usage (integration_id, occurred_at desc);
create index on api_quota_usage (publication_id) where publication_id is not null;

comment on table api_quota_usage is
  'One row per API call that consumes a vendor quota, written at submit time like '
  'cost_ledger. Records the attempt rather than the success, because a failed '
  'videos.insert still costs 1,600 units and a ledger of successes would report a '
  'comfortable remaining figure on the day a retry loop burned the window.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. The countdown — the first one on the limits card with a real numerator
-- ═════════════════════════════════════════════════════════════════════════════

create view v_api_quota as
with windowed as (
  select
    i.id                                                    as integration_id,
    i.slug,
    i.daily_quota_units,
    i.quota_source,
    i.quota_window_tz,
    -- Midnight in the vendor's own zone, expressed as an instant. `timezone(tz, ts)` twice
    -- is the round trip that makes this DST-correct: instant → local wall clock → truncate
    -- → back to an instant.
    timezone(i.quota_window_tz, date_trunc('day', timezone(i.quota_window_tz, now())))
                                                            as window_started_at,
    timezone(i.quota_window_tz,
      date_trunc('day', timezone(i.quota_window_tz, now())) + interval '1 day')
                                                            as window_resets_at
  from integrations i
  where i.daily_quota_units is not null
)
select
  w.integration_id,
  w.slug,
  w.daily_quota_units,
  w.quota_source,
  w.window_started_at,
  w.window_resets_at,
  w.window_resets_at - now()                                as resets_in,

  -- OBSERVED. Every unit here was spent by a call this code made and recorded.
  coalesce((
    select sum(u.units) from api_quota_usage u
     where u.integration_id = w.integration_id
       and u.occurred_at >= w.window_started_at
  ), 0)::integer                                            as units_used,

  coalesce((
    select count(*) from api_quota_usage u
     where u.integration_id = w.integration_id
       and u.occurred_at >= w.window_started_at
  ), 0)::integer                                            as calls_made,

  -- Units spent this window on calls that did not work. The number that turns "we are out
  -- of quota" into "we are out of quota and have nothing to show for it".
  coalesce((
    select sum(u.units) from api_quota_usage u
     where u.integration_id = w.integration_id
       and u.occurred_at >= w.window_started_at
       and u.succeeded is false
  ), 0)::integer                                            as units_wasted,

  greatest(w.daily_quota_units - coalesce((
    select sum(u.units) from api_quota_usage u
     where u.integration_id = w.integration_id
       and u.occurred_at >= w.window_started_at
  ), 0), 0)::integer                                        as units_remaining
from windowed w;

comment on view v_api_quota is
  'The daily quota window, per integration that has one. units_used is OBSERVED — every '
  'unit was spent by a call this code made and wrote a row for. daily_quota_units is '
  'DOCUMENTED until quota_source says otherwise, and units_remaining inherits that: it is '
  'exact arithmetic over an assumed ceiling. Any surface showing the remaining figure must '
  'show quota_source beside it. units_wasted is separate because 8,000 units spent on '
  'failed uploads and 8,000 spent on shipped videos are the same number and opposite '
  'situations.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. What an upload is, while it is happening
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A resumable upload is a session that outlives a single request, so its state has to be a
-- row. Without `upload_session_url` a worker that dies mid-transfer has no way to continue
-- and can only start again — which costs another 1,600 units for a video already partly
-- delivered, and is how a retry loop empties a day's quota.

alter table publications
  add column upload_session_url text,
  add column upload_bytes_sent bigint check (upload_bytes_sent is null or upload_bytes_sent >= 0),
  add column upload_total_bytes bigint check (upload_total_bytes is null or upload_total_bytes > 0),
  add column upload_started_at timestamptz,
  add column upload_attempts integer not null default 0 check (upload_attempts >= 0),
  -- Rule 6's shape, applied to a call that spends quota rather than money. A replay must
  -- not upload twice: two videos on the channel is worse than a failed publish, because it
  -- is visible to an audience and costs a manual deletion.
  add column idempotency_key text;

create unique index publications_idempotency_key_uniq
  on publications (idempotency_key) where idempotency_key is not null;

comment on column publications.upload_session_url is
  'The resumable session URI. Kept because a worker that dies mid-transfer can otherwise '
  'only start again, and starting again costs another 1,600 quota units for bytes already '
  'delivered. Null before the session is opened and after the upload completes.';

comment on column publications.idempotency_key is
  'Rule 6 applied to a quota spend rather than a money spend. A replayed publish must not '
  'put a second copy of the video on the channel — which is worse than a failure, because '
  'an audience sees it and only a human can undo it.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. A refresh token's expiry cannot be known. It can only be observed.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- This is the rule about a number a screen withholds, applied before the screen exists.
--
-- The obvious design is `refresh_token_expires_at`, and it cannot be filled in honestly.
-- Google issues refresh tokens with no expiry for a published app and a **seven-day**
-- expiry while the OAuth consent screen is in Testing — and does not tell you which you
-- have, or when. Any date written into such a column would be a guess rendered as a fact,
-- and the failure it produces is the worst kind: a publish that stops working silently,
-- days after the screen said everything was fine.
--
-- What IS observable is whether a refresh worked, just now. So the cron performs a real
-- refresh and records the outcome, and the screen says "last confirmed working at" rather
-- than "expires at". `channels.token_expires_at` keeps its meaning and gains a comment,
-- because an ACCESS token's expiry is genuinely known — the vendor returns `expires_in`
-- with it.

alter table channels
  add column token_last_refreshed_at timestamptz,
  add column token_refresh_error text,
  add column token_refresh_failures integer not null default 0
    check (token_refresh_failures >= 0);

comment on column channels.token_expires_at is
  'When the current ACCESS token expires. Knowable, because the vendor returns expires_in '
  'alongside it. Says nothing about the refresh token — see token_last_refreshed_at.';

comment on column channels.token_last_refreshed_at is
  'When a refresh last SUCCEEDED. Deliberately not a refresh_token_expires_at column: '
  'Google gives no expiry for a published app and seven days while the consent screen is '
  'in Testing, and does not say which you have. A date there would be a guess rendered as '
  'a fact, and the failure mode is a publish that stops working days after the screen said '
  'it was fine. This is observed — the cron performs a real refresh and writes what '
  'happened.';

comment on column channels.token_refresh_failures is
  'Consecutive failures. Reset to 0 on success, so a non-zero value means the credential '
  'is broken NOW rather than that it once was.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. The publish queue, with its denominator
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The inverse test, up front, because this project has now found the shape five times: a
-- queue that renders identically after one upload and after a hundred. The fix is the same
-- every time — the rows are the artifact and the count is a column, not a caller's
-- assumption — and it is cheapest to build that way rather than to retrofit.
--
-- So this view has one row per publication that is not yet live, carrying the FIRST reason
-- it cannot proceed, ordered by how early the reason sits. Null means nothing is stopping
-- it. That is `v_pipeline_blockers`' shape, and it is used here because the failure it was
-- built for — a chain that is green at every stage and provably inert end to end — is
-- exactly what a publish queue with no analytics of its own would become.

create view v_publish_queue as
select
  p.id                       as publication_id,
  p.channel_id,
  p.render_id,
  p.title,
  p.status,
  p.scheduled_for,
  p.upload_attempts,
  p.upload_bytes_sent,
  p.upload_total_bytes,
  p.error_detail,
  p.altered_content_disclosed,
  rv.decision                as review_decision,
  r.status                   as render_status,
  case
    -- Ordered by how early the reason sits, so the first thing a person can act on is the
    -- thing they are told. A publication blocked on four things reports the earliest.
    when rv.decision is distinct from 'pass'
      then 'review_not_passed'
    when r.status is distinct from 'ready'
      then 'render_not_ready'
    when p.altered_content_disclosed is not true
      then 'disclosure_not_set'
    when not exists (
      select 1 from integrations i
       where i.slug = 'youtube' and i.is_enabled and i.last_verified_at is not null)
      then 'no_verified_publish_integration'
    when not exists (
      select 1 from v_api_quota q
       where q.slug = 'youtube' and q.units_remaining >= 1600)
      then 'insufficient_quota'
    when p.scheduled_for is not null and p.scheduled_for > now()
      then 'scheduled_for_later'
    else null
  end                        as blocker
from publications p
join renders r  on r.id = p.render_id
left join reviews rv on rv.id = p.review_id
where p.status <> 'live';

comment on view v_publish_queue is
  'Everything not yet published, with the FIRST reason it cannot proceed — the shape '
  'v_pipeline_blockers uses, for the same failure it was built to catch. The first three '
  'blockers are properties of the row; the next two belong to no row at all (no verified '
  'integration, no quota) and block everything at once, which is why they are enumerated '
  'here rather than left for a caller to discover per publication.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. The catalogue row, and a superseded column removed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Disabled and unverified, like every other catalogue row (0014): a row here is a slot to
-- fill in, not a working credential. `kind = 'channel'` already exists in the CHECK; this
-- is the first integration to use it.
--
-- The quota figures are Google's published ones. `quota_source = 'documented'` says so,
-- and it is the whole reason that column exists.

insert into integrations (slug, kind, is_enabled, daily_quota_units, quota_source, quota_window_tz)
values ('youtube', 'channel', false, 10000, 'documented', 'America/Los_Angeles')
on conflict (slug) do update
  set daily_quota_units = excluded.daily_quota_units,
      quota_source      = excluded.quota_source,
      quota_window_tz   = excluded.quota_window_tz;

-- ── channels.vault_secret_id: the design 0007 already replaced ───────────────
--
-- 0007's own words: *"`integrations.vault_secret_id` and `integrations.last_4` are
-- singular. The question after a 401 is which of three fields is wrong, and a single
-- vault_secret_id cannot answer it."* It dropped that column and built
-- `integration_secrets`, one row per field.
--
-- `channels.vault_secret_id` is the same singular design, on a different table, and 0007
-- did not reach it. `grep -rn "vault_secret_id" src/ scripts/` finds no reader and no
-- writer — it has never held a value.
--
-- Removed rather than documented. This stage is the first thing that would ever have
-- stored a channel credential, so it is the exact moment somebody writes to the wrong one
-- of two homes for one concept; and CLAUDE.md is explicit that when you find the second
-- module you delete one, because a superseded design left beside its replacement is a
-- coin-flip for the next person. YouTube's credentials go in `integration_secrets`, which
-- is where every other vendor's already are.

alter table channels drop column vault_secret_id;

notify pgrst, 'reload schema';
