-- Migration 0031 — the two limits you hit unexpectedly, and the 90-day clock on the board
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION for `v_credit_position`, and a new view for limits.
--
-- What this work exposed is a gap rather than a defect, and it shapes both: **this project
-- tracks purchases and ceilings, and does not track consumption.** Neither view may paper
-- over that, because the natural rendering of each — "usage against limit" and "credits
-- remaining" — needs a numerator that does not exist, and inventing one puts a fabricated
-- figure on the screen the operator checks daily.
--
-- `v_credit_position` is EXTENDED rather than replaced. It has existed since 0008 and
-- `onboarding/step-view.ts` reads four of its columns; a second view over the same concept
-- is worse than none, and writing one is the mistake this file was one keystroke from
-- making. Every existing column keeps its name and meaning.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- v_driver_limits — a ceiling, what is against it now, and what has hit it
--
-- Two kinds of numerator, deliberately separate, because a limit is not one thing:
--
--   in_flight       observed, live. Generations not yet terminal for this driver. A real
--                   usage-against-ceiling that moves as the pipeline runs.
--
--   hits_*          observed, retrospective. Every time the vendor refused us for this
--                   reason, from `generations.error_code`.
--
-- The second is what survives the inverse test. `in_flight` is 0 on a workspace that has
-- never generated and stays 0 for ever, so a card built on it alone would look identical
-- after one video and after a hundred — the exact trap. "You hit this ceiling fourteen
-- times yesterday" is the answer to the hour spent diagnosing; a gauge reading 0/1 is not.
--
-- `concurrency_limited` and `rate_limited` are counted apart, and that is not fussiness:
-- `src/lib/drivers/types.ts` keeps them distinct because the first wants a queue and the
-- second wants exponential backoff, and treating a concurrency ceiling as a rate limit
-- produces a retry storm that makes the ceiling worse. One merged "times you were limited"
-- figure would erase the distinction the driver layer maintains to prevent exactly that.
--
-- The ceiling carries `concurrency_source`, so a screen can never present a fallback as a
-- reading. An unknown ceiling stays null and must not be guessed: a guess above the real
-- one produces a permanent failure rate that reads as vendor flakiness rather than as our
-- own setting.
-- ─────────────────────────────────────────────────────────────

create view v_driver_limits as
select
  i.id                                                              as integration_id,
  i.slug,
  i.kind,
  i.is_enabled,
  i.last_verified_at is not null                                    as is_verified,

  i.concurrency_limit,
  i.concurrency_source,

  -- Live usage. Only the non-terminal states occupy a slot.
  (select count(*) from generations g
    where g.driver = i.slug
      and g.status in ('submitting','queued','running'))            as in_flight,

  (select count(*) from generations g
    where g.driver = i.slug and g.error_code = 'concurrency_limited') as hits_concurrency,
  (select count(*) from generations g
    where g.driver = i.slug and g.error_code = 'rate_limited')        as hits_rate,
  (select count(*) from generations g
    where g.driver = i.slug and g.error_code = 'insufficient_credits') as hits_credits,

  (select max(g.completed_at) from generations g
    where g.driver = i.slug
      and g.error_code in ('concurrency_limited','rate_limited','insufficient_credits'))
                                                                    as last_hit_at,

  -- The denominator for "how often". Fourteen refusals could be 14 of 20 or 14 of 20,000,
  -- and those are different problems.
  (select count(*) from generations g where g.driver = i.slug)      as submits_total
from integrations i
where i.kind in ('video','audio');

comment on view v_driver_limits is
  'Per driver: the concurrency ceiling and where the number came from, what is in flight '
  'against it now, and how often the vendor has actually refused us for each distinct limit '
  'reason. concurrency_limited and rate_limited are counted apart because the driver layer '
  'treats them apart — one wants a queue, the other backoff. in_flight alone would read 0 '
  'for ever on a workspace that has never generated; the hit counts are what make this '
  'answer the question it exists for.';

-- ─────────────────────────────────────────────────────────────
-- v_credit_position, extended
--
-- `credit_purchases` records what was bought and when it expires. **Nothing records what
-- was spent.** `generations.credits_spent` exists and has no writer anywhere in `src/`, so
-- a "remaining credits" figure today would be the purchase total presented as a balance — a
-- number that never moves, rendered as though it does. That is the absent-versus-zero rule
-- in its most expensive form: not a missing measurement shown as zero, but a stale constant
-- shown as a live balance, on the screen the operator checks daily.
--
-- So the two columns added for consumption are the ones that let a reader say "not
-- observed" rather than imply zero: `credits_recorded` counts generations carrying a credit
-- figure, and `credits_spent_total` sums them. The day something writes that column both
-- become real and this view does not change.
--
-- `credits_expiring_30d` is added because the clock is the part that is fully answerable
-- today and the part that matters daily: credits expire about 90 days after purchase
-- whether or not anything used them, and nothing is billed at the moment they evaporate.
-- ─────────────────────────────────────────────────────────────

drop view v_credit_position;

create view v_credit_position as
select
  i.id                                       as integration_id,
  i.slug,
  i.kind,

  -- Unchanged from 0008, names and meanings preserved: `onboarding/step-view.ts` selects
  -- these four and must keep working.
  coalesce(sum(cp.credits) filter (where cp.expires_at >= current_date), 0) as credits_unexpired,
  coalesce(sum(cp.credits) filter (where cp.expires_at <  current_date), 0) as credits_expired,
  min(cp.expires_at) filter (where cp.expires_at >= current_date)           as next_expiry,
  min(cp.expires_at) filter (where cp.expires_at >= current_date) - current_date
                                                                           as days_until_expiry,
  max(cp.purchased_at)                                                     as last_purchase_at,

  count(cp.id)                                                             as purchases,
  sum(cp.amount_usd)                                                       as amount_usd,

  -- What dies within the month, which is the number that changes purchasing behaviour.
  coalesce(
    sum(cp.credits) filter (
      where cp.expires_at >= current_date and cp.expires_at < current_date + 30
    ), 0
  )                                                                        as credits_expiring_30d,

  -- Consumption, so a reader can distinguish "nothing spent" from "spending not recorded".
  (select count(*) from generations g
     where g.driver = i.slug and g.credits_spent is not null)              as credits_recorded,
  (select sum(g.credits_spent) from generations g
     where g.driver = i.slug)                                              as credits_spent_total
from integrations i
left join credit_purchases cp on cp.integration_id = i.id
group by i.id, i.slug, i.kind;

comment on view v_credit_position is
  'What is left and when the nearest tranche dies. credits_expired is shown because "you '
  'lost 400 credits last month" changes purchasing behaviour and never appears in the cost '
  'ledger — nothing is billed when credits evaporate. Deliberately not a balance: '
  'generations.credits_spent has no writer, so remaining is unknown rather than equal to '
  'purchased, and credits_recorded is what lets a reader say so instead of implying zero '
  'consumption.';

notify pgrst, 'reload schema';
