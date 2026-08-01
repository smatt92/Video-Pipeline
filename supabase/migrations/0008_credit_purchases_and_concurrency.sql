-- Migration 0008 — the credit expiry clock, and a concurrency ceiling that admits it is a guess
--
-- Two rulings, both correcting probes that were reporting a permanent failure for something
-- the vendor does not expose.
--
--   1. The credit balance is not readable — the SDK has no account surface — and a
--      permanent red X for something unknowable is noise, not honesty. The balance was
--      never the point anyway: the *expiry clock* was. So it becomes an entry, like the
--      rate card: a number only the account holder can see.
--
--   2. The plan tier read is a guess against documentation. It stops gating step 5, and
--      the concurrency ceiling falls back to a deliberately low default that is labelled
--      as a default rather than presented as a reading.

-- ─────────────────────────────────────────────────────────────
-- 1. Credit purchases
--
-- A table, not two columns on `integrations`, and the reason is the clock itself. Credits
-- expire per *purchase*, roughly 90 days from the day they were bought. Two top-ups are two
-- clocks running at once, and a single `credits_purchased` / `purchased_at` pair silently
-- becomes wrong the second time anyone buys credits — which is the first thing that will
-- happen, and the failure is invisible: the screen shows one confident expiry date that is
-- the wrong one.
--
-- `expiry_days` is per row rather than a constant because "roughly 90 days" is the
-- observed behaviour, not a published term. When a real expiry date is seen on an invoice,
-- correcting that row should not require a migration.
-- ─────────────────────────────────────────────────────────────

create table credit_purchases (
  id             uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  credits        numeric not null check (credits > 0),
  purchased_at   date not null,
  -- Observed, not published. See the note above.
  expiry_days    int not null default 90 check (expiry_days > 0),
  amount_usd     numeric check (amount_usd is null or amount_usd >= 0),
  note           text,
  created_at     timestamptz not null default now(),

  -- Generated rather than computed in the app: every screen that shows a countdown must
  -- agree with every other, and a date arithmetic helper duplicated across three
  -- components will not.
  -- `date + integer` and not `date + '<n> days'::interval`: the text-to-interval cast is
  -- only STABLE, and Postgres rejects a non-immutable generation expression. Integer
  -- addition on a date is immutable and means exactly the same thing.
  expires_at     date generated always as (purchased_at + expiry_days) stored
);

comment on table credit_purchases is
  'Manual entry. The vendor SDK exposes no balance or account endpoint, and guessing an '
  'undocumented REST path to report a confident-looking number is worse than asking. One '
  'row per purchase because credits expire per purchase — two top-ups are two clocks.';

comment on column credit_purchases.expires_at is
  'Generated. The expiry clock is the whole reason this table exists: nothing is billed at '
  'the moment credits evaporate, so it is a cost the ledger structurally cannot see.';

comment on column credit_purchases.amount_usd is
  'What the credits cost, if known. Optional, and worth filling in — credits ÷ dollars is '
  'the only route to a verified per-credit rate, which is what unblocks onboarding step 6.';

create index on credit_purchases (integration_id, expires_at);

-- Total credits not yet expired, and the soonest clock still running.
create view v_credit_position as
select
  i.id                                       as integration_id,
  i.slug,
  coalesce(sum(cp.credits) filter (where cp.expires_at >= current_date), 0) as credits_unexpired,
  coalesce(sum(cp.credits) filter (where cp.expires_at <  current_date), 0) as credits_expired,
  min(cp.expires_at) filter (where cp.expires_at >= current_date)           as next_expiry,
  min(cp.expires_at) filter (where cp.expires_at >= current_date) - current_date
                                                                           as days_until_expiry,
  max(cp.purchased_at)                                                     as last_purchase_at
from integrations i
left join credit_purchases cp on cp.integration_id = i.id
group by i.id, i.slug;

comment on view v_credit_position is
  'What is left and when the nearest tranche dies. credits_expired is shown too, because '
  '"you lost 400 credits last month" is the number that changes purchasing behaviour and '
  'it never appears in the cost ledger — nothing is billed when credits evaporate.';

-- ─────────────────────────────────────────────────────────────
-- 2. Concurrency ceiling, and whether it was read or assumed
--
-- The queue reads a parallel-request limit. Where that number came from decides how much
-- to trust it, and until now there was nowhere to record the difference between "the
-- vendor told us" and "we picked a safe number".
--
-- Direction of the guess is not symmetric, which is the whole argument for a low default.
-- Guessing high produces a steady failure rate that reads as an unreliable vendor and
-- sends someone debugging the wrong system for a day. Guessing low is just slow.
-- ─────────────────────────────────────────────────────────────

alter table integrations
  add column concurrency_limit    int check (concurrency_limit is null or concurrency_limit > 0),
  add column concurrency_source   text not null default 'default'
    check (concurrency_source in ('default', 'tier', 'manual'));

comment on column integrations.concurrency_limit is
  'Parallel requests the queue may have in flight. Null means nothing has established one '
  'and the caller applies the conservative default.';

comment on column integrations.concurrency_source is
  'default = nobody established it, a safe floor is in use. tier = read from the account '
  'during verification. manual = someone typed it. Recorded because a limit that was '
  'guessed and a limit that was read deserve different confidence, and a screen that '
  'cannot tell them apart will present the guess as fact.';
