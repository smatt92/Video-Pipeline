-- Kiln — migrations 0031 to 0042, bundled for the Supabase SQL editor.
--
-- GENERATED FILE. Do not edit; regenerate with `pnpm db:bundle`.
--
-- ── How to use ──────────────────────────────────────────────────────────────
--
--   1. Supabase dashboard → SQL Editor → New query
--   2. Paste this entire file
--   3. Run
--
-- Expected output is "Success. No rows returned". Anything else means nothing was
-- applied: the whole file is one transaction, so a failure rolls back every statement in
-- it. There is no half-applied state to clean up.
--
-- The last statement in this file is `notify pgrst, 'reload schema'`. Without it the
-- app keeps reporting "Could not find the table 'public.X' in the schema cache" even
-- though every table exists — PostgREST caches the schema and pasting SQL does not tell
-- it to reload. It is included; you do not need to run it separately.
--
-- ── Running it twice ────────────────────────────────────────────────────────
--
-- Safe. The guard below raises before any schema change if any of these versions is
-- already recorded, and the transaction rolls back. You will see an error that says so in
-- words — that error is the file working, not failing.
--
-- ── What it records ─────────────────────────────────────────────────────────
--
-- Each migration is written into supabase_migrations.schema_migrations, the same table
-- `supabase db push` uses. If the CLI starts working later it reads this as its own
-- history and reports the project up to date rather than replaying anything.
--
-- Migrations included (12):
--   0031  limits_and_the_credit_clock
--   0032  a_cost_says_how_it_was_arrived_at
--   0033  the_pilot_shot
--   0034  the_loop_closes
--   0035  publishing_and_the_one_quota_we_can_count
--   0036  competitor_signal
--   0037  bureau_of_reality
--   0038  calendar_seed
--   0039  rls_everywhere
--   0040  bureau_control_plane
--   0041  bureau_publishing_and_metrics
--   0042  long_form_segments

begin;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key
);

alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;

-- ── Guard ───────────────────────────────────────────────────────────────────
do $kiln_guard$
declare
  seen text;
begin
  select string_agg(version, ', ' order by version) into seen
  from supabase_migrations.schema_migrations
  where version in ('0031', '0032', '0033', '0034', '0035', '0036', '0037', '0038', '0039', '0040', '0041', '0042');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0031_limits_and_the_credit_clock.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0031 limits_and_the_credit_clock'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0031', 'limits_and_the_credit_clock', array['-- applied from a lean bundle; text in supabase/migrations/0031_limits_and_the_credit_clock.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0032_a_cost_says_how_it_was_arrived_at.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0032 a_cost_says_how_it_was_arrived_at'; end $kiln_progress$;

-- Migration 0032 — a cost row says how its number was arrived at
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION. `entry_kind` was exact for the case it was built for
-- and a second case shows what it cannot say.
--
-- `entry_kind` answers *when* — estimate at submit, reconcile on completion, refund after.
-- It was doing double duty as an answer to *how the number was arrived at*, because until
-- now those two questions had the same answer: an estimate came from the rate card and a
-- reconcile came from the vendor.
--
-- They come apart the moment a completed generation needs to be countable. Rule 5's
-- reconcile half has never existed — nothing writes a reconcile against a `generation_id` —
-- so a video that generates stays outstanding for ever and can never enter cost per video.
-- The tempting fix is to write a reconcile equal to the estimate on success. **That is
-- refused here**: it would put a fabricated figure in the ledger everything derives from,
-- indistinguishable from a measured one, and the whole value of this table is that its rows
-- can be checked.
--
-- So the row says how it was priced, and the view counts accordingly. A completed
-- generation is countable, from its estimate, labelled as an estimate everywhere it
-- surfaces. The real reconcile lands when a credit-balance delta is observable — the same
-- mechanism as the rate card, where a verified number comes from watching a balance move
-- rather than from reading a response body.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column cost_source text not null default 'rate_card'
    check (cost_source in ('rate_card', 'measured'));

comment on column cost_ledger.cost_source is
  'How this row''s figure was arrived at, which is a different question from entry_kind''s '
  '*when*. rate_card = quantity times a unit rate; the quantity may be exact (tokens, '
  'characters) and the price is still ours rather than the vendor''s. measured = the vendor '
  'told us, or a credit balance was observed to move by this much. Every row today is '
  'rate_card, and a screen that shows a total must say so.';

-- ─────────────────────────────────────────────────────────────
-- Incurred, and why it is not the same as settled
--
-- Money the account has actually parted with. A reconcile or a refund always qualifies. An
-- estimate qualifies once its generation reaches a terminal state — the call happened and
-- was billed, whatever we later learn about the exact figure. An estimate on a generation
-- still in flight does not: it is committed, and the vendor may yet refuse it for free.
--
-- This is the distinction that lets a completed video be counted without inventing a
-- reconcile for it.
-- ─────────────────────────────────────────────────────────────

drop view v_cost_unattributed;
drop view v_video_cost;
drop view v_cost_attributed;

create view v_cost_attributed as
select
  cl.id,
  coalesce(cl.script_id, s.script_id, r.script_id, ss.script_id) as script_id,
  case
    when cl.render_id         is not null then 'render'
    when cl.generation_id     is not null then coalesce(g.kind, 'generation')
    when cl.studio_session_id is not null then 'studio'
    when cl.script_id         is not null then 'llm'
    when cl.concept_id        is not null then 'concept'
    when cl.channel_id        is not null then 'channel'
    else 'unknown'
  end as component,
  cl.entry_kind,
  cl.cost_source,

  -- Money actually parted with. See the note above.
  case
    when cl.entry_kind in ('reconcile', 'refund') then true
    when cl.generation_id is null then true
    else g.status in ('succeeded', 'failed', 'cancelled', 'timeout')
  end as incurred,

  cl.cost_inr,
  cl.cost_usd,
  cl.driver,
  cl.unit,
  cl.occurred_at,
  cl.generation_id,
  cl.render_id,
  cl.script_id     as subject_script_id,
  cl.studio_session_id,
  cl.concept_id,
  cl.channel_id
from cost_ledger cl
left join generations     g  on g.id  = cl.generation_id
left join shots           s  on s.id  = g.shot_id
left join renders         r  on r.id  = cl.render_id
left join studio_sessions ss on ss.id = cl.studio_session_id;

comment on view v_cost_attributed is
  'Every cost_ledger row with the script it belongs to resolved once, plus whether the money '
  'has actually been parted with. `incurred` is false only for an estimate whose generation '
  'is still in flight — that one is committed and the vendor may yet refuse it for free.';

create view v_video_cost as
with attributed as (
  select * from v_cost_attributed where script_id is not null
),
incurred as (
  select
    script_id,
    sum(cost_inr) filter (where cost_source = 'measured')  as measured_inr,
    sum(cost_inr) filter (where cost_source = 'rate_card') as estimated_inr,
    count(*) filter (where cost_source = 'measured')       as measured_rows,
    count(*) filter (where cost_inr is null)               as unpriced,
    count(*)                                               as rows_n
  from attributed
  where incurred
    -- A superseded estimate must not be added to the reconcile that replaced it.
    and not (
      entry_kind = 'estimate'
      and exists (
        select 1 from cost_ledger r
        where r.entry_kind = 'reconcile'
          and r.generation_id     is not distinct from attributed.generation_id
          and r.render_id         is not distinct from attributed.render_id
          and r.script_id         is not distinct from attributed.subject_script_id
          and r.studio_session_id is not distinct from attributed.studio_session_id
          and r.concept_id        is not distinct from attributed.concept_id
          and r.channel_id        is not distinct from attributed.channel_id
          and r.unit              is not distinct from attributed.unit
      )
    )
  group by 1
),
committed as (
  select
    script_id,
    sum(cost_inr)                            as committed_inr,
    count(*) filter (where cost_inr is null) as unpriced,
    count(*)                                 as rows_n
  from attributed
  where not incurred
    -- An estimate whose reconcile has already arrived is neither incurred-as-an-estimate
    -- nor still committed: it has been superseded. Without this it would be counted as
    -- outstanding for ever beside the reconcile that replaced it, and a caller adding the
    -- two columns would bill the clip twice.
    and not exists (
      select 1 from cost_ledger r
      where r.entry_kind = 'reconcile'
        and r.generation_id     is not distinct from attributed.generation_id
        and r.render_id         is not distinct from attributed.render_id
        and r.script_id         is not distinct from attributed.subject_script_id
        and r.studio_session_id is not distinct from attributed.studio_session_id
        and r.concept_id        is not distinct from attributed.concept_id
        and r.channel_id        is not distinct from attributed.channel_id
        and r.unit              is not distinct from attributed.unit
    )
  group by 1
),
all_rows as (
  select script_id, count(*) as rows_n from attributed group by 1
),
by_component as (
  select
    script_id, component,
    sum(cost_inr) filter (where incurred)                  as inr,
    count(*) filter (where cost_inr is null)               as unpriced
  from attributed
  group by 1, 2
),
components as (
  select script_id,
         jsonb_object_agg(component, jsonb_build_object('inr', inr, 'unpriced', unpriced)) as component_inr
  from by_component group by 1
),
rendered as (
  select script_id, count(*) as renders, count(*) filter (where status = 'ready') as renders_ready
  from renders group by 1
),
published as (
  select r.script_id, count(*) filter (where p.status = 'live') as live
  from publications p join renders r on r.id = p.render_id group by 1
)
select
  sc.id                                    as script_id,
  sc.concept_id,
  c.channel_id,
  c.title,
  sc.created_at,

  -- Kept apart on purpose. A caller may add them; nothing here does it for them, and the
  -- screen has to say which part of a total was priced from our own rate card.
  case when coalesce(ic.unpriced, 0) > 0 then null else ic.measured_inr  end as measured_inr,
  case when coalesce(ic.unpriced, 0) > 0 then null else ic.estimated_inr end as estimated_inr,
  coalesce(ic.measured_rows, 0)            as measured_rows,
  coalesce(ic.unpriced, 0)                 as unpriced_incurred_rows,

  case when coalesce(cm2.unpriced, 0) > 0 then null else cm2.committed_inr end as committed_inr,
  coalesce(cm2.unpriced, 0)                as unpriced_committed_rows,

  coalesce(ar.rows_n, 0)                   as ledger_rows,
  cm.component_inr,

  coalesce(rd.renders, 0)                  as renders,
  coalesce(rd.renders_ready, 0)            as renders_ready,
  coalesce(pb.live, 0)                     as publications_live,

  -- Four outcomes now, because "countable" splits by how the figure was arrived at. A
  -- screen must be able to label an average as estimated rather than presenting it as a
  -- measurement, and a caller that cannot tell them apart will add them.
  case
    when coalesce(rd.renders_ready, 0) = 0                     then 'not_rendered'
    when coalesce(ic.unpriced, 0) > 0                          then 'unpriced'
    when ic.script_id is null                                  then 'nothing_incurred'
    when coalesce(ic.estimated_inr, 0) = 0
         and coalesce(ic.measured_inr, 0) <> 0                 then 'countable_measured'
    else 'countable_estimated'
  end                                      as denominator_state
from scripts sc
join concepts c on c.id = sc.concept_id
left join incurred   ic  on ic.script_id  = sc.id
left join committed  cm2 on cm2.script_id = sc.id
left join all_rows   ar  on ar.script_id  = sc.id
left join components cm  on cm.script_id  = sc.id
left join rendered   rd  on rd.script_id  = sc.id
left join published  pb  on pb.script_id  = sc.id
where ic.script_id is not null
   or cm2.script_id is not null
   or rd.script_id is not null;

comment on view v_video_cost is
  'Cost per video, one row per script, with measured and rate-card figures kept apart and an '
  'unknown cost null rather than zero. A completed generation is countable from its estimate '
  '— denominator_state says countable_estimated — because inventing a reconcile equal to the '
  'estimate would put a fabricated figure in the table everything derives from. The real '
  'reconcile lands when a credit-balance delta is observable.';

create view v_cost_unattributed as
select
  component, entry_kind,
  count(*)                                 as rows_n,
  sum(cost_inr)                            as inr,
  count(*) filter (where cost_inr is null) as unpriced,
  min(occurred_at)                         as first_at,
  max(occurred_at)                         as last_at
from v_cost_attributed
where script_id is null
group by 1, 2;

comment on view v_cost_unattributed is
  'Spend that belongs to no video, by component. The complement of v_video_cost and '
  'exhaustive with it.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0032', 'a_cost_says_how_it_was_arrived_at', array['-- applied from a lean bundle; text in supabase/migrations/0032_a_cost_says_how_it_was_arrived_at.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0033_the_pilot_shot.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0033 the_pilot_shot'; end $kiln_progress$;

-- Migration 0033 — the pilot shot
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: neither. A new control over an existing one.
--
-- Stage 5 fans out every shot in a script in one call. Six shots at ₹50–200 each are
-- committed before a single frame has been seen, so the first thing anybody learns about a
-- recipe is learned six charges in — and on a recipe's first outing the look is usually
-- wrong. The whole fan-out was spent finding that out.
--
-- So: submit shot 1 alone, look at it, fan out the rest only on approval. A rejected look
-- costs one clip instead of six.
-- ─────────────────────────────────────────────────────────────
--
-- ── Why approval is a compare-and-set ────────────────────────────────────────
--
-- Approving spends money — that is the entire point of the control — so it has the same
-- shape as approving a concept and confirming a generation: a transition the database
-- decides, exactly once, rather than an application check two clicks or two tabs can both
-- pass. `approve_pilot_once` carries `pilot_approved_at is null` as the compare half, and
-- `pilot_generation_id = $2` as well, so approving a pilot that has since been replaced
-- also loses. An `is null` check alone would miss that case.
--
-- ── Why it lives on the script, not the shot ─────────────────────────────────
--
-- The shot is the artifact; the decision is about the script's remaining shots. On
-- `shots.status` it would make "is this script waiting on a pilot?" a question about which
-- of N rows happens to be first, and the answer would change when a shot was reordered.
-- ─────────────────────────────────────────────────────────────

alter table scripts
  add column pilot_generation_id uuid references generations(id) on delete set null,
  add column pilot_approved_at   timestamptz,
  add column pilot_approved_by   uuid,
  add column pilot_rejected_at   timestamptz,
  add column pilot_reject_reason text;

comment on column scripts.pilot_generation_id is
  'The one shot submitted alone, before the rest. Set by stage 5 after a successful pilot '
  'submit; the fan-out refuses until pilot_approved_at is set. Written after the submit '
  'rather than before, so a failed submit cannot leave a script waiting on a pilot that '
  'does not exist — the blocker view would then say "waiting on pilot approval" for ever '
  'with nothing to look at, which is the invented state becoming the silence it prevents.';

comment on column scripts.pilot_approved_at is
  'Set only by approve_pilot_once, which is a compare-and-set because approving spends '
  'money — the same reason concept approval and generation confirmation are.';

alter table scripts
  add constraint scripts_pilot_decided_once
  check (pilot_approved_at is null or pilot_rejected_at is null);

create index scripts_pilot_pending_idx
  on scripts (id)
  where pilot_generation_id is not null
    and pilot_approved_at is null
    and pilot_rejected_at is null;

create function approve_pilot_once(
  p_script_id     uuid,
  p_generation_id uuid,
  p_approved_by   uuid default null
)
returns boolean
language plpgsql
as $$
declare
  won boolean;
begin
  update scripts
     set pilot_approved_at = now(),
         pilot_approved_by = p_approved_by
   where id = p_script_id
     and pilot_generation_id = p_generation_id
     and pilot_approved_at is null
     and pilot_rejected_at is null
  returning true into won;

  return coalesce(won, false);
end;
$$;

comment on function approve_pilot_once is
  'Approve a script''s pilot, exactly once. Returns true to the single caller that won and '
  'false to every other — a second click, a second tab, or a caller approving a pilot that '
  'has since been replaced. Everything that spends money hangs off that boolean: the '
  'fan-out reads pilot_approved_at, not the caller''s word for it.';

-- ─────────────────────────────────────────────────────────────
-- The board must name the new state, in the same change that invents it
--
-- Read-silence-back, applied to a state being created rather than discovered. A script
-- whose pilot is submitted and awaiting a human has nothing wrong with it and is going
-- nowhere — exactly the shape that made `shot_listed` mean "stuck for ever". This view has
-- now twice reported an invented state as something it was not (readiness in 0028, a
-- blocker that was not blocking in 0029), so the state gets named here rather than after
-- somebody notices a board full of stalled rows.
--
-- `awaiting_pilot_approval` is also a column of its own, not only a blocker string:
-- waiting on a person is not a misconfiguration, and a screen must be able to render it
-- differently and offer the decision rather than report a problem that does not exist.
-- ─────────────────────────────────────────────────────────────

drop view v_pipeline_blockers;

create view v_pipeline_blockers as
select
  s.id                                as script_id,
  c.id                                as concept_id,
  c.channel_id,
  c.title,
  s.created_at,
  case
    when not exists (
      select 1 from integrations i
       where i.kind = 'video' and i.is_enabled and i.last_verified_at is not null
    ) then 'no verified video integration — enabling states intent, verifying states fact'

    when not exists (select 1 from prompts p where p.is_active)
      then 'the prompt library has no active recipe — production reads the library, it never improvises'

    when not exists (select 1 from shots sh where sh.script_id = s.id)
      then 'no shots — stage 4 has not run'

    when exists (
      select 1 from shots sh
       where sh.script_id = s.id
         and (sh.compiled_params is null or sh.prompt_id is null)
    ) then 'some shots have no compiled parameters — no library recipe matched'

    when exists (
      select 1
        from shots sh
        join prompts p on p.id = sh.prompt_id
       where sh.script_id = s.id
         and not exists (
           select 1 from rate_card rc
            where rc.driver = p.driver and rc.model = p.model
              and rc.unit = 'credit' and rc.is_verified
              and rc.effective_from <= now()
         )
    ) then 'no verified credit rate for the recipe these shots use — the call cannot be priced'

    when s.pilot_rejected_at is not null
      then 'the pilot shot was rejected — change the recipe and submit a new pilot'
    when s.pilot_generation_id is not null and s.pilot_approved_at is null
      then 'waiting on pilot approval — one shot was generated so the rest can be judged before they are paid for'

    when exists (
      select 1 from shots sh
       where sh.script_id = s.id and sh.duration_source <> 'derived_from_vo'
    ) then case
      when ch.host_voice_id is null
        then 'durations are still estimates and the channel has no host voice — stage 6 cannot run'
      else 'durations are still estimates — stage 6 has not run'
    end

    else null
  end as blocker,

  case
    when not exists (
      select 1 from integrations i
       where i.kind = 'video' and i.is_enabled and i.last_verified_at is not null
    ) then true
    when not exists (select 1 from prompts p where p.is_active) then true
    else false
  end as blocker_is_workspace_wide,

  (s.pilot_generation_id is not null
     and s.pilot_approved_at is null
     and s.pilot_rejected_at is null)  as awaiting_pilot_approval
from scripts s
join concepts c on c.id = s.concept_id
join channels ch on ch.id = c.channel_id;

comment on view v_pipeline_blockers is
  'For every script, the first reason it cannot reach a generation — or null when nothing is '
  'blocking it. Workspace gates first because they block every script at once; the pilot '
  'gate after the readiness gates, because a pilot can only exist once those pass. '
  'awaiting_pilot_approval is a column of its own so a screen can tell waiting-on-a-person '
  'apart from a misconfiguration: this view has twice reported an invented state as '
  'something it was not, and rendering a pending pilot as stalled would be the third.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0033', 'the_pilot_shot', array['-- applied from a lean bundle; text in supabase/migrations/0033_the_pilot_shot.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0034_the_loop_closes.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0034 the_loop_closes'; end $kiln_progress$;

-- Migration 0034 — the loop closes: measurement that can be believed
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR, and the largest one left.
--
-- ARCHITECTURE §0.1 says the durable asset is the loop — trend → hook → shotlist →
-- generate → assemble → publish → **measure → feed back into hook selection** — and that
-- nobody can copy accumulated hook-performance data. `metrics_snapshots` has existed since
-- 0001 and `grep -rn "metrics_snapshots" src/` finds **no reader and no writer**.
-- `v_cost_per_1k_views` is commented "the only number that answers the business question"
-- and has no caller either.
--
-- So the moat is a table nothing fills and a view nobody selects. 0025 fixed this shape one
-- level down — recipe performance derived from rows instead of from columns nothing wrote —
-- and this is the same finding one level up, on the outcome half rather than the editorial
-- half.
-- ─────────────────────────────────────────────────────────────
--
-- ── Four things, and the order matters ───────────────────────────────────────
--
--   1. metrics_snapshots learns to say "I could not read this", which is not zero
--   2. What is *due* and what is *covered* — the inverse test, denominator first
--   3. Hooks get a pattern, so a rollup has something to roll up to
--   4. Recipe performance stops calling two different things `win_rate`
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Absent is not zero, and a failed read is a row
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CLAUDE.md's five-instance rule, applied before the first writer exists rather than after
-- the fourth bug. The failure this prevents is specific and it is the worst one available
-- here: a 30d snapshot whose fetch failed, stored as `views = 0`, makes
-- `cost_per_1k_views` infinite for that video and drags a channel average with it — and
-- the row looks exactly like a video nobody watched. There is no way to tell them apart
-- afterwards, which is why it has to be structural.
--
-- Three columns and two CHECKs:
--
--   status            — 'measured' or 'unavailable'. A failed read lands as a row
--   unavailable_reason— required when unavailable; never a silent null
--   metric_source     — how the figure was arrived at, exactly as cost_ledger.cost_source
--
-- `metric_source` is not decoration. Phase 1 publishes by hand (CLAUDE.md, Current phase),
-- so the only source that exists today is a person reading YouTube Studio and typing what
-- they see. A screen that shows a typed number and an API number identically is the
-- fabricated-measurement trap in a second place, and the fix there was this same column.

alter table metrics_snapshots
  add column status text not null default 'measured'
    check (status in ('measured', 'unavailable')),
  add column unavailable_reason text,
  add column metric_source text not null default 'manual_entry'
    check (metric_source in ('manual_entry', 'vendor_api')),
  add column entered_by uuid,
  add column updated_at timestamptz not null default now();

-- An unavailable row carries no numbers at all. Not "mostly null" — a partial read is
-- still a read that failed, and letting three of seven columns through means a caller has
-- to know which three to trust.
alter table metrics_snapshots
  add constraint metrics_snapshots_unavailable_is_empty check (
    status <> 'unavailable' or (
      views is null and likes is null and comments is null and shares is null
      and saves is null and avg_view_pct is null and retention_3s_pct is null
      and unavailable_reason is not null
    )
  );

-- And a measured row carries the one number every consumer divides by. `views` is the
-- denominator of cost-per-1k and the join key of every rollup below; a measured row
-- without it is an unavailable row that forgot to say so.
alter table metrics_snapshots
  add constraint metrics_snapshots_measured_has_views check (
    status <> 'measured' or views is not null
  );

-- retention_3s_pct stays nullable **on a measured row**, deliberately and against the
-- temptation to require it. Platforms withhold retention below a view threshold, so a
-- video with 40 views has a real view count and no retention curve. That is absence, the
-- metric this stage exists to learn from is the one most often absent, and a 0 there would
-- read as "nobody made it past three seconds" — the strongest possible signal, invented.

-- Counts cannot be negative and percentages are percentages. Stated because this project
-- has already shipped one CHECK that rejected a plausible value: `_pct` means 0–100 here,
-- so a writer handed a vendor's 0–1 ratio must multiply, and will find out at the insert
-- rather than three views downstream.
alter table metrics_snapshots
  add constraint metrics_snapshots_counts_nonneg check (
    coalesce(views, 0) >= 0 and coalesce(likes, 0) >= 0 and coalesce(comments, 0) >= 0
    and coalesce(shares, 0) >= 0 and coalesce(saves, 0) >= 0
  ),
  add constraint metrics_snapshots_pcts_in_range check (
    (avg_view_pct     is null or (avg_view_pct     >= 0 and avg_view_pct     <= 100))
    and (retention_3s_pct is null or (retention_3s_pct >= 0 and retention_3s_pct <= 100))
  );

comment on column metrics_snapshots.status is
  'measured = these numbers came back. unavailable = the read failed or the platform '
  'withheld them, and every metric column is null with a reason beside it. A failed read '
  'is a row rather than a missing row, so "we have not looked yet" and "we looked and got '
  'nothing" are answerable apart — CLAUDE.md, absent is not zero.';

comment on column metrics_snapshots.metric_source is
  'How the figure was arrived at, not where it is stored. manual_entry is a person reading '
  'the platform''s own dashboard and typing it, which is the only source Phase 1 has; '
  'vendor_api is a fetch. Every surface that shows a metric must show which — the same '
  'reason cost_ledger.cost_source exists.';

comment on column metrics_snapshots.retention_3s_pct is
  'The hook metric, 0–100. Null on a measured row is normal and meaningful: platforms '
  'withhold retention below a view threshold. Never write 0 for withheld — 0 is the '
  'strongest claim this table can make about a hook.';

-- Replay: stage 11 re-reads a bucket that was previously unavailable, so the writer
-- upserts on the existing unique (publication_id, age_bucket). `updated_at` moves,
-- `captured_at` does not — first look and latest look are different facts, exactly as
-- webhook_received_at and webhook_last_received_at are in 0015.
comment on column metrics_snapshots.captured_at is
  'When this bucket was FIRST read. Preserved across re-reads so "how long did it take us '
  'to measure this" stays answerable; see updated_at for the most recent.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The inverse test, and it is the denominator
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Written before the ingest rather than after it, because the operator's spec put it
-- first and because the trap it names has now been found four times here (the costs page,
-- the trends list, the review queue, the Studio list) plus three silent `.limit()` caps:
-- **a metrics screen that looks the same after one video and after a hundred.**
--
-- The shape that avoids it is a denominator that is a column, not a caller's assumption.
-- `v_measurement_due` enumerates every (publication, bucket) pair the clock has passed —
-- one row per thing that *should* have been measured, whether or not it was. Count it and
-- you have the denominator; filter it and you have the backlog. A screen built on this
-- cannot render the same at two scales, because the row count is the scale.

create view v_measurement_due as
select
  p.id                       as publication_id,
  p.channel_id,
  p.render_id,
  p.title,
  p.published_at,
  b.age_bucket,
  p.published_at + b.after   as due_at,
  ms.id                      as snapshot_id,
  ms.status                  as snapshot_status,
  ms.captured_at,
  ms.views,
  ms.retention_3s_pct,
  -- Three states, never two. "Not captured" and "captured and unavailable" are the same
  -- absence to a naive `ms.id is null`, and they need opposite responses: one is work
  -- outstanding, the other is work done that produced nothing.
  case
    when ms.id is null              then 'outstanding'
    when ms.status = 'unavailable'  then 'unavailable'
    else 'captured'
  end                        as coverage_state
from publications p
cross join (values
  ('6h',  interval '6 hours'),
  ('24h', interval '24 hours'),
  ('7d',  interval '7 days'),
  ('30d', interval '30 days')
) as b(age_bucket, after)
left join metrics_snapshots ms
  on ms.publication_id = p.id and ms.age_bucket = b.age_bucket
-- Only what has actually gone live and actually has a timestamp. A publication stuck in
-- 'uploading' is not an unmeasured video, it is an unpublished one, and counting it here
-- would make the backlog a symptom of two different problems at once.
where p.status = 'live'
  and p.published_at is not null
  and now() >= p.published_at + b.after;

comment on view v_measurement_due is
  'One row per (live publication, age bucket) whose clock has passed — what SHOULD have '
  'been measured by now, captured or not. The denominator for every measurement surface: '
  'a screen built on this cannot look the same after one video and after a hundred, which '
  'is the trap this project has found four times. coverage_state separates never-looked '
  'from looked-and-got-nothing; a null-check on the snapshot id cannot.';

create view v_measurement_coverage as
select
  d.channel_id,
  count(*)                                                   as due,
  count(*) filter (where d.coverage_state = 'captured')      as captured,
  count(*) filter (where d.coverage_state = 'unavailable')   as unavailable,
  count(*) filter (where d.coverage_state = 'outstanding')   as outstanding,
  count(distinct d.publication_id)                           as publications_due,
  count(distinct d.publication_id) filter (where d.coverage_state = 'captured')
                                                             as publications_measured,
  -- ── There is deliberately no `count(*) = 0 then null` guard here ─────────
  --
  -- The first draft had one, reasoning that a channel with nothing due has no coverage
  -- ratio and that 0% would accuse it of neglect. The reasoning is right and the guard was
  -- unreachable: this view groups `v_measurement_due`, so a group only exists because it
  -- has rows, and `count(*)` is never 0 in it. That is CLAUDE.md's guard-for-a-state-that-
  -- cannot-occur — a branch that reads as protection, tests green by never running, and
  -- makes the next reader believe the undefined case is handled here.
  --
  -- The undefined case is real and lives one level up, where the denominator can genuinely
  -- be empty: `readMeasureBoard` sums these rows, and with nothing due there are no rows to
  -- sum, so the screen shows "undefined — nothing is due yet". That is the only place the
  -- question can be asked.
  round(count(*) filter (where d.coverage_state = 'captured')::numeric / count(*), 3)
                                                             as captured_share
from v_measurement_due d
group by d.channel_id;

comment on view v_measurement_coverage is
  'How much of what is due has actually been measured, per channel. A channel appears here '
  'only once something is due, so captured_share always has a denominator — the '
  'nothing-is-due case is undefined and is answered by the caller, which is the only level '
  'where an empty set can occur.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Hooks get a pattern, because "score hooks not videos" needs a key to group on
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `scripts.hook` is free text and every one is unique, so grouping on it scores one video
-- per group — "score videos" wearing the word hook. The thing that repeats across videos
-- is the *shape* of the hook, and this project already has the pattern for that:
-- `structure_hash` classifies a beat structure so anti-templating can be measured on it.
--
-- Classified rather than free: an open text column would accumulate 'question', 'Question'
-- and 'q' and stop grouping. The CHECK is the enum, and it is deliberately short — seven
-- shapes that a person can tell apart in a second, because a taxonomy nobody can apply
-- consistently produces buckets that do not mean anything.
--
-- Null means **not classified**, and is never a bucket. A video whose hook has no pattern
-- contributes to no group rather than to a residual one; an 'other' bucket would grow to
-- hold everything unclassifiable and then be averaged as though it were a shape.

alter table scripts
  add column hook_pattern text
    check (hook_pattern in (
      'question',          -- opens by asking; the viewer answers in their head
      'contradiction',     -- states the received view, then denies it
      'number_claim',      -- a figure carries the promise
      'warning',           -- a cost of not watching
      'story_open',        -- mid-scene, the resolution withheld
      'direct_address',    -- names the viewer or their situation
      'demonstration'      -- shows the outcome first, explains after
    )),
  add column hook_pattern_version text;

comment on column scripts.hook_pattern is
  'The shape of the hook, not its words — the key "score hooks, not videos" groups on. '
  'Free text would score one video per group, because every hook is unique. Null means '
  'unclassified and belongs to no bucket: an "other" bucket collects everything the '
  'taxonomy failed on and then gets averaged as if it were a shape.';

comment on column scripts.hook_pattern_version is
  'Which classifier assigned it, as concepts.rubric_version does for scoring. A '
  'reclassification changes what a bucket means, and a rollup that mixes two versions is '
  'comparing groups that were drawn differently.';

create index on scripts (hook_pattern) where hook_pattern is not null;

-- What a hook shape has actually earned. Keyed on the 7d bucket: 6h and 24h are still
-- moving, 30d is a tail measurement of distribution rather than of the hook, and mixing
-- buckets would compare a video's first day against another's first month.
create view v_hook_performance as
with measured as (
  select
    sc.hook_pattern,
    ms.retention_3s_pct,
    ms.views,
    p.id as publication_id
  from publications p
  join renders r            on r.id = p.render_id
  join scripts sc           on sc.id = r.script_id
  join metrics_snapshots ms on ms.publication_id = p.id and ms.age_bucket = '7d'
  where ms.status = 'measured'
    and sc.hook_pattern is not null
)
select
  m.hook_pattern,
  count(*)                        as videos_measured,
  -- Counted apart from videos_measured on purpose. A hook shape with eight videos and no
  -- retention on any of them has been used a lot and learned nothing, and the two numbers
  -- side by side say that; one number cannot.
  count(m.retention_3s_pct)       as videos_with_retention,
  -- Median, not mean: a single video that got picked up distorts a mean and this is meant
  -- to describe the typical outing. Null over an empty set, which is the correct answer
  -- and the one percentile_cont gives without help.
  --
  -- Cast to numeric, and not for tidiness. `percentile_cont` returns **double precision**
  -- whatever it is given, and a double crosses PostgREST as a JSON number while a numeric
  -- crosses as a string. A view mixing the two hands one column back as 12.5 and its
  -- neighbour as "12.500", which is the transport confusion CLAUDE.md's bigint rule is
  -- about, arriving from the other direction. It also failed outright the first time:
  -- `round(double, int)` does not exist in Postgres.
  (percentile_cont(0.5) within group (order by m.retention_3s_pct)
    filter (where m.retention_3s_pct is not null))::numeric as median_retention_3s_pct,
  min(m.retention_3s_pct)         as worst_retention_3s_pct,
  max(m.retention_3s_pct)         as best_retention_3s_pct,
  (percentile_cont(0.5) within group (order by m.views))::numeric as median_views
from measured m
group by m.hook_pattern;

-- ── And the rollup's own silence, read back ─────────────────────────────────
--
-- `v_hook_performance` groups on `hook_pattern`, so a video whose hook classified to null
-- contributes to no bucket. It is not under-counted in one row — it is **absent from every
-- row**, which means the rollup looks complete however many of them there are. That is the
-- failure CLAUDE.md describes as the hardest kind to notice: not a wrong number, a right
-- number about a quietly narrowed set.
--
-- So the excluded set is a view of its own, and `readMeasureBoard` reads it beside the
-- rollup. A screen showing "story_open retains best" over a corpus where a third of the
-- videos were never classified is making a claim about a sample it has not disclosed.
create view v_hook_unclassified as
select
  p.id                    as publication_id,
  p.channel_id,
  p.title,
  p.published_at,
  sc.id                   as script_id,
  sc.hook,
  -- Null here means no classifier has ever run on this script; a version with a null
  -- pattern means one ran and found nothing. Different problems: the first is a backfill,
  -- the second is a taxonomy gap.
  sc.hook_pattern_version
from publications p
join renders r  on r.id = p.render_id
join scripts sc on sc.id = r.script_id
where p.status = 'live'
  and sc.hook_pattern is null;

comment on view v_hook_unclassified is
  'Live publications the hook rollup cannot see, because their script has no hook_pattern. '
  'They are absent from every row of v_hook_performance rather than under-counted in one, '
  'so the rollup reads as complete without this beside it. hook_pattern_version separates '
  '"never classified" (backfill) from "classified and unrecognised" (taxonomy gap).';

comment on view v_hook_performance is
  'Retention by hook shape at 7d — the loop ARCHITECTURE §0.1 calls the moat, as rows. '
  'Median rather than mean because one video that got picked up should not redefine a '
  'shape. videos_with_retention is separate from videos_measured because a shape can be '
  'used eight times and teach nothing, and a single count hides that.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Two different things were both called `win_rate`
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0025 built `v_recipe_performance.win_rate` = shots shipped ÷ shots compiled, where
-- shipped means "reached a render a human passed". That is a real and useful number and it
-- measures **editorial survival**. It is not what a recipe winning means once outcomes
-- exist, and the operator's spec is explicit: backfill from real outcomes, replacing the
-- derived-from-compiles placeholder.
--
-- The tempting move is to redefine `win_rate` in place. That is CLAUDE.md's name-collision
-- failure being created deliberately: `compile.ts` weights selection by `winRate` and would
-- keep compiling, keep typechecking, and silently start weighting by a column that is null
-- for every recipe until the first video is measured — which is months. Every recipe would
-- score null, the weighting would go inert, and the file that documents the tier ordering
-- would again describe an effect that cannot occur. That is precisely the defect 0025
-- exists to have fixed.
--
-- So: rename the old one to what it measures, add the new one beside it, and make the
-- choice between them a column rather than a `coalesce` in a caller.

drop view v_recipe_coverage;    -- depends on v_recipe_performance; rebuilt below unchanged
drop view v_recipe_performance;

create view v_recipe_performance as
with compiled as (
  select s.prompt_id, count(*) as n, max(s.created_at) as last_at
    from shots s
   where s.prompt_id is not null
   group by s.prompt_id
),
shipped as (
  select s.prompt_id, count(distinct s.id) as n
    from shots s
    join renders r  on r.script_id = s.script_id
    join reviews rv on rv.render_id = r.id and rv.decision = 'pass'
   where s.prompt_id is not null
   group by s.prompt_id
),
-- Outcomes, joined the long way round: recipe → shot → script → render → publication →
-- snapshot. A recipe does not have a retention figure of its own; it inherits the videos
-- its shots appeared in, and `distinct` keeps a six-shot video from counting six times.
outcome as (
  select
    s.prompt_id,
    count(distinct p.id)                    as videos_measured,
    -- ::numeric for the same reason as in v_hook_performance — percentile_cont returns
    -- double precision, which round() has no overload for and PostgREST transports
    -- differently from every other number in this view.
    (percentile_cont(0.5) within group (order by ms.retention_3s_pct)
      filter (where ms.retention_3s_pct is not null))::numeric as median_retention_3s_pct,
    count(distinct p.id) filter (where ms.retention_3s_pct is not null)
                                            as videos_with_retention
  from shots s
  join renders r            on r.script_id = s.script_id
  join publications p       on p.render_id = r.id
  join metrics_snapshots ms on ms.publication_id = p.id and ms.age_bucket = '7d'
  where s.prompt_id is not null
    and ms.status = 'measured'
  group by s.prompt_id
)
select
  p.id                                as prompt_id,
  p.name,
  p.driver,
  p.model,
  p.is_active,
  coalesce(c.n, 0)                    as times_compiled,
  coalesce(sh.n, 0)                   as times_shipped,
  c.last_at                           as last_compiled_at,

  -- Editorial survival. Was `win_rate`; the name was the defect.
  case
    when coalesce(c.n, 0) = 0 then null
    else round(coalesce(sh.n, 0)::numeric / c.n, 3)
  end                                 as ship_rate,

  coalesce(o.videos_measured, 0)      as videos_measured,
  coalesce(o.videos_with_retention, 0) as videos_with_retention,

  -- Outcome, on its own scale (0–100 by the CHECK above) and NOT collapsed into ship_rate.
  o.median_retention_3s_pct,

  -- ── There is deliberately no `selection_score` column here ────────────────
  --
  -- The first draft had one — `coalesce(retention, ship_rate)` with a `selection_basis`
  -- beside it — and it was wrong in a way worth recording, because it looked like exactly
  -- the pattern this project uses everywhere else (a figure with a column saying how it
  -- was arrived at, as cost_ledger.cost_source and v_video_cost.denominator_state do).
  --
  -- The difference is that a basis is a property of **a decision over a set**, not of a
  -- row. Stage 4 ranks the recipes eligible for one shot kind against each other, and a
  -- per-row basis lets that comparison mix scales: a recipe with ship_rate 0.80 would
  -- outrank one with measured retention 0.35, on numbers that mean unrelated things, and
  -- the basis column would faithfully report that each row was fine. A view cannot see
  -- the set, so it cannot compute the only thing that makes the score safe.
  --
  -- So the two kinds of evidence stay separate here and `compileShot` owns the rule: rank
  -- on retention when every eligible recipe has it, on ship_rate otherwise, never across.
  -- One predicate, in the module that knows the set, and a column that would have looked
  -- authoritative and been unsound is absent instead.
  coalesce(c.n, 0) > 0                as has_shipped_evidence
from prompts p
left join compiled c  on c.prompt_id = p.id
left join shipped  sh on sh.prompt_id = p.id
left join outcome  o  on o.prompt_id = p.id;

comment on view v_recipe_performance is
  'What a recipe has earned, on two kinds of evidence kept apart and never combined here. '
  'ship_rate is editorial survival (shots that reached a passed review ÷ shots compiled) '
  'and was called win_rate until 0034 — the rename is the point, because the outcome '
  'number is what "winning" means now and redefining the old name in place would have '
  'left compile.ts weighting by a column that is null for months. '
  'median_retention_3s_pct is what the videos it appeared in actually did. There is no '
  'combined score: which evidence to rank on depends on the whole set of recipes eligible '
  'for a shot kind, which a per-row view cannot see. compileShot decides. '
  'Null, never zero, on a recipe nobody has tried.';

-- Rebuilt against the recreated view. Identical to 0025 except for the dependency: this
-- drop-and-recreate exists only because Postgres will not let v_recipe_performance change
-- shape underneath it.
create view v_recipe_coverage as
select
  k.shot_kind,
  count(p.id) filter (where p.is_active)                       as active_recipes,
  count(p.id)                                                  as total_recipes,
  coalesce(sum(rp.times_compiled) filter (where p.is_active), 0) as compiles,
  coalesce(sum(rp.times_shipped)  filter (where p.is_active), 0) as ships,
  case
    when coalesce(sum(rp.times_compiled) filter (where p.is_active), 0) = 0 then null
    else round(
      max(rp.times_compiled) filter (where p.is_active)::numeric
      / sum(rp.times_compiled) filter (where p.is_active), 3)
  end                                                          as top_recipe_share
from (select unnest(array[
        'establishing', 'subject_medium', 'detail_macro', 'action_insert',
        'environment_move', 'abstract', 'graphic_plate'
      ]) as shot_kind) k
left join prompts p on k.shot_kind = any(p.tags)
left join v_recipe_performance rp on rp.prompt_id = p.id
group by k.shot_kind
order by count(p.id) filter (where p.is_active), k.shot_kind;

comment on view v_recipe_coverage is
  'Recipes per shot kind and how concentrated their use is. One active recipe is a warning '
  'rather than a tick: every shot of that kind gets the same camera, and repeated identical '
  'camera moves are legible to a policy reviewer.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. The business question, finally divisible
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `v_cost_per_1k_views` has been "the only number that answers the business question"
-- since 0001 and has never had a caller. Rebuilt here for three reasons, each of which
-- would have produced a wrong number the first time anybody looked at it:
--
--   1. It read `v_render_cost`, which 0026 superseded with `v_video_cost` and 0032
--      rebuilt again — the one that keeps measured and rate-card spend apart and
--      represents an unknown cost as null. `v_render_cost` sums `cost_inr` with no
--      unpriced check, so a partially-priced video would have divided a too-small
--      numerator by views and reported a bargain.
--   2. `case when ms.views > 0` returns null for a video with zero views — correct — and
--      returns null for an unpriced one too, with no way to tell those apart. A screen
--      cannot say why it has no number.
--   3. It joined unconditionally, so an `unavailable` snapshot with null views would have
--      produced a row that looks measured.
--
-- The replacement carries `state` for the same reason `v_video_cost` carries
-- `denominator_state`: the reason there is no number is more useful than the absence.
--
-- ── Adding the two halves is this view's job, and saying so is the point ─────
--
-- 0032 splits incurred spend into `measured_inr` (a figure a vendor reported) and
-- `estimated_inr` (our own rate card), and says explicitly that a caller may add them and
-- that nothing there will do it for them. This is that caller. It adds them, because
-- rupees per thousand views is about total spend — and it carries `cost_basis` so the
-- addition never becomes invisible. A per-1k figure resting half on an estimate is a
-- different claim from one resting entirely on invoices, and the number alone cannot say
-- which.

drop view v_cost_per_1k_views;

create view v_cost_per_1k_views as
select
  p.id                     as publication_id,
  p.channel_id,
  p.title,
  p.published_at,
  vc.script_id,
  vc.measured_inr,
  vc.estimated_inr,
  -- ── A null half is not an unknown half, and the first draft of this got it wrong ──
  --
  -- `measured_inr` and `estimated_inr` are `sum() filter (…)`, so a video with no measured
  -- rows has `measured_inr = null` — a sum over an empty set, meaning **zero of that
  -- kind**, not an unknown amount. Adding them with `+` therefore nulled the total for
  -- every video priced entirely from the rate card, which is every video today.
  --
  -- What genuinely means unknown is `unpriced_incurred_rows > 0`, and 0032 already encodes
  -- that in `denominator_state`. So countability is read from there rather than
  -- re-derived: one predicate, in the view that owns it, instead of a second one here that
  -- can drift away from it.
  case
    when vc.denominator_state not in ('countable_measured', 'countable_estimated') then null
    else coalesce(vc.measured_inr, 0) + coalesce(vc.estimated_inr, 0)
  end                      as incurred_inr,
  vc.unpriced_incurred_rows,
  vc.denominator_state,
  ms.age_bucket,
  ms.status                as snapshot_status,
  ms.metric_source,
  ms.views,
  ms.retention_3s_pct,
  case
    when ms.status <> 'measured'                   then null
    when ms.views is null or ms.views = 0          then null
    when vc.denominator_state not in ('countable_measured', 'countable_estimated') then null
    else round(
      (coalesce(vc.measured_inr, 0) + coalesce(vc.estimated_inr, 0)) / (ms.views / 1000.0), 2)
  end                      as cost_per_1k_inr,
  -- Why there is no number, when there is no number. Three distinct reasons a bare null
  -- cannot tell apart, each of which means something different to a person looking at the
  -- screen: wait, look again, or fix the rate card.
  case
    when ms.status <> 'measured' or ms.views is null then 'not_measured'
    when ms.views = 0                                then 'no_views_yet'
    when vc.denominator_state not in ('countable_measured', 'countable_estimated')
                                                     then 'cost_unknown'
    else 'countable'
  end                      as state,
  -- Which evidence the figure rests on. Carried rather than derived at the screen because
  -- two callers deriving it differently is how one of them starts labelling an estimate as
  -- a measurement.
  --
  -- Read off `denominator_state` rather than off the two amounts: 0032's own definition of
  -- "countable_measured" is `estimated = 0 and measured <> 0`, and restating that test here
  -- would be a second copy of a rule that is allowed to change there.
  case
    when vc.denominator_state = 'countable_measured'  then 'measured'
    when vc.denominator_state = 'countable_estimated'
      then case when coalesce(vc.measured_inr, 0) = 0 then 'estimated' else 'mixed' end
    else null
  end                      as cost_basis
from publications p
join renders r            on r.id = p.render_id
join v_video_cost vc      on vc.script_id = r.script_id
join metrics_snapshots ms on ms.publication_id = p.id
where p.status = 'live';

comment on view v_cost_per_1k_views is
  'Rupees per thousand views, one row per (live publication, age bucket). Built on '
  'v_video_cost rather than the superseded v_render_cost, so a partially-priced video is '
  'null rather than a flatteringly small numerator. This is the caller 0032 anticipated: '
  'it adds measured_inr and estimated_inr, and carries cost_basis so that addition stays '
  'visible. state says WHY a row has no figure — not measured, no views yet, or cost '
  'unknown — because those need different responses. Filter on age_bucket at the caller; '
  'joining one bucket in was what made this view answer only one question.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0034', 'the_loop_closes', array['-- applied from a lean bundle; text in supabase/migrations/0034_the_loop_closes.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0035_publishing_and_the_one_quota_we_can_count.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0035 publishing_and_the_one_quota_we_can_count'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0035', 'publishing_and_the_one_quota_we_can_count', array['-- applied from a lean bundle; text in supabase/migrations/0035_publishing_and_the_one_quota_we_can_count.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0036_competitor_signal.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0036 competitor_signal'; end $kiln_progress$;

-- Migration 0036 — competitor signal, and a table that must never learn to hold a sentence
--
-- ─────────────────────────────────────────────────────────────
-- Addendum 04, §1, §2 and the safe half of §6. Queued since it was written; unblocked now
-- that stage 10 gave this codebase a quota mechanism that counts.
-- ─────────────────────────────────────────────────────────────
--
-- ── Why this outranks the scoring it sits beside ─────────────────────────────
--
-- `concepts.scores` rates an idea on velocity, saturation, IP risk and evergreen tail —
-- four reasonable guesses made before the fact. An outlier score measures something that
-- already happened: a video's views against its own channel's typical performance. 66k
-- views on a channel that usually gets 1k is not a video that succeeded because a large
-- channel published it; it is a video whose *idea* carried it, and that is the only signal
-- in this space grounded in an observed outcome rather than a prediction.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The channels we watch, and what we know about each
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `uploads_playlist_id` is not a convenience column. Addendum 04 is explicit about the
-- quota arithmetic and it is the difference between a daily poll that fits and one that
-- does not: reading a channel's uploads playlist costs **1 unit**; finding the same videos
-- through `search.list` costs **100**. Twenty channels daily is 20 units one way and 2,000
-- the other, against a 10,000/day allowance shared with uploads at 1,600 each.
--
-- Storing the playlist id means the cheap path is the only one available — a poller that
-- has to look the channel up each time is a poller somebody will one day rewrite to use
-- search because it is fewer lines.

create table tracked_channels (
  id                    uuid primary key default gen_random_uuid(),
  external_channel_id   text not null unique,
  title                 text not null,
  niche                 text not null,
  -- Resolved once at add time, then reused for ever. See above.
  uploads_playlist_id   text,

  -- ── The baseline, and why it is null far more often than it is a number ───
  --
  -- Null until the channel has enough videos for a median to mean anything. Addendum 04
  -- says ten; below that the "typical performance" of a channel is one or two videos and
  -- an outlier score against it is arithmetic on noise.
  --
  -- Absent is not zero, in the place where zero would be most damaging: a baseline of 0
  -- makes every outlier score infinite, which would put a brand-new channel's first video
  -- at the top of the ideas list for ever.
  baseline_median_views bigint check (baseline_median_views is null or baseline_median_views >= 0),
  baseline_video_count  integer not null default 0 check (baseline_video_count >= 0),
  baseline_computed_at  timestamptz,

  is_active             boolean not null default true,
  added_at              timestamptz not null default now(),
  last_polled_at        timestamptz,
  -- A poll that failed is a row, not a silence. Same reasoning as everywhere else here.
  last_error            text,
  poll_failures         integer not null default 0 check (poll_failures >= 0)
);

create index on tracked_channels (niche) where is_active;

comment on column tracked_channels.uploads_playlist_id is
  'The channel''s uploads playlist. Stored rather than looked up because reading it costs 1 '
  'quota unit and finding the same videos through search.list costs 100 — twenty channels '
  'daily is 20 units against 2,000. Keeping the cheap path the only available one is what '
  'stops somebody rewriting the poller to use search because it is fewer lines.';

comment on column tracked_channels.baseline_median_views is
  'Median views over the channel''s recent uploads, or NULL when there are fewer than ten '
  'to take a median of. Null rather than 0 in the one place where 0 is most dangerous: it '
  'is the divisor of every outlier score, so a zero baseline would make a new channel''s '
  'first video infinitely exceptional and pin it to the top of the ideas list.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The videos, and the score
-- ═════════════════════════════════════════════════════════════════════════════

create table competitor_videos (
  id                   uuid primary key default gen_random_uuid(),
  tracked_channel_id   uuid not null references tracked_channels(id) on delete cascade,
  external_video_id    text not null unique,
  title                text not null,
  published_at         timestamptz not null,
  views                bigint check (views is null or views >= 0),

  -- views ÷ the channel's baseline, at the moment it was computed. Null when the channel
  -- has no baseline — which is the common case and must not read as "scored zero".
  outlier_score        numeric check (outlier_score is null or outlier_score >= 0),
  -- The baseline this score was computed against, copied in. Without it a score is
  -- uninterpretable a month later: the channel's baseline moves, and 50× against a
  -- thousand and 50× against a hundred thousand are different findings.
  scored_against_views bigint,
  computed_at          timestamptz,

  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now()
);

create index on competitor_videos (tracked_channel_id, published_at desc);
create index on competitor_videos (outlier_score desc nulls last) where outlier_score is not null;

comment on column competitor_videos.scored_against_views is
  'The baseline the score was computed against, snapshotted. A bare multiple is '
  'uninterpretable later — 50× a thousand and 50× a hundred thousand are different '
  'findings — and the channel''s baseline moves under it.';

comment on column competitor_videos.views is
  'Null means the view count could not be read, which is not zero views. Every consumer '
  'that averages or ranks must exclude nulls rather than coalesce them.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. pacing_template — structure only, and the guard is the point
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Addendum 04 §6 rejects feeding competitors' transcripts to the script writer, and the
-- reason is not squeamishness: YouTube's inauthentic-content policy names readings of
-- material you did not create as an explicit violation, and this project's own script
-- provenance record would be the evidence against it in an appeal.
--
-- The safe version keeps most of the value — extract how many beats, how long the hook
-- runs, where the first tension release falls, the ratio of claim to example. Numbers and
-- shapes, no text.
--
--   **Structure is not copyrightable. Sentences are. That distinction is the whole thing.**
--
-- So every column here is numeric or a closed enum, and there is deliberately no `notes`,
-- no `summary`, no `raw`, no jsonb. The failure this prevents is not somebody maliciously
-- pasting a transcript. It is somebody adding `source_excerpt text` in eight months for a
-- perfectly good debugging reason, and the line being crossed by a column comment nobody
-- reads.
--
-- `check:pacing-columns` fails the build if a text, varchar, char, json or jsonb column is
-- ever added to this table. That is a guard for a state no write path produces, which this
-- codebase normally treats as a defect — and this is the documented exception, because the
-- point is not that the state is reachable today but that **none ever should be**. The
-- guard is the specification.

create table pacing_template (
  id                      uuid primary key default gen_random_uuid(),
  -- Which video it was measured from, by reference. The id is a foreign key rather than a
  -- copied string precisely so that nothing here needs to carry anything about content.
  competitor_video_id     uuid not null references competitor_videos(id) on delete cascade,

  beats                   integer not null check (beats > 0),
  hook_seconds            numeric not null check (hook_seconds > 0),
  first_release_seconds   numeric check (first_release_seconds is null or first_release_seconds >= 0),
  claim_to_example_ratio  numeric check (claim_to_example_ratio is null or claim_to_example_ratio >= 0),
  shot_changes            integer check (shot_changes is null or shot_changes >= 0),
  mean_shot_seconds       numeric check (mean_shot_seconds is null or mean_shot_seconds > 0),
  total_seconds           numeric not null check (total_seconds > 0),

  -- Closed vocabularies, not free text. An enum is a shape; a string is a sentence waiting
  -- to happen.
  cta_position            text check (cta_position in ('none', 'early', 'mid', 'end')),
  arc                     text check (arc in ('problem_solution', 'list', 'story', 'demonstration', 'contrarian')),

  measured_at             timestamptz not null default now(),
  -- Which extractor produced it, as concepts.rubric_version does. A version string is a
  -- version string; it is not a place to put prose, and check:pacing-columns does not care
  -- what the column is for — it is text, so it is the exception that has to be named.
  extractor_version       text not null
);

create index on pacing_template (competitor_video_id);

comment on table pacing_template is
  'Structure extracted from a high-performing video: counts, durations and ratios, never '
  'words. Addendum 04 §6 — structure is not copyrightable and sentences are, and a text '
  'column would cross that line silently. check:pacing-columns fails the build if one is '
  'added. That guard protects a state no write path produces, deliberately: the point is '
  'not that it is reachable but that none ever should be.';

comment on column pacing_template.extractor_version is
  'The one text column, and it is on the guard''s explicit exemption list. A version string '
  'names the code that measured, not the video that was measured. Any OTHER text column is '
  'a build failure.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. What reads this — the leaders, and the silence
-- ═════════════════════════════════════════════════════════════════════════════

create view v_outlier_leaders as
select
  cv.id                       as competitor_video_id,
  tc.id                       as tracked_channel_id,
  tc.title                    as channel_title,
  tc.niche,
  cv.title,
  cv.external_video_id,
  cv.published_at,
  cv.views,
  cv.outlier_score,
  cv.scored_against_views,
  cv.computed_at,
  now() - cv.published_at     as age
from competitor_videos cv
join tracked_channels tc on tc.id = cv.tracked_channel_id
where cv.outlier_score is not null
  -- Addendum 04: recent only. An outlier from three years ago describes an audience that
  -- has moved on, and it would sit at the top of the list for ever because nothing ages it
  -- out of a plain ORDER BY.
  and cv.published_at > now() - interval '90 days'
  and tc.is_active
order by cv.outlier_score desc;

comment on view v_outlier_leaders is
  'Recent videos that beat their own channel, best first — the ideas list. Scored rows '
  'only and 90 days only: an unscored video is not a weak one, and a three-year-old '
  'outlier describes an audience that has moved on but would otherwise sit at the top for '
  'ever.';

-- The instrument that reads the silence. `v_outlier_leaders` cannot show a channel that
-- has never been polled or has no baseline — such a channel contributes no rows at all,
-- so the leaderboard reads as complete while describing a fraction of what is tracked.
-- Same shape as v_hook_unclassified, for the same reason.
create view v_tracked_channel_health as
select
  tc.id                         as tracked_channel_id,
  tc.title,
  tc.niche,
  tc.is_active,
  tc.last_polled_at,
  tc.poll_failures,
  tc.last_error,
  tc.baseline_median_views,
  tc.baseline_video_count,
  tc.baseline_computed_at,
  (select count(*) from competitor_videos v where v.tracked_channel_id = tc.id)
                                as videos_known,
  (select count(*) from competitor_videos v
    where v.tracked_channel_id = tc.id and v.outlier_score is not null)
                                as videos_scored,
  -- The first reason this channel contributes nothing, earliest cause first. Null means it
  -- is contributing normally.
  case
    when tc.uploads_playlist_id is null            then 'no_uploads_playlist'
    when tc.last_polled_at is null                 then 'never_polled'
    when tc.baseline_video_count < 10              then 'too_few_videos_for_a_baseline'
    when tc.baseline_median_views is null          then 'no_baseline'
    when tc.baseline_median_views = 0              then 'baseline_is_zero'
    when not exists (
      select 1 from competitor_videos v
       where v.tracked_channel_id = tc.id
         and v.outlier_score is not null
         and v.published_at > now() - interval '90 days')
                                                   then 'nothing_recent_scored'
    else null
  end                           as blocker
from tracked_channels tc;

comment on view v_tracked_channel_health is
  'Why a tracked channel contributes nothing to the ideas list. Necessary because a '
  'channel with no baseline is absent from v_outlier_leaders entirely rather than '
  'under-represented in it — the leaderboard reads as complete however many are missing. '
  'baseline_is_zero is listed separately from no_baseline because they need opposite '
  'responses: one is a channel nobody watches, the other is a measurement not yet taken.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. `source = 'outlier'` on trend_signals
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Free, as Addendum 04 notes: the column has no CHECK, so nothing needs altering. Recorded
-- here anyway rather than left as folklore, because a value with no constraint and no
-- migration mentioning it is a value nobody can find the definition of.
--
-- Addendum 04 §5: competitor channels do not replace the other trend sources, they outrank
-- them — they measure what works on the platform rather than what people search for.

comment on column trend_signals.source is
  'Where the signal came from. No CHECK, deliberately: sources are added by writing them. '
  'Known values are the feed sources plus ''outlier'' (migration 0036), which is a video '
  'that beat its own channel — an observed outcome rather than a search volume, and '
  'therefore ranked above the others when concepts are generated.';

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0036', 'competitor_signal', array['-- applied from a lean bundle; text in supabase/migrations/0036_competitor_signal.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0037_bureau_of_reality.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0037 bureau_of_reality'; end $kiln_progress$;

-- 0037 — Bureau of Reality: the channel, its policy, the calendar, briefs, episodes, the
-- generation queue, the MCP control plane's tokens and its authorship log.
--
-- Reuses what exists (channels, characters, concepts, scripts, shots, generations, assets,
-- renders, reviews, publications, metrics_snapshots, cost_ledger, prompts) and adds only
-- what is missing. Decision 0012 records every deviation from the prompt that asked for it.
--
-- Forward-only. Contains ALTER … DROP CONSTRAINT/NOT NULL on constraints this migration
-- immediately re-adds in wider form, on tables that hold zero rows on the hosted project.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- ═════════════════════════════════════════════════════════════════════════════
-- The channel
-- ═════════════════════════════════════════════════════════════════════════════

alter table channels add column slug text unique;

insert into channels (id, name, platform, niche, handle, is_active, slug)
values (
  'b0000000-0000-4000-8000-000000000001',
  'Bureau of Reality',
  'youtube',
  'Original stickman workplace sitcom; each Short explains one real mechanism',
  null,
  true,
  'bureau-of-reality'
)
on conflict (id) do nothing;

comment on column channels.slug is
  'Stable handle for config that lives in the repo (channels/<slug>/). The UUID is the key; '
  'the slug is how a JSON file names the row it configures.';

-- FX: the operator chose ₹88/USD (operating plan v2.1). This is that choice, recorded, not a
-- default nobody set — fx.ts still refuses a null, and Settings → Workspace still changes it.
alter table profiles alter column usd_inr_rate set default 88;
update profiles set usd_inr_rate = 88 where usd_inr_rate is null;

-- ═════════════════════════════════════════════════════════════════════════════
-- Channel policy: caps, flags, variation thresholds, kill switch
-- ═════════════════════════════════════════════════════════════════════════════

create table channel_policy (
  channel_id                  uuid primary key references channels(id) on delete cascade,
  per_short_cap_inr           numeric not null default 150  check (per_short_cap_inr > 0),
  daily_cap_inr               numeric not null default 600  check (daily_cap_inr > 0),
  daily_longform_cap_inr      numeric not null default 1500 check (daily_longform_cap_inr > 0),
  monthly_cap_inr             numeric not null default 15000 check (monthly_cap_inr > 0),
  monthly_cap_after_gate2_inr numeric not null default 25000 check (monthly_cap_after_gate2_inr > 0),
  gate2_passed_at             timestamptz,
  daily_publish_cap           int     not null default 1 check (daily_publish_cap >= 0),
  default_slot_time           time    not null default '18:00',
  slot_timezone               text    not null default 'Asia/Kolkata',
  kill_switch                 boolean not null default false,
  kill_switch_reason          text,
  kill_switch_at              timestamptz,
  youtube_api_audited         boolean not null default false,
  instagram_publish_enabled   boolean not null default false,
  variation_window            int     not null default 14  check (variation_window between 1 and 200),
  variation_min_axes          int     not null default 4   check (variation_min_axes between 1 and 7),
  similarity_window           int     not null default 60  check (similarity_window between 1 and 500),
  similarity_max              numeric not null default 0.85 check (similarity_max > 0 and similarity_max <= 1),
  hook_archetype_weekly_max   int     not null default 2 check (hook_archetype_weekly_max >= 1),
  catchphrase_weekly_max      int     not null default 1 check (catchphrase_weekly_max >= 0),
  overlay_min_share           numeric not null default 0.5 check (overlay_min_share between 0 and 1),
  character_beat_max_s        numeric not null default 8 check (character_beat_max_s >= 0),
  money_shot_max              int     not null default 1 check (money_shot_max >= 0),
  rerolls_max                 int     not null default 2 check (rerolls_max between 0 and 5),
  updated_at                  timestamptz not null default now(),
  updated_by                  text,
  check (kill_switch = false or kill_switch_at is not null)
);

comment on table channel_policy is
  'Server-side caps and switches. Only the approver scope writes this table (caps_set, '
  'kill_switch); every write is mirrored into authorship_log by the caller.';
comment on column channel_policy.youtube_api_audited is
  'False → no upload; publish_bundles produces a bundle for manual Studio scheduling.';
comment on column channel_policy.instagram_publish_enabled is
  'False until Meta app review clears (CLAUDE.md current phase). The code path exists and refuses.';

insert into channel_policy (channel_id)
values ('b0000000-0000-4000-8000-000000000001')
on conflict (channel_id) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Characters: the cast is a row per character, keyed by the bible's slug
-- ═════════════════════════════════════════════════════════════════════════════

alter table characters
  add column channel_id        uuid references channels(id) on delete cascade,
  add column slug              text,
  add column role              text,
  add column accent_hex        text check (accent_hex is null or accent_hex ~ '^#[0-9A-Fa-f]{6}$'),
  add column voice_id          text,
  add column on_screen         boolean not null default true,
  add column season_introduced int not null default 1,
  add column bible             jsonb not null default '{}',
  add column synced_at         timestamptz;

-- A Bureau character exists before its vendor reference does (Prompt B mints those later),
-- so the reference is optional — but a reference without a driver is meaningless.
alter table characters alter column external_ref_id drop not null;
alter table characters alter column driver drop not null;
alter table characters add constraint characters_ref_has_driver
  check (external_ref_id is null or driver is not null);
-- A full constraint, not a partial index: ON CONFLICT (channel_id, slug) cannot target a
-- partial index without repeating its predicate, and NULL slugs are distinct anyway.
alter table characters add constraint characters_channel_slug_key unique (channel_id, slug);

comment on column characters.voice_id is
  'The designed voice for this character at the TTS vendor. Null = not designed yet; the '
  'voice stage refuses a line for a character without one rather than using a stand-in.';

-- ═════════════════════════════════════════════════════════════════════════════
-- MCP tokens: approver vs agent, hashed
-- ═════════════════════════════════════════════════════════════════════════════

create table mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  scope        text not null check (scope in ('approver', 'agent')),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null,
  profile_id   uuid references profiles(id) on delete set null,
  channel_id   uuid not null references channels(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  check (scope <> 'approver' or profile_id is not null)
);

comment on table mcp_tokens is
  'Bearer tokens for /api/mcp''s Bureau tools. Only the SHA-256 is stored. An approver token '
  'names the person whose decisions it records — reviews.reviewer_id needs a human.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Authorship log: append-only appeal evidence
-- ═════════════════════════════════════════════════════════════════════════════

create table authorship_log (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default clock_timestamp(),
  channel_id   uuid references channels(id) on delete cascade,
  actor_scope  text not null check (actor_scope in ('approver', 'agent', 'ui', 'system')),
  token_id     uuid references mcp_tokens(id) on delete set null,
  profile_id   uuid,
  action       text not null,
  subject_type text not null,
  subject_id   text not null,
  exact_text   text,
  payload      jsonb not null default '{}'
);
create index on authorship_log (subject_type, subject_id, occurred_at);
create index on authorship_log (occurred_at desc);

create function authorship_log_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'authorship_log is append-only: % refused', tg_op;
end $$;

create trigger authorship_log_append_only
  before update or delete on authorship_log
  for each row execute function authorship_log_is_append_only();

comment on table authorship_log is
  'Every approve/reject/caps/kill-switch decision with the exact text and a timestamp. The '
  'channel''s evidence of human authorship in an appeal, so it cannot be edited or deleted.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The calendar
-- ═════════════════════════════════════════════════════════════════════════════

create table slots (
  id           text primary key check (id ~ '^(S[0-9]{3}|L[0-9]{2}|B[0-9]{2})$'),
  channel_id   uuid not null references channels(id) on delete cascade,
  kind         text not null check (kind in ('short', 'long_form', 'bank')),
  slot_date    date,
  series       text not null check (series in
                 ('incident','desk_tour','pip','archive','myth','deep','complaint','long_form','sequel')),
  series_name  text not null,
  lead         text,
  episode      text check (episode is null or episode ~ '^S[0-9]+E[0-9]+$'),
  topic        text not null,
  hook         text,
  seasonal_tag text,
  topic_status text not null check (topic_status in ('approved', 'planned', 'bank')),
  notes        text,
  created_at   timestamptz not null default now(),
  check ((kind = 'bank') = (slot_date is null)),
  check ((kind = 'bank') = (id like 'B%')),
  check ((kind = 'long_form') = (id like 'L%'))
);
create index on slots (channel_id, slot_date);

comment on column slots.topic_status is
  'The calendar''s planning state for the TOPIC, from the CSV. Production state is derived '
  '(v_slot_status) from briefs and episodes, never stored here — two homes for one fact drift.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Comments (before briefs: a Complaint Box brief names the comment it came from)
-- ═════════════════════════════════════════════════════════════════════════════

create table comments (
  id                 uuid primary key default gen_random_uuid(),
  channel_id         uuid not null references channels(id) on delete cascade,
  publication_id     uuid references publications(id) on delete set null,
  platform           text not null check (platform in ('youtube', 'instagram')),
  external_id        text not null,
  parent_external_id text,
  author_handle      text,
  is_public          boolean not null default true,
  body               text not null,
  like_count         int check (like_count is null or like_count >= 0),
  reply_count        int check (reply_count is null or reply_count >= 0),
  published_at       timestamptz,
  fetched_at         timestamptz not null default now(),
  character_mentions text[] not null default '{}',
  is_question        boolean not null default false,
  complaint_score    numeric,
  used_in_brief_id   uuid,
  unique (platform, external_id)
);
create index on comments (channel_id, published_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- Briefs: Tap 1
-- ═════════════════════════════════════════════════════════════════════════════

create table briefs (
  id                    uuid primary key default gen_random_uuid(),
  channel_id            uuid not null references channels(id) on delete cascade,
  slot_id               text references slots(id),
  series                text not null check (series in
                          ('incident','desk_tour','pip','archive','myth','deep','complaint','long_form')),
  season                int check (season is null or season > 0),
  episode               int check (episode is null or episode > 0),
  lead_character        text not null,
  supporting_characters text[] not null default '{}',
  desk                  text not null,
  premise               text not null check (length(premise) between 10 and 300),
  premise_type          text not null,
  structure_variant     text not null,
  ending_type           text not null,
  music_bed             text not null,
  hook_archetype        text not null check (hook_archetype in
                          ('question','contradiction','number_claim','warning','story_open','direct_address','demonstration')),
  catchphrase_used      text,
  punchlines            jsonb not null check (jsonb_typeof(punchlines) = 'array' and jsonb_array_length(punchlines) = 3),
  beat_sheet            jsonb not null check (jsonb_typeof(beat_sheet) = 'array'),
  script_text           text not null,
  shot_list             jsonb not null default '[]' check (jsonb_typeof(shot_list) = 'array'),
  fact                  jsonb not null check (fact ? 'claim' and fact ? 'source_url'),
  titles                jsonb not null check (jsonb_typeof(titles) = 'array' and jsonb_array_length(titles) = 3),
  pinned_comment        text not null,
  estimate_inr          numeric check (estimate_inr is null or estimate_inr >= 0),
  estimate_basis        jsonb,
  tags                  text[] not null default '{}',
  flagged               boolean not null default false,
  flag_reasons          text[] not null default '{}',
  variation             jsonb,
  policy                jsonb,
  script_embedding      extensions.vector(768),
  title_embedding       extensions.vector(768),
  embedding_model       text,
  source_comment_id     uuid references comments(id) on delete set null,
  status                text not null default 'pending'
                          check (status in ('pending', 'approved', 'rejected', 'superseded')),
  chosen_punchline      text,
  approved_edits        jsonb,
  approved_at           timestamptz,
  approved_by_token     uuid references mcp_tokens(id) on delete set null,
  rejected_at           timestamptz,
  reject_reason         text,
  created_by            text not null check (created_by in ('agent', 'approver', 'ui', 'system')),
  created_by_token      uuid references mcp_tokens(id) on delete set null,
  created_at            timestamptz not null default now(),
  check (series <> 'pip' or (season is not null and episode is not null)),
  check (status <> 'approved' or (approved_at is not null and chosen_punchline is not null)),
  check (status <> 'rejected' or (rejected_at is not null and reject_reason is not null)),
  check (array_length(regexp_split_to_array(trim(script_text), '\s+'), 1) <= case when series = 'long_form' then 2000 else 150 end)
);
create unique index briefs_one_live_per_slot on briefs (slot_id)
  where slot_id is not null and status in ('pending', 'approved');
create index on briefs (channel_id, status, created_at desc);

alter table comments add constraint comments_used_in_brief_fkey
  foreign key (used_in_brief_id) references briefs(id) on delete set null;

comment on column briefs.estimate_inr is
  'Null = unpriced (an unverified rate somewhere in the shot list). Never zero for unknown.';
comment on column briefs.flagged is
  'Submitted despite failing variation or policy after two rewrites; flag_reasons names the '
  'axes. A flagged brief can still be approved — the approver sees why it was flagged.';

create table fact_sources (
  id           uuid primary key default gen_random_uuid(),
  brief_id     uuid not null references briefs(id) on delete cascade,
  claim        text not null,
  url          text not null check (url ~ '^https?://'),
  domain       text not null,
  source_class text not null check (source_class in
                 ('gov','edu','space_agency','met_ocean_agency','museum','peer_reviewed','standards_body','other')),
  title        text,
  checked_at   timestamptz,
  http_status  int,
  created_at   timestamptz not null default now()
);
create index on fact_sources (brief_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- Episodes: one per approved brief; the spine of the workflow
-- ═════════════════════════════════════════════════════════════════════════════

create table episodes (
  id               uuid primary key default gen_random_uuid(),
  brief_id         uuid not null unique references briefs(id) on delete cascade,
  channel_id       uuid not null references channels(id) on delete cascade,
  slot_id          text references slots(id),
  concept_id       uuid references concepts(id) on delete set null,
  script_id        uuid references scripts(id) on delete set null,
  status           text not null default 'queued' check (status in
                     ('queued','scripting','shotlisting','estimating','generating','qc','voicing',
                      'assembling','awaiting_cut','cut_approved','cut_rejected','bundled',
                      'scheduled','live','failed','halted')),
  status_detail    text,
  run_id           text,
  cut_wait_token   text,
  estimate_inr     numeric,
  final_render_id  uuid references renders(id) on delete set null,
  master_render_id uuid references renders(id) on delete set null,
  review_id        uuid references reviews(id) on delete set null,
  publication_id   uuid references publications(id) on delete set null,
  qc               jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on episodes (channel_id, status);

-- ═════════════════════════════════════════════════════════════════════════════
-- Shots and renders: the Bureau's routes and layers
-- ═════════════════════════════════════════════════════════════════════════════

alter table shots
  add column render_route    text check (render_route is null or render_route in
                               ('overlay','character_beat','acted_beat','money_shot')),
  add column character_slugs text[] not null default '{}',
  add column overlay_spec    jsonb,
  add column realistic       boolean not null default false,
  add column beat_id         text;

comment on column shots.render_route is
  'Which engine renders the shot. Distinct from shot_kind (framing vocabulary for recipes) '
  'on purpose: two adjacent concepts sharing a name is the collision CLAUDE.md warns about.';
comment on column shots.realistic is
  'True only for a photoreal money shot. Drives containsSyntheticMedia on the bundle.';

alter table renders
  add column layer    text not null default 'composite'
                      check (layer in ('composite','clean_master','caption_layer','longform')),
  add column language text not null default 'en';

comment on column renders.layer is
  'clean_master = no burned text (the localisation base). caption_layer = text only, '
  'transparent, one per language. composite = master + English captions, the cut Sahil approves.';

-- ═════════════════════════════════════════════════════════════════════════════
-- The generation queue
-- ═════════════════════════════════════════════════════════════════════════════

create table provider_limits (
  provider        text primary key,
  max_concurrency int not null check (max_concurrency > 0),
  updated_at      timestamptz not null default now()
);
insert into provider_limits (provider, max_concurrency) values
  ('higgsfield', 10), ('gemini', 5), ('runway', 3), ('fal', 5)
on conflict (provider) do nothing;

create table gen_jobs (
  id              uuid primary key default gen_random_uuid(),
  episode_id      uuid references episodes(id) on delete cascade,
  shot_id         uuid references shots(id) on delete cascade,
  render_route    text not null check (render_route in ('character_beat','acted_beat','money_shot')),
  provider        text not null references provider_limits(provider),
  model           text not null,
  endpoint        text,
  params          jsonb not null,
  prompt_id       uuid references prompts(id),
  duration_s      numeric not null check (duration_s > 0),
  estimate_inr    numeric,
  status          text not null default 'queued' check (status in
                    ('queued','claimed','submitted','succeeded','failed','throttled','cancelled')),
  attempts        int not null default 0 check (attempts >= 0),
  max_attempts    int not null default 3 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  idempotency_key text not null unique,
  request_id      text,
  poll_ref        jsonb not null default '{}',
  generation_id   uuid references generations(id) on delete set null,
  failover_of     uuid references gen_jobs(id) on delete set null,
  reroll_of       uuid references gen_jobs(id) on delete set null,
  reroll_index    int not null default 0 check (reroll_index >= 0),
  note            text,
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  last_error_code text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on gen_jobs (provider, status, next_attempt_at);
create index on gen_jobs (episode_id);
create unique index gen_jobs_request_key on gen_jobs (provider, request_id) where request_id is not null;

comment on table gen_jobs is
  'The generation queue. claim_gen_jobs() hands out work with FOR UPDATE SKIP LOCKED inside '
  'a per-provider advisory lock, so concurrency is enforced by the database rather than by '
  'how many workers happen to be running.';

-- Is generation halted for the channel a job belongs to?
create function channel_killed(p_channel uuid) returns boolean language sql stable as $$
  select coalesce((select kill_switch from channel_policy where channel_id = p_channel), false)
$$;

create function claim_gen_jobs(p_provider text, p_worker text, p_max int)
returns setof gen_jobs
language plpgsql as $$
declare
  cap      int;
  inflight int;
  room     int;
begin
  -- Serialise the capacity arithmetic per provider. SKIP LOCKED alone stops two workers
  -- claiming the same row; it does not stop two workers each seeing 9 in flight and both
  -- claiming the tenth slot.
  perform pg_advisory_xact_lock(hashtext('gen_jobs:' || p_provider));

  select max_concurrency into cap from provider_limits where provider = p_provider;
  if cap is null then
    raise exception 'no provider_limits row for %', p_provider;
  end if;

  select count(*) into inflight from gen_jobs
   where provider = p_provider and status in ('claimed', 'submitted');

  room := least(greatest(cap - inflight, 0), greatest(p_max, 0));
  if room = 0 then
    return;
  end if;

  return query
  update gen_jobs j
     set status = 'claimed', locked_at = now(), locked_by = p_worker,
         attempts = j.attempts + 1, updated_at = now()
   where j.id in (
     select q.id
       from gen_jobs q
       left join episodes e on e.id = q.episode_id
      where q.provider = p_provider
        and q.status in ('queued', 'throttled')
        and q.next_attempt_at <= now()
        and q.attempts < q.max_attempts
        and (e.channel_id is null or not channel_killed(e.channel_id))
      order by q.created_at
      for update of q skip locked
      limit room)
  returning j.*;
end $$;

comment on function claim_gen_jobs is
  'Claim up to p_max jobs for one provider without exceeding provider_limits.max_concurrency, '
  'skipping rows another worker holds and any job on a killed channel.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Metrics: the gates the plan measures
-- ═════════════════════════════════════════════════════════════════════════════

alter table metrics_snapshots drop constraint metrics_snapshots_age_bucket_check;
alter table metrics_snapshots add constraint metrics_snapshots_age_bucket_check
  check (age_bucket in ('1h', '6h', '24h', '72h', '7d', '30d'));

alter table metrics_snapshots drop constraint metrics_snapshots_metric_source_check;
alter table metrics_snapshots add constraint metrics_snapshots_metric_source_check
  check (metric_source in ('manual_entry', 'vendor_api', 'studio_csv'));

alter table metrics_snapshots
  add column engaged_views        bigint check (engaged_views is null or engaged_views >= 0),
  add column viewed_vs_swiped_pct numeric check (viewed_vs_swiped_pct is null or viewed_vs_swiped_pct between 0 and 100),
  add column subs_gained          int;

comment on column metrics_snapshots.viewed_vs_swiped_pct is
  'Shorts "viewed vs swiped away", 0–100. Not exposed by the Analytics API as of writing, so '
  'it arrives by Studio CSV import (metric_source = studio_csv). Null = not imported, never 0.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Publications: bundle, kids flag, links to the episode and slot
-- ═════════════════════════════════════════════════════════════════════════════

alter table publications
  add column platform            text not null default 'youtube' check (platform in ('youtube', 'instagram')),
  add column made_for_kids       boolean not null default false,
  add column bundle              jsonb,
  add column episode_id          uuid references episodes(id) on delete set null,
  add column slot_id             text references slots(id),
  add column marked_scheduled_at timestamptz;

comment on column publications.made_for_kids is
  'Always false for this channel (adult office satire). Stored per row because the upload '
  'call needs it and a bundle copied into Studio must carry it.';

-- Kill switch and daily publish cap — enforced where enforce_review_pass is, in the
-- database. Separate trigger: that one is the compliance gate (rule 7) and stays untouched.
create function enforce_channel_policy() returns trigger language plpgsql as $$
declare
  pol channel_policy%rowtype;
  same_day int;
begin
  if new.status not in ('scheduled', 'uploading', 'live') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('scheduled', 'uploading', 'live') then
    return new;  -- already past the gate; status moving along the same lane
  end if;

  select * into pol from channel_policy where channel_id = new.channel_id;
  if not found then
    return new;
  end if;

  if pol.kill_switch then
    raise exception 'publication % blocked: kill switch is on for channel %', new.id, new.channel_id;
  end if;

  if new.scheduled_for is not null then
    select count(*) into same_day from publications p
     where p.channel_id = new.channel_id
       and p.platform = new.platform
       and p.id <> new.id
       and p.status in ('scheduled', 'uploading', 'live')
       and (p.scheduled_for at time zone pol.slot_timezone)::date
           = (new.scheduled_for at time zone pol.slot_timezone)::date;
    if same_day >= pol.daily_publish_cap then
      raise exception 'publication % blocked: daily publish cap % reached for %',
        new.id, pol.daily_publish_cap, (new.scheduled_for at time zone pol.slot_timezone)::date;
    end if;
  end if;
  return new;
end $$;

create trigger publications_channel_policy
  before insert or update of status on publications
  for each row execute function enforce_channel_policy();

-- ═════════════════════════════════════════════════════════════════════════════
-- Dubs, strategy memos, notifications
-- ═════════════════════════════════════════════════════════════════════════════

create table dub_jobs (
  id                uuid primary key default gen_random_uuid(),
  episode_id        uuid not null references episodes(id) on delete cascade,
  language          text not null check (language in ('hi', 'es', 'pt-BR')),
  status            text not null default 'queued' check (status in
                      ('queued','translating','voicing','rendering','ready','failed','cancelled')),
  requested_by      text not null check (requested_by in ('agent', 'approver', 'ui', 'system')),
  token_id          uuid references mcp_tokens(id) on delete set null,
  translated_lines  jsonb,
  audio_asset_id    uuid references assets(id) on delete set null,
  caption_render_id uuid references renders(id) on delete set null,
  estimate_inr      numeric,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (episode_id, language)
);

create table strategy_memos (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  week_of    date not null,
  body       text not null check (length(body) <= 4000),
  gates      jsonb not null default '{}',
  created_by text not null check (created_by in ('agent', 'approver', 'system')),
  token_id   uuid references mcp_tokens(id) on delete set null,
  created_at timestamptz not null default now()
);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid references channels(id) on delete cascade,
  kind       text not null check (kind in
               ('briefs_pending','cut_ready','cap_80','policy_flag','qc_failed','kill_switch','info')),
  dedupe_key text unique,
  text       text not null,
  delivered  boolean not null,
  detail     text,
  created_at timestamptz not null default now()
);

comment on table notifications is
  'Every attempted alert and whether it was delivered. A missed alert is a row you can '
  'select, not a log line nobody opens. dedupe_key stops a cap-at-80% alert firing hourly.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Views
-- ═════════════════════════════════════════════════════════════════════════════

-- The money that counts: a generation's reconcile replaces its estimate; refunds subtract.
create view v_ledger_effective as
select a.*,
       a.script_id as eff_script_id,
       coalesce(a.channel_id, c.channel_id) as eff_channel_id
  from v_cost_attributed a
  left join scripts s  on s.id = a.script_id
  left join concepts c on c.id = s.concept_id
 where a.entry_kind in ('reconcile', 'refund')
    or a.generation_id is null
    or not exists (
         select 1 from cost_ledger r
          where r.generation_id = a.generation_id and r.entry_kind = 'reconcile');

create view v_episode_spend as
select e.id as episode_id, e.channel_id, e.brief_id,
       coalesce(sum(l.cost_inr), 0) as spent_inr,
       count(l.id) filter (where l.cost_inr is null) as unpriced_rows
  from episodes e
  left join v_ledger_effective l on l.eff_script_id = e.script_id
 group by e.id;

create view v_channel_spend as
select p.channel_id,
       coalesce(sum(l.cost_inr) filter (
         where (l.occurred_at at time zone p.slot_timezone)::date
             = (now() at time zone p.slot_timezone)::date), 0) as today_inr,
       coalesce(sum(l.cost_inr) filter (
         where date_trunc('month', l.occurred_at at time zone p.slot_timezone)
             = date_trunc('month', now() at time zone p.slot_timezone)), 0) as month_inr,
       p.daily_cap_inr,
       p.daily_longform_cap_inr,
       case when p.gate2_passed_at is null then p.monthly_cap_inr else p.monthly_cap_after_gate2_inr end
         as monthly_cap_effective_inr,
       p.per_short_cap_inr,
       p.kill_switch
  from channel_policy p
  left join v_ledger_effective l on l.eff_channel_id = p.channel_id
 group by p.channel_id, p.slot_timezone, p.daily_cap_inr, p.daily_longform_cap_inr,
          p.gate2_passed_at, p.monthly_cap_inr, p.monthly_cap_after_gate2_inr,
          p.per_short_cap_inr, p.kill_switch;

-- Production state of a slot, derived. Null brief = nobody has drafted it yet.
create view v_slot_status as
select s.*,
       b.id as brief_id, b.status as brief_status, b.flagged,
       e.id as episode_id, e.status as episode_status,
       case
         when e.status is not null then e.status
         when b.status = 'pending' then 'needs_approval'
         when b.status = 'approved' then 'approved'
         else 'open'
       end as production_status,
       (s.slot_date + p.default_slot_time) at time zone p.slot_timezone as publish_at
  from slots s
  join channel_policy p on p.channel_id = s.channel_id
  left join lateral (
    select * from briefs b
     where b.slot_id = s.id and b.status in ('pending', 'approved')
     order by b.created_at desc limit 1) b on true
  left join episodes e on e.brief_id = b.id;

-- The variation ledger: one row per brief that counts as "an episode" for the 4-of-7 rule.
create view v_variation_ledger as
select b.id as brief_id, b.channel_id, b.series, b.lead_character as lead, b.desk,
       b.premise_type, b.structure_variant, b.ending_type, b.music_bed,
       b.hook_archetype, b.catchphrase_used,
       coalesce(s.slot_date, b.approved_at::date, b.created_at::date) as on_date,
       b.status, b.created_at
  from briefs b
  left join slots s on s.id = b.slot_id
 where b.status in ('approved', 'pending');

create view v_gen_queue as
select l.provider, l.max_concurrency,
       count(*) filter (where q.status = 'queued')    as queued,
       count(*) filter (where q.status = 'throttled') as throttled,
       count(*) filter (where q.status in ('claimed','submitted')) as in_flight,
       count(*) filter (where q.status = 'failed'
                          and q.updated_at > now() - interval '24 hours') as failed_24h,
       count(*) filter (where q.status = 'succeeded'
                          and q.updated_at > now() - interval '24 hours') as succeeded_24h
  from provider_limits l
  left join gen_jobs q on q.provider = l.provider
 group by l.provider, l.max_concurrency;

-- Similarity search over the last N briefs. search_path includes extensions so the vector
-- operator resolves on Supabase and on a plain Postgres with pgvector alike.
create function brief_similarity(p_channel uuid, p_embedding extensions.vector, p_window int, p_exclude uuid)
returns table (brief_id uuid, similarity double precision)
language sql stable
set search_path = public, extensions
as $$
  select b.id, 1 - (b.script_embedding <=> p_embedding)
    from (select id, script_embedding from briefs
           where channel_id = p_channel and script_embedding is not null
             and status in ('approved', 'pending')
             and (p_exclude is null or id <> p_exclude)
           order by created_at desc limit p_window) b
   order by 2 desc
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Integration rows for the catalogue's new entries (check:catalog requires them)
-- ═════════════════════════════════════════════════════════════════════════════

alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('llm', 'video', 'audio', 'storage', 'mcp', 'channel', 'notify'));

insert into integrations (slug, kind, is_enabled) values
  ('gemini',    'video',   false),
  ('runway',    'video',   false),
  ('instagram', 'channel', false),
  ('slack',     'notify',  false)
on conflict (slug) do nothing;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0037', 'bureau_of_reality', array['-- applied from a lean bundle; text in supabase/migrations/0037_bureau_of_reality.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0038_calendar_seed.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0038 calendar_seed'; end $kiln_progress$;

-- 0038 — the topic calendar, seeded from data/kiln-topic-calendar.csv.
--
-- GENERATED by scripts/calendar-sql.mjs --write. Do not edit by hand; `pnpm check:calendar`
-- fails if this file and the CSV disagree. 164 dated Shorts (S###), 12 long-form (L##),
-- 16 bank slots (B##).

insert into slots (id, channel_id, kind, slot_date, series, series_name, lead, episode, topic, hook, seasonal_tag, topic_status, notes) values
  ('S001', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-19', 'incident', 'Incident Report', 'pip+marlo', null, 'What if the Moon vanished', 'Pip misplaced the Moon. Here''s everything that breaks by Friday.', null, 'approved', 'launch batch'),
  ('S002', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-20', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why fireworks have colours (metal salts)', 'Every firework colour is a different metal, burning loud. The Chemistry Desk explains.', 'dussehra', 'approved', 'launch batch'),
  ('S003', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-21', 'pip', 'Pip''s First Year', 'pip', 'S1E1', 'Orientation: what gravity actually is', 'Welcome to the Bureau of Reality. Please don''t touch the gravity.', null, 'approved', 'launch batch'),
  ('S004', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-22', 'archive', 'The Archive', 'nib', null, 'Dancing Plague of 1518', 'In 1518 a whole town danced for weeks and couldn''t stop. Nib pulled the file.', null, 'approved', 'launch batch'),
  ('S005', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-23', 'myth', 'Myth Desk', 'kaz', null, 'Ravana''s ten heads: popular interpretations', 'Ten heads, one king. Here''s what each head is said to mean.', null, 'approved', 'launch batch'),
  ('S006', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-24', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why Venus spins backwards', 'On Venus the sun rises in the west. Somebody at the Planet Desk messed up.', null, 'approved', 'launch batch'),
  ('S007', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-25', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why phone batteries die in the cold', 'A viewer says their phone dies every winter. The Battery Desk has excuses.', null, 'approved', 'launch batch'),
  ('S008', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-26', 'incident', 'Incident Report', 'pip+marlo', null, 'What if humans glowed like jellyfish', 'Pip spilled the Glow Desk''s entire supply on humanity.', null, 'approved', 'launch batch'),
  ('S009', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-27', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why leaves turn orange (carotenoids)', 'The leaves aren''t turning orange. They were orange the whole time.', null, 'approved', 'launch batch'),
  ('S010', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-28', 'pip', 'Pip''s First Year', 'pip', 'S1E2', 'Deja vu', 'Pip filed the same Tuesday twice. Now everyone has deja vu.', null, 'approved', 'launch batch'),
  ('S011', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-29', 'archive', 'The Archive', 'nib', null, 'Mary Celeste', 'A ship found sailing perfectly, with nobody on board. Case reopened.', null, 'approved', 'launch batch'),
  ('S012', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-30', 'myth', 'Myth Desk', 'kaz', null, 'Samhain to Halloween, and India''s ancestor fortnight', 'Before candy there was Samhain, and India has its own season for honouring ancestors.', 'halloween', 'approved', 'launch batch'),
  ('S013', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-10-31', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Vampire squid', 'The vampire squid is neither a vampire nor a squid. The Deep Desk is furious.', 'halloween', 'approved', 'launch batch'),
  ('S014', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-01', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why Daylight Saving Time exists', 'Tonight America gets an extra hour. Mrs. Iyer wants it back.', 'us_dst_end', 'approved', 'launch batch'),
  ('S015', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-02', 'incident', 'Incident Report', 'pip+marlo', null, 'What if Earth spun twice as fast', 'Pip found the Earth''s speed dial.', null, 'planned', null),
  ('S016', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-03', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why flames point up (and are spheres in space)', 'In space a flame is a ball. Down here the Fire Desk makes it point up.', null, 'planned', null),
  ('S017', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-04', 'pip', 'Pip''s First Year', 'pip', 'S1E3', 'How eyes see colour (Diwali lights)', 'Director Ohm''s memo: light up a billion homes. Don''t blow a fuse.', 'diwali', 'planned', null),
  ('S018', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-05', 'archive', 'The Archive', 'nib', null, 'Antikythera mechanism', 'Divers found a 2,000-year-old computer in a shipwreck.', null, 'planned', null),
  ('S019', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-06', 'myth', 'Myth Desk', 'kaz', null, 'Samudra Manthan and Dhanvantari', 'Gods and demons played tug-of-war with a serpent to churn an ocean. Kaz has the minutes.', 'dhanteras', 'planned', null),
  ('S020', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-07', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why the new moon is invisible', 'Diwali falls on the darkest night of the month. That''s not an accident.', 'diwali', 'planned', null),
  ('S021', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-08', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why Diwali''s date moves (lunisolar calendar)', 'Mrs. Iyer: ''Diwali didn''t move. Your calendar did.''', 'diwali', 'planned', null),
  ('S022', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-09', 'incident', 'Incident Report', 'pip+marlo', null, 'What if every light on Earth switched on at once (grid load)', 'Pip plugged in every light on Earth at once. The Grid Desk is not okay.', 'diwali', 'planned', null),
  ('S023', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-10', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why siblings look alike but differ (genetic shuffle)', 'You and your sibling got the same recipe, shuffled differently.', 'bhai_dooj', 'planned', null),
  ('S024', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-11', 'pip', 'Pip''s First Year', 'pip', 'S1E4', 'Why time feels faster as you age', 'Director Ohm''s lamp flickered twice. Pip is in trouble.', null, 'planned', null),
  ('S025', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-12', 'archive', 'The Archive', 'nib', null, 'Tunguska 1908', 'Something flattened 80 million trees and left no crater.', null, 'planned', null),
  ('S026', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-13', 'myth', 'Myth Desk', 'kaz', null, 'Ragnarok vs Pralaya', 'Two ways the world ends: once, or on repeat.', null, 'planned', null),
  ('S027', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-14', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Octopus: three hearts, blue blood', 'The Deep Desk overdid the octopus.', null, 'planned', null),
  ('S028', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-15', 'complaint', 'Complaint Box', 'complaint_box', null, 'Static shocks in winter', 'A viewer keeps getting zapped. The Spark Desk denies everything.', null, 'planned', null),
  ('S029', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-16', 'incident', 'Incident Report', 'pip+marlo', null, 'What if oxygen doubled', 'Pip doubled the oxygen. Bugs got big. Fires got bigger.', null, 'planned', null),
  ('S030', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-17', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Noise-cancelling headphones', 'The quietest room in the Bureau is two sounds cancelling out.', null, 'planned', null),
  ('S031', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-18', 'pip', 'Pip''s First Year', 'pip', 'S1E5', 'Pip meets Nib', 'There''s a door nobody opens. Pip opened it.', null, 'planned', null),
  ('S032', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-19', 'archive', 'The Archive', 'nib', null, 'The Baghdad battery debate', 'Was it a 2,000-year-old battery, or just a jar?', null, 'planned', null),
  ('S033', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-20', 'myth', 'Myth Desk', 'kaz', null, 'Hanuman and the sun; Rahu/Ketu and eclipses', 'A god tried to eat the sun. Astronomers took notes.', null, 'planned', null),
  ('S034', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-21', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Saturn''s rings raining inward', 'Saturn is slowly eating its own rings.', null, 'planned', null),
  ('S035', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-22', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why onions make you cry', 'The Onion Desk files a formal apology.', null, 'planned', null),
  ('S036', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-23', 'incident', 'Incident Report', 'pip+marlo', null, 'Internet down for a week', 'Pip unplugged the internet to clean behind it.', null, 'planned', null),
  ('S037', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-24', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why ice floats', 'If ice sank, you wouldn''t exist. Thank the Water Desk.', null, 'planned', null),
  ('S038', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-25', 'pip', 'Pip''s First Year', 'pip', 'S1E6', 'How wings make lift', 'Marlo has 100,000 planes in the air today. Pip wants to fly one.', 'us_thanksgiving_travel', 'planned', null),
  ('S039', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-26', 'archive', 'The Archive', 'nib', null, 'Potatoes in Europe (Parmentier legend)', 'Europe once feared potatoes. One trick changed that, if the legend''s true.', 'us_thanksgiving', 'planned', null),
  ('S040', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-27', 'myth', 'Myth Desk', 'kaz', null, 'Prometheus vs Matarishvan', 'Two cultures, two fire thieves.', null, 'planned', null),
  ('S041', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-28', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why the sea is salty', 'Rivers are fresh. The ocean isn''t. Somebody''s been seasoning.', null, 'planned', null),
  ('S042', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-29', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why cats knock things off tables', 'Exhibit A: one glass. Exhibit B: one cat.', null, 'planned', null),
  ('S043', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-11-30', 'incident', 'Incident Report', 'pip+marlo', null, 'A world with only one colour', 'Pip deleted every colour but beige.', null, 'planned', null),
  ('S044', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-01', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Six-sided snowflakes', 'Every snowflake is built from the same hexagon blueprint.', null, 'planned', null),
  ('S045', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-02', 'pip', 'Pip''s First Year', 'pip', 'S1E7', 'Mid-season cliffhanger: the Reality Backup room', 'The Bureau keeps a backup of everything. Except one thing.', null, 'planned', null),
  ('S046', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-03', 'archive', 'The Archive', 'nib', null, 'Library of Alexandria: myth vs fact', 'It didn''t burn in one night. Nib is tired of the rumour.', null, 'planned', null),
  ('S047', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-04', 'myth', 'Myth Desk', 'kaz', null, 'Krampus and winter monsters', 'Every culture invented a monster for December.', null, 'planned', null),
  ('S048', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-05', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why it''s dark at 5 pm (axial tilt)', 'The Sun didn''t leave early. Earth leaned away.', null, 'planned', null),
  ('S049', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-06', 'complaint', 'Complaint Box', 'complaint_box', null, 'Contagious yawns', 'Try not to yawn. The Yawn Desk is watching.', null, 'planned', null),
  ('S050', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-07', 'incident', 'Incident Report', 'pip+marlo', null, 'Snowball Earth (it happened)', 'What if winter never ended? It happened once.', null, 'planned', null),
  ('S051', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-08', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Reindeer eyes turn blue in winter', 'Reindeer change eye colour every winter, on purpose.', null, 'planned', null),
  ('S052', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-09', 'pip', 'Pip''s First Year', 'pip', 'S1E8', 'One-night global delivery maths', 'One night. Two billion kids. Twenty-four time zones.', 'christmas', 'planned', null),
  ('S053', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-10', 'archive', 'The Archive', 'nib', null, '1914 Christmas truce', 'For one night, the trenches went quiet.', 'christmas', 'planned', null),
  ('S054', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-11', 'myth', 'Myth Desk', 'kaz', null, 'Solstice festivals: Yule, Dongzhi, Yalda', 'Every culture threw a party for the longest night.', 'solstice', 'planned', null),
  ('S055', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-12', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Geminids', 'Every December Earth drives through an asteroid''s dust.', 'geminids', 'planned', null),
  ('S056', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-13', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why string lights tangle (knot physics)', 'Science has proven your lights tangle themselves.', 'christmas', 'planned', null),
  ('S057', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-14', 'incident', 'Incident Report', 'pip+marlo', null, 'If the Sun switched off (8-minute delay)', 'You''d have eight minutes of not knowing.', null, 'planned', null),
  ('S058', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-15', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'GPS needs relativity', 'Your map app runs on Einstein.', null, 'planned', null),
  ('S059', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-16', 'pip', 'Pip''s First Year', 'pip', 'S1E9', 'What a second is (caesium clock)', 'Pip broke the Bureau''s clock. Nobody knows what time it is.', null, 'planned', null),
  ('S060', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-17', 'archive', 'The Archive', 'nib', null, 'The real St. Nicholas', 'Santa''s origin story starts in a Mediterranean port town.', 'christmas', 'planned', null),
  ('S061', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-18', 'myth', 'Myth Desk', 'kaz', null, 'Odin''s Wild Hunt and Santa''s ancestors', 'Before reindeer, there was an eight-legged horse.', 'christmas', 'planned', null),
  ('S062', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-19', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Snow is white, ice is clear', 'Same water, different outfit.', null, 'planned', null),
  ('S063', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-20', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why holidays feel short', 'A viewer says the holidays are rigged. Mrs. Iyer investigates.', null, 'planned', null),
  ('S064', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-21', 'incident', 'Incident Report', 'pip+marlo', null, 'Earth with no tilt', 'Pip straightened the planet. Seasons: cancelled.', 'solstice', 'planned', null),
  ('S065', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-22', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'How microwaves heat food', 'Your microwave is shaking water very, very fast.', null, 'planned', null),
  ('S066', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-23', 'pip', 'Pip''s First Year', 'pip', 'S1E10', 'Gilgamesh: the oldest written story', 'Kaz tells Pip the oldest story ever written down.', null, 'planned', null),
  ('S067', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-24', 'archive', 'The Archive', 'nib', null, 'Apollo 8 Earthrise', 'On Christmas Eve 1968, humans saw Earth rise.', 'christmas', 'planned', null),
  ('S068', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-25', 'myth', 'Myth Desk', 'kaz', null, 'Why Santa wears red (not Coca-Cola)', 'The red suit existed before the soda ad.', 'christmas', 'planned', null),
  ('S069', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-26', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why the deep ocean is darker than space', 'Space has stars. The deep sea doesn''t.', null, 'planned', null),
  ('S070', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-27', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why resolutions fail (habit loops)', 'The Habit Desk has seen your resolution before.', 'new_year', 'planned', null),
  ('S071', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-28', 'incident', 'Incident Report', 'pip+marlo', null, 'A 13-month calendar (International Fixed Calendar)', 'A company once ran on 13 months.', 'new_year', 'planned', null),
  ('S072', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-29', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Timing a midnight fireworks show', 'Every boom is scheduled to the millisecond.', 'new_year', 'planned', null),
  ('S073', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-30', 'pip', 'Pip''s First Year', 'pip', 'S1E11', 'New Year across ~38 local times (S1 finale)', 'Thirty-eight time zones. One intern.', 'new_year', 'planned', null),
  ('S074', 'b0000000-0000-4000-8000-000000000001', 'short', '2026-12-31', 'archive', 'The Archive', 'nib', null, 'Why the year starts on 1 January', 'Blame a Roman calendar reform.', 'new_year', 'planned', null),
  ('S075', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-01', 'myth', 'Myth Desk', 'kaz', null, 'Janus and the world''s many new years', 'Your New Year isn''t everyone''s New Year.', 'new_year', 'planned', null),
  ('S076', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-02', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Perihelion in January', 'Earth is closest to the Sun now. So why is it cold?', null, 'planned', null),
  ('S077', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-03', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why years feel shorter', 'Mrs. Iyer swears the year was full length.', null, 'planned', null),
  ('S078', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-04', 'incident', 'Incident Report', 'pip+marlo', null, 'Gravity 10% weaker', 'Marlo took a day off. Gravity took 10% off.', null, 'planned', null),
  ('S079', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-05', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'How a fridge moves heat', 'Your fridge doesn''t make cold. It exports heat.', null, 'planned', null),
  ('S080', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-06', 'pip', 'Pip''s First Year', 'pip', 'S2E1', 'Season 2: The Audit begins', 'An Auditor arrived to decide if Reality is worth running.', null, 'planned', null),
  ('S081', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-07', 'archive', 'The Archive', 'nib', null, 'The Great Emu War, 1932', 'The army lost to birds.', null, 'planned', null),
  ('S082', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-08', 'myth', 'Myth Desk', 'kaz', null, 'Sankranti: the solar-dated festival', 'The one festival Mrs. Iyer never has to recalculate.', 'sankranti', 'planned', null),
  ('S083', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-09', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Earth''s core as hot as the Sun''s surface', 'There''s a sun-hot ball under your feet.', null, 'planned', null),
  ('S084', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-10', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why kites fly', 'A viewer wants to win Sankranti. The Wind Desk has notes.', 'sankranti', 'planned', null),
  ('S085', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-11', 'incident', 'Incident Report', 'pip+marlo', null, 'Moon at ISS distance', 'Pip parked the Moon a bit too close.', null, 'planned', null),
  ('S086', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-12', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Pressure cookers', 'Your kitchen is cheating at physics.', null, 'planned', null),
  ('S087', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-13', 'pip', 'Pip''s First Year', 'pip', 'S2E2', 'The Auditor vs the Gravity Desk', 'Marlo has a secret, and the Auditor found it.', null, 'planned', null),
  ('S088', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-14', 'archive', 'The Archive', 'nib', null, 'Kallanai: a ~2,000-year-old working dam', 'A dam older than most empires is still working.', 'pongal', 'planned', null),
  ('S089', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-15', 'myth', 'Myth Desk', 'kaz', null, 'Surya''s seven horses and seven colours', 'Seven horses, seven colours. Coincidence?', null, 'planned', null),
  ('S090', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-16', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why Mars is red', 'Mars is rusty.', null, 'planned', null),
  ('S091', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-17', 'complaint', 'Complaint Box', 'complaint_box', null, 'The doorway effect', 'You walked in. You forgot why. Blame the door.', null, 'planned', null),
  ('S092', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-18', 'incident', 'Incident Report', 'pip+marlo', null, 'All ice melts', 'Pip turned the thermostat up. Coastlines moved.', null, 'planned', null),
  ('S093', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-19', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Torn QR codes still scan', 'Rip it. It still works. Error correction.', null, 'planned', null),
  ('S094', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-20', 'pip', 'Pip''s First Year', 'pip', 'S2E3', 'Defending the Rainbow Desk', 'The Auditor wants to cut rainbows. Pip objects.', null, 'planned', null),
  ('S095', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-21', 'archive', 'The Archive', 'nib', null, 'Why Pisa hasn''t fallen', 'It''s been ''about to fall'' for 800 years.', null, 'planned', null),
  ('S096', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-22', 'myth', 'Myth Desk', 'kaz', null, 'Thor vs Indra: serpent-slaying thunder gods', 'Two thunder gods, two giant serpents.', null, 'planned', null),
  ('S097', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-23', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Whale songs and the SOFAR channel', 'The ocean has a secret phone line.', null, 'planned', null),
  ('S098', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-24', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why mosquitoes pick some people', 'The Mosquito Desk has a favourites list.', null, 'planned', null),
  ('S099', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-25', 'incident', 'Incident Report', 'pip+marlo', null, 'Photosynthesising humans', 'Pip turned everyone slightly green.', null, 'planned', null),
  ('S100', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-26', 'archive', 'The Archive', 'nib', null, 'How India''s Constitution was drafted', 'It took almost three years to write the rules.', 'republic_day', 'planned', null),
  ('S101', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-27', 'pip', 'Pip''s First Year', 'pip', 'S2E4', 'Britain''s 11 skipped days (1752)', 'Mrs. Iyer: ''We once deleted eleven days.''', null, 'planned', null),
  ('S102', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-28', 'archive', 'The Archive', 'nib', null, 'Zero (Brahmagupta)', 'How India gave the world nothing.', null, 'planned', null),
  ('S103', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-29', 'myth', 'Myth Desk', 'kaz', null, 'Nagas, dragons and world serpents', 'Why every culture has a giant snake.', null, 'planned', null),
  ('S104', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-30', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Jupiter''s shrinking Great Red Spot', 'A storm bigger than Earth is shrinking.', null, 'planned', null),
  ('S105', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-01-31', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why February has 28 days', 'February lost a fight with a Roman calendar.', null, 'planned', null),
  ('S106', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-01', 'incident', 'Incident Report', 'pip+marlo', null, 'Everyone jumps at once', 'Pip asked 8 billion people to jump.', null, 'planned', null),
  ('S107', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-02', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Can animals predict weather?', 'The Groundhog Desk has a 50/50 record.', 'groundhog_day', 'planned', null),
  ('S108', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-03', 'pip', 'Pip''s First Year', 'pip', 'S2E5', 'Why the heart symbol looks nothing like a heart', 'The Love Desk drew a heart wrong. On purpose?', 'valentines', 'planned', null),
  ('S109', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-04', 'archive', 'The Archive', 'nib', null, 'Silphium theory of the heart shape', 'The heart shape may come from an extinct plant.', 'valentines', 'planned', null),
  ('S110', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-05', 'myth', 'Myth Desk', 'kaz', null, 'Kamadeva and Cupid', 'Two love gods, two bows, one job.', 'valentines', 'planned', null),
  ('S111', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-06', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why Lunar New Year moves (verify date)', 'Mrs. Iyer runs that calendar too.', 'lunar_new_year', 'planned', null),
  ('S112', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-07', 'complaint', 'Complaint Box', 'complaint_box', null, 'Butterflies in the stomach', 'The Gut Desk is talking to the Brain Desk.', 'valentines', 'planned', null),
  ('S113', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-08', 'incident', 'Incident Report', 'pip+marlo', null, 'Two moons', 'Pip ordered a second Moon.', null, 'planned', null),
  ('S114', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-09', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why many roses lost their scent', 'Florists bred the smell out of roses.', 'valentines', 'planned', null),
  ('S115', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-10', 'pip', 'Pip''s First Year', 'pip', 'S2E6', 'Pip''s love letter to the Universe', 'The Auditor''s deadline: one week.', 'valentines', 'planned', null),
  ('S116', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-11', 'archive', 'The Archive', 'nib', null, 'Taj Mahal''s outward-leaning minarets', 'The Taj has a built-in tilt, on purpose.', 'valentines', 'planned', null),
  ('S117', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-12', 'myth', 'Myth Desk', 'kaz', null, 'Savitri out-argues Death', 'She won a debate with Death itself.', null, 'planned', null),
  ('S118', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-13', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Do penguins mate for life? (mostly no)', 'The Penguin Desk has gossip.', 'valentines', 'planned', null),
  ('S119', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-14', 'complaint', 'Complaint Box', 'complaint_box', null, 'Chocolate melts in mouth, not hand', 'Chocolate is tuned to your mouth''s temperature.', 'valentines', 'planned', null),
  ('S120', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-15', 'incident', 'Incident Report', 'pip+marlo', null, 'No sense of smell', 'Pip unplugged the Smell Desk.', null, 'planned', null),
  ('S121', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-16', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'How touchscreens sense fingers', 'Your screen feels your electricity.', null, 'planned', null),
  ('S122', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-17', 'pip', 'Pip''s First Year', 'pip', 'S2E7', 'The Auditor''s identity twist', 'The Auditor has Director Ohm''s handwriting.', null, 'planned', null),
  ('S123', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-18', 'archive', 'The Archive', 'nib', null, 'Phaistos Disc', 'A clay disc stamped in a script nobody knows.', null, 'planned', null),
  ('S124', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-19', 'myth', 'Myth Desk', 'kaz', null, 'Why Egyptian gods had animal heads', 'A jackal head was a job description.', null, 'planned', null),
  ('S125', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-20', 'deep', 'Deep Desk', 'marlo|iyer', null, 'The Bloop and icequakes', 'The ocean''s loudest mystery turned out to be ice.', null, 'planned', null),
  ('S126', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-21', 'complaint', 'Complaint Box', 'complaint_box', null, 'Earworms', 'A song moved into your head and won''t pay rent.', null, 'planned', null),
  ('S127', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-22', 'incident', 'Incident Report', 'pip+marlo', null, 'It rained for a million years (Carnian Pluvial Episode)', 'It happened, and dinosaurs rose after it.', null, 'planned', null),
  ('S128', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-23', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why bubbles are round', 'Bubbles are lazy, mathematically.', null, 'planned', null),
  ('S129', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-24', 'pip', 'Pip''s First Year', 'pip', 'S2E8', 'The Auditor wants to cancel colour', 'Holi is in four weeks. The Auditor wants colour gone.', 'holi_lead', 'planned', null),
  ('S130', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-25', 'archive', 'The Archive', 'nib', null, 'Tyrian purple and mauveine', 'Purple used to cost more than gold.', 'holi_lead', 'planned', null),
  ('S131', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-26', 'myth', 'Myth Desk', 'kaz', null, 'Tricksters: Loki, Anansi, butter-thief Krishna', 'Every culture loves a trickster.', null, 'planned', null),
  ('S132', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-27', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Why deep-sea animals are red', 'At depth, red is invisible.', null, 'planned', null),
  ('S133', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-02-28', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why flamingos are pink', 'Flamingos are what they eat.', null, 'planned', null),
  ('S134', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-01', 'incident', 'Incident Report', 'pip+marlo', null, 'Seeing ultraviolet like bees', 'Pip upgraded human eyes. Flowers look different.', null, 'planned', null),
  ('S135', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-02', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Natural dyes: turmeric, indigo', 'Before factories, colour came from plants.', 'holi_lead', 'planned', null),
  ('S136', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-03', 'pip', 'Pip''s First Year', 'pip', 'S2E9', 'The Rainbow Desk trial', 'Reality vs the Auditor, day one.', 'holi_lead', 'planned', null),
  ('S137', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-04', 'archive', 'The Archive', 'nib', null, 'Indigo as blue gold', 'A blue dye once moved fortunes.', 'holi_lead', 'planned', null),
  ('S138', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-05', 'myth', 'Myth Desk', 'kaz', null, 'Radha, Krishna and Holi colours', 'Why Holi starts with a question about skin colour.', 'holi', 'planned', null),
  ('S139', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-06', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Mars: pink sky, blue sunsets', 'Mars got the sky backwards.', null, 'planned', null),
  ('S140', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-07', 'complaint', 'Complaint Box', 'complaint_box', null, 'Do we all see the same colours?', 'Your red might not be my red.', null, 'planned', null),
  ('S141', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-08', 'incident', 'Incident Report', 'pip+marlo', null, 'What if Ada Lovelace''s machine had been built?', 'Pip found a blueprint from 1843.', 'womens_day', 'planned', null),
  ('S142', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-09', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Thermochromic colour change', 'Colours that change with temperature.', null, 'planned', null),
  ('S143', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-10', 'pip', 'Pip''s First Year', 'pip', 'S2E10', 'The verdict (S2 finale)', 'The Auditor''s decision: Reality stays... for now.', null, 'planned', null),
  ('S144', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-11', 'archive', 'The Archive', 'nib', null, 'Madhava''s infinite series for pi', 'An Indian mathematician cracked pi centuries early.', 'pi_day_lead', 'planned', null),
  ('S145', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-12', 'myth', 'Myth Desk', 'kaz', null, 'Holika and Prahlad', 'The story behind the Holi bonfire.', 'holi', 'planned', null),
  ('S146', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-13', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Tidal locking: the Moon''s hidden side', 'The Moon never turns its back. Ever.', null, 'planned', null),
  ('S147', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-14', 'complaint', 'Complaint Box', 'complaint_box', null, 'Where the lost hour goes (Pi Day + DST)', 'America lost an hour. Mrs. Iyer keeps it in a drawer.', 'pi_day', 'planned', null),
  ('S148', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-15', 'incident', 'Incident Report', 'pip+marlo', null, 'If pi were 3 (the 1897 Indiana Pi Bill)', 'A US state once tried to change pi by law.', 'pi_day', 'planned', null),
  ('S149', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-16', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why gulal stains (pigment vs dye)', 'Why Holi colour sticks around.', 'holi', 'planned', null),
  ('S150', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-17', 'pip', 'Pip''s First Year', 'pip', 'S3E1', 'Season 3: Pip promoted', 'Pip is a desk head now. Nobody is safe.', null, 'planned', null),
  ('S151', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-18', 'archive', 'The Archive', 'nib', null, 'Nazca Lines', 'Giant drawings you can only see from the sky.', null, 'planned', null),
  ('S152', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-19', 'myth', 'Myth Desk', 'kaz', null, 'Persephone and Nowruz: spring return myths', 'Spring was always a comeback story.', 'nowruz', 'planned', null),
  ('S153', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-20', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Day and night aren''t actually equal (equinox)', 'The equinox is lying to you, slightly.', 'equinox', 'planned', null),
  ('S154', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-21', 'complaint', 'Complaint Box', 'complaint_box', null, 'Why fire crackles (Holika Dahan)', 'That crackle is trapped water escaping.', 'holi', 'planned', null),
  ('S155', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-22', 'incident', 'Incident Report', 'pip+marlo', null, 'How many colours humans can see (Holi)', 'Pip sneezed in the Rainbow Desk. Happy Holi, Earth.', 'holi', 'planned', null),
  ('S156', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-23', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'How soap works', 'Soap is a molecule with two personalities.', null, 'planned', null),
  ('S157', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-24', 'pip', 'Pip''s First Year', 'pip', 'S3E2', 'Pip''s first hire', 'Pip hired an intern. History repeats.', null, 'planned', null),
  ('S158', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-25', 'archive', 'The Archive', 'nib', null, 'Roanoke lost colony', 'A colony vanished, leaving one carved word.', null, 'planned', null),
  ('S159', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-26', 'myth', 'Myth Desk', 'kaz', null, 'Ganesha''s broken tusk and the Mahabharata', 'He broke his own tusk to keep writing.', null, 'planned', null),
  ('S160', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-27', 'deep', 'Deep Desk', 'marlo|iyer', null, 'Sea sparkle plankton', 'Waves that glow blue at night.', null, 'planned', null),
  ('S161', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-28', 'complaint', 'Complaint Box', 'complaint_box', null, 'Season 2 viewer Q&A', 'The Complaint Box is full. Let''s open it.', null, 'planned', null),
  ('S162', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-29', 'incident', 'Incident Report', 'pip+marlo', null, 'The Bureau goes on strike', 'One day without the Bureau. Everything stops.', null, 'planned', null),
  ('S163', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-30', 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'How cherry blossoms know when to bloom', 'Trees count the cold days.', null, 'planned', null),
  ('S164', 'b0000000-0000-4000-8000-000000000001', 'short', '2027-03-31', 'pip', 'Pip''s First Year', 'pip', 'S3E3', 'Why India''s financial year starts 1 April (calendar history, no money advice)', 'Mrs. Iyer: ''The year starts again tomorrow.''', null, 'planned', null),
  ('L01', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2026-10-25', 'long_form', 'Long-form episode', 'ensemble', null, 'Welcome to the Bureau: pilot episode + first incidents with new connective scenes', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L02', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2026-11-08', 'long_form', 'Long-form episode', 'ensemble', null, 'Diwali special: Mrs. Iyer and the Darkest Night (lunar calendars, light, fireworks chemistry)', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L03', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2026-11-22', 'long_form', 'Long-form episode', 'ensemble', null, 'The Archive Vol. 1: five mysteries with new Nib framing', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L04', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2026-12-06', 'long_form', 'Long-form episode', 'ensemble', null, 'Pip''s First Year: mid-season cut + new ending', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L05', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2026-12-20', 'long_form', 'Long-form episode', 'ensemble', null, 'Christmas special: One Night, 2 Billion Deliveries (time zones, physics)', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L06', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2027-01-03', 'long_form', 'Long-form episode', 'ensemble', null, 'Season 1 supercut + director''s commentary (Sahil''s writing notes, voiced)', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L07', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2027-01-17', 'long_form', 'Long-form episode', 'ensemble', null, 'Sankranti/Pongal: The Sun Changes Lanes', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L08', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2027-01-31', 'long_form', 'Long-form episode', 'ensemble', null, 'Myth Desk Vol. 1: world flood, fire and thunder myths', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L09', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2027-02-14', 'long_form', 'Long-form episode', 'ensemble', null, 'Valentine''s: The Love Desk Audit', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L10', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2027-02-28', 'long_form', 'Long-form episode', 'ensemble', null, 'Deep Desk Vol. 1: space and ocean', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L11', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2027-03-14', 'long_form', 'Long-form episode', 'ensemble', null, 'Pi Day / DST: The Hour Mrs. Iyer Keeps in a Drawer', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('L12', 'b0000000-0000-4000-8000-000000000001', 'long_form', '2027-03-28', 'long_form', 'Long-form episode', 'ensemble', null, 'Season 2 finale cut: The Auditor''s Verdict + new epilogue', null, null, 'planned', '8-12 min; new connective scenes, never raw re-stitching'),
  ('B01', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'incident', 'Incident Report', 'pip+marlo', null, 'What if friction switched off', 'Day one. The intern pressed one button, and now nothing on Earth can stop moving.', null, 'bank', 'evergreen bank: QC failure cover, 2/day expansion, sequels'),
  ('B02', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'desk_tour', 'Desk Tour', 'rotating_desk_head', null, 'Why the sky is blue', 'There''s no blue paint up there. Meet the department that makes it blue anyway.', null, 'bank', 'evergreen bank: QC failure cover, 2/day expansion, sequels'),
  ('B03', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'archive', 'The Archive', 'nib', null, 'Voynich Manuscript', 'A 600-year-old book nobody on Earth can read, and Nib has the only library card.', null, 'bank', 'evergreen bank: QC failure cover, 2/day expansion, sequels'),
  ('B04', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'myth', 'Myth Desk', 'kaz', null, 'Flood myths: Manu, Noah, Utnapishtim', 'Three civilisations, no internet, same story. Kaz has a theory.', null, 'bank', 'evergreen bank: QC failure cover, 2/day expansion, sequels'),
  ('B05', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'deep', 'Deep Desk', 'marlo|iyer', null, 'Pressure in the Mariana Trench (shrunken styrofoam cups)', 'Marlo sent a coffee cup to the bottom of the ocean. It came back the size of a thimble.', null, 'bank', 'evergreen bank: QC failure cover, 2/day expansion, sequels'),
  ('B06', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'complaint', 'Complaint Box', 'complaint_box', null, 'Why the 7-day week exists', 'The Bureau''s first-ever complaint: who invented Monday?', null, 'bank', 'evergreen bank: QC failure cover, 2/day expansion, sequels'),
  ('B07', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'pip', 'Pip''s First Year', 'pip', null, 'Leap years and calendar drift', 'Mrs. Iyer runs every calendar on Earth. Today she runs Pip.', null, 'bank', 'evergreen bank: QC failure cover, 2/day expansion, sequels'),
  ('B08', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B09', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B10', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B11', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B12', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B13', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B14', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B15', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine'),
  ('B16', 'b0000000-0000-4000-8000-000000000001', 'bank', null, 'sequel', 'Sequel slot', null, null, 'Reserved: sequel to a top-20% performer', null, null, 'bank', 'filled by Monday routine')
on conflict (id) do nothing;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0038', 'calendar_seed', array['-- applied from a lean bundle; text in supabase/migrations/0038_calendar_seed.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0039_rls_everywhere.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0039 rls_everywhere'; end $kiln_progress$;

-- 0039 — Row-level security on every table, and no anonymous reads of any view.
--
-- Supersedes decision 0003 ("no RLS in phase 1"), whose own consequences section made RLS a
-- hard prerequisite of real publishing authority and channel tokens. Both arrive with the
-- Bureau: mcp_tokens, publish bundles, an approver scope. Decision 0012 records the switch.
--
-- The shape is deny-by-default, not permissive policies (0003 rejected those, correctly: a
-- policy that allows everything looks like a control and is not one):
--
--   • every public table: RLS enabled, NO policy → anon and authenticated read nothing;
--   • the one exception: a signed-in user may read and update their own profiles row, which
--     the middleware does with the user's session (src/middleware.ts) — nothing else does;
--   • views run as their owner and would bypass RLS, so anon/authenticated lose SELECT on
--     every view instead;
--   • the service role (server components, Trigger tasks, /api/mcp) bypasses RLS as before.
--
-- Written to apply on a plain Postgres too (the harnesses' scratch databases have no auth
-- schema and no anon role), so the Supabase-only parts are guarded.

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

do $$
begin
  if to_regprocedure('auth.uid()') is not null and to_regrole('authenticated') is not null then
    execute $p$create policy profiles_self_read on public.profiles
               for select to authenticated using (id = auth.uid())$p$;
    execute $p$create policy profiles_self_update on public.profiles
               for update to authenticated using (id = auth.uid()) with check (id = auth.uid())$p$;
  end if;
end $$;

do $$
declare v record;
begin
  if to_regrole('anon') is null then
    return;
  end if;
  for v in select viewname from pg_views where schemaname = 'public' loop
    execute format('revoke all on public.%I from anon, authenticated', v.viewname);
  end loop;
end $$;

-- New tables get RLS too: an event trigger rather than a convention, because a convention is
-- what the next migration forgets. Requires superuser; on a role without it the DO block
-- reports and continues, and check:rls (verify:bureau §0) still catches a table without it.
create or replace function public.rls_on_new_tables() returns event_trigger
language plpgsql as $$
declare obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' loop
    if obj.schema_name = 'public' then
      execute format('alter table %s enable row level security', obj.object_identity);
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'kiln_rls_on_new_tables') then
    create event trigger kiln_rls_on_new_tables on ddl_command_end
      when tag in ('CREATE TABLE') execute function public.rls_on_new_tables();
  end if;
exception when insufficient_privilege then
  raise notice 'event trigger not created (needs superuser); check:rls still guards new tables';
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0039', 'rls_everywhere', array['-- applied from a lean bundle; text in supabase/migrations/0039_rls_everywhere.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0040_bureau_control_plane.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0040 bureau_control_plane'; end $kiln_progress$;

-- 0040 — The Bureau control plane: decisions as single transactions, the rates the router
-- and the voice stage price against, and the columns the episode run waits on.
--
-- Every approver decision (brief approve/reject, cut approve/reject, caps, kill switch,
-- mark scheduled) is ONE function here. Each one checks the token's scope itself, writes
-- the decision, and writes the authorship_log row in the same transaction — so a decision
-- without its log row, or a log row for a decision that rolled back, cannot exist. The
-- TypeScript layer checks scope too (it is what refuses with a readable message); this is
-- the check that holds if a future caller forgets.
--
-- Forward-only. No DROP: `create or replace view` keeps v_pipeline_blockers' columns and
-- changes one CASE branch.

-- ═════════════════════════════════════════════════════════════════════════════
-- Rates
-- ═════════════════════════════════════════════════════════════════════════════

-- The model router's three tiers. Published list prices, read 2026-10-06 from
-- platform.claude.com/docs/en/models/overview. Verified in the sense rate_card uses for the
-- existing Opus row: a published price, not a measured balance move (cost_source says so).
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('anthropic', 'claude-opus-5-5', '/v1/messages', 'input_token', 0.000004, 'USD', true,
   'Published list price: USD 4.00 per 1M input tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-opus-5-5', '/v1/messages', 'output_token', 0.00002, 'USD', true,
   'Published list price: USD 20.00 per 1M output tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages', 'input_token', 0.000002, 'USD', true,
   'Published list price: USD 2.00 per 1M input tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages', 'output_token', 0.00001, 'USD', true,
   'Published list price: USD 10.00 per 1M output tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-haiku-4-5-20251001', '/v1/messages', 'input_token', 0.000001, 'USD', true,
   'Published list price: USD 1.00 per 1M input tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-haiku-4-5-20251001', '/v1/messages', 'output_token', 0.000005, 'USD', true,
   'Published list price: USD 5.00 per 1M output tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z')
on conflict do nothing;

-- Embeddings for variation_check's similarity test. Published price USD 0.15 per 1M input
-- tokens. The API returns no token count, so the QUANTITY is estimated (characters / 4) and
-- the row says so through cost_source = 'rate_card'.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('gemini', 'gemini-embedding-001', '/v1beta/models:batchEmbedContents', 'input_token', 0.00000015, 'USD', true,
   'Published list price USD 0.15 per 1M input tokens. Token quantity is estimated as '
   'ceil(characters / 4) because the response carries no usage.', '2026-10-01T00:00:00Z')
on conflict do nothing;

-- Voice on the Runway API (plan v2.2, decision 0013). 1 credit per 50 characters at
-- USD 0.01 per credit = USD 0.0002 per character, for eleven_v3 and eleven_multilingual_v2.
-- A published price; every row priced from it is cost_source = 'rate_card' until a credit
-- balance is observed to move.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('runway', 'eleven_v3', '/v1/text_to_speech', 'character', 0.0002, 'USD', true,
   'Published: 1 credit per 50 characters, USD 0.01 per credit (plan v2.2 / Runway API pricing). '
   'Not yet observed against a balance.', '2026-10-01T00:00:00Z'),
  ('runway', 'eleven_multilingual_v2', '/v1/text_to_speech', 'character', 0.0002, 'USD', true,
   'Published: 1 credit per 50 characters, USD 0.01 per credit (plan v2.2 / Runway API pricing). '
   'Not yet observed against a balance.', '2026-10-01T00:00:00Z'),
  -- Dubbing and sound effects have no published per-unit rate. The credit itself is
  -- priced (USD 0.01); the QUANTITY comes from the vendor's own estimatedCost.credits on the
  -- submit response, and every surface that shows a dub cost says "rate unverified".
  ('runway', 'eleven_voice_dubbing', '/v1/voice_dubbing', 'credit', 0.01, 'USD', true,
   'USD 0.01 per API credit is published; credits per dub are NOT — quantity is the vendor''s '
   'submit-time estimatedCost (an upper bound). Rate unverified.', '2026-10-01T00:00:00Z'),
  ('runway', 'eleven_text_to_sound_v2', '/v1/sound_effect', 'credit', 0.01, 'USD', true,
   'USD 0.01 per API credit is published; credits per effect are NOT — quantity is the '
   'vendor''s submit-time estimatedCost. Rate unverified.', '2026-10-01T00:00:00Z')
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Columns the episode run and the dub task wait on
-- ═════════════════════════════════════════════════════════════════════════════

alter table episodes
  add column gen_wait_token text,
  add column kind           text not null default 'short' check (kind in ('short', 'long_form')),
  add column voice_detail   jsonb;

comment on column episodes.gen_wait_token is
  'Trigger wait token the episode run parks on while its gen_jobs are in flight. The '
  'dispatcher completes it when the last job for the episode reaches a terminal state — '
  'the run is woken, not polling.';

alter table dub_jobs
  add column request_id        text,
  add column credits_estimated numeric check (credits_estimated is null or credits_estimated >= 0),
  add column output_url_expires_at timestamptz;

-- ═════════════════════════════════════════════════════════════════════════════
-- Scope, in the database
-- ═════════════════════════════════════════════════════════════════════════════

create function bureau_require_scope(p_token uuid, p_scope text) returns mcp_tokens
language plpgsql as $$
declare t mcp_tokens;
begin
  select * into t from mcp_tokens where id = p_token;
  if not found or t.revoked_at is not null then
    raise exception 'token_invalid: token % is unknown or revoked', p_token;
  end if;
  if p_scope = 'approver' and t.scope <> 'approver' then
    raise exception 'scope_denied: this action needs the approver scope; token % is %', p_token, t.scope;
  end if;
  return t;
end $$;

comment on function bureau_require_scope is
  'Raise unless the token exists, is not revoked, and (for approver actions) carries the '
  'approver scope. Called first by every decision function below.';

-- ── Brief approve ─────────────────────────────────────────────────────────────

create function bureau_brief_approve(
  p_token uuid, p_brief uuid, p_punchline text, p_choice text, p_edits jsonb
) returns uuid
language plpgsql as $$
declare
  t   mcp_tokens;
  b   briefs;
  ep  uuid;
  ed  jsonb := coalesce(p_edits, '{}'::jsonb);
begin
  t := bureau_require_scope(p_token, 'approver');

  select * into b from briefs where id = p_brief for update;
  if not found or b.channel_id <> t.channel_id then
    raise exception 'not_found: brief % does not exist on this channel', p_brief;
  end if;
  if b.status <> 'pending' then
    raise exception 'conflict: brief % is %, not pending', p_brief, b.status;
  end if;
  if p_punchline is null or length(trim(p_punchline)) = 0 then
    raise exception 'invalid: a punchline is required';
  end if;

  update briefs set
    status           = 'approved',
    chosen_punchline = trim(p_punchline),
    approved_edits   = ed,
    approved_at      = now(),
    approved_by_token = t.id,
    premise          = coalesce(nullif(trim(ed->>'premise'), ''), premise),
    script_text      = coalesce(nullif(trim(ed->>'script_text'), ''), script_text),
    pinned_comment   = coalesce(nullif(trim(ed->>'pinned_comment'), ''), pinned_comment)
  where id = p_brief;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (b.channel_id, 'approver', t.id, t.profile_id, 'brief_approve', 'brief', p_brief::text,
          trim(p_punchline),
          jsonb_build_object('choice', p_choice, 'edits', ed, 'slot_id', b.slot_id));

  insert into episodes (brief_id, channel_id, slot_id, kind)
  values (p_brief, b.channel_id, b.slot_id, case when b.series = 'long_form' then 'long_form' else 'short' end)
  returning id into ep;

  return ep;
end $$;

-- ── Brief reject ──────────────────────────────────────────────────────────────

create function bureau_brief_reject(p_token uuid, p_brief uuid, p_reason text) returns void
language plpgsql as $$
declare t mcp_tokens; b briefs;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into b from briefs where id = p_brief for update;
  if not found or b.channel_id <> t.channel_id then
    raise exception 'not_found: brief % does not exist on this channel', p_brief;
  end if;
  if b.status <> 'pending' then
    raise exception 'conflict: brief % is %, not pending', p_brief, b.status;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'invalid: a reason is required';
  end if;

  update briefs set status = 'rejected', rejected_at = now(), reject_reason = trim(p_reason)
   where id = p_brief;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (b.channel_id, 'approver', t.id, t.profile_id, 'brief_reject', 'brief', p_brief::text,
          trim(p_reason), jsonb_build_object('slot_id', b.slot_id));
end $$;

-- ── Cut approve / reject ──────────────────────────────────────────────────────

create function bureau_cut_decide(p_token uuid, p_episode uuid, p_approve boolean, p_note text)
returns jsonb
language plpgsql as $$
declare t mcp_tokens; e episodes; b briefs; rv uuid;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into e from episodes where id = p_episode for update;
  if not found or e.channel_id <> t.channel_id then
    raise exception 'not_found: episode % does not exist on this channel', p_episode;
  end if;
  if e.status <> 'awaiting_cut' then
    raise exception 'conflict: episode % is %, not awaiting_cut', p_episode, e.status;
  end if;
  if e.final_render_id is null then
    raise exception 'conflict: episode % has no final render to review', p_episode;
  end if;
  if not p_approve and (p_note is null or length(trim(p_note)) = 0) then
    raise exception 'invalid: a rejection needs a note';
  end if;
  select * into b from briefs where id = e.brief_id;

  -- reviews.reviewer_id is a person; an approver token always names one (mcp_tokens check).
  insert into reviews (render_id, reviewer_id, decision, notes, structure_novel)
  values (e.final_render_id, t.profile_id, case when p_approve then 'pass' else 'reshoot' end,
          nullif(trim(coalesce(p_note, '')), ''),
          coalesce((b.variation->>'passed')::boolean, false))
  returning id into rv;

  update episodes set
    status     = case when p_approve then 'cut_approved' else 'cut_rejected' end,
    review_id  = rv,
    updated_at = now()
  where id = p_episode;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (e.channel_id, 'approver', t.id, t.profile_id,
          case when p_approve then 'cut_approve' else 'cut_reject' end,
          'episode', p_episode::text, coalesce(nullif(trim(coalesce(p_note, '')), ''), case when p_approve then 'approved' end),
          jsonb_build_object('render_id', e.final_render_id, 'review_id', rv));

  return jsonb_build_object('review_id', rv, 'cut_wait_token', e.cut_wait_token);
end $$;

-- ── Caps and the kill switch ──────────────────────────────────────────────────

create function bureau_caps_set(p_token uuid, p_changes jsonb) returns channel_policy
language plpgsql as $$
declare
  t mcp_tokens; p channel_policy; k text;
  allowed text[] := array['per_short_cap_inr','daily_cap_inr','daily_longform_cap_inr',
    'monthly_cap_inr','monthly_cap_after_gate2_inr','daily_publish_cap','gate2_passed',
    'variation_min_axes','similarity_max','hook_archetype_weekly_max','catchphrase_weekly_max',
    'overlay_min_share','character_beat_max_s','money_shot_max','rerolls_max'];
begin
  t := bureau_require_scope(p_token, 'approver');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'invalid: no changes given';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then
      raise exception 'invalid: "%" is not a cap this tool can set', k;
    end if;
  end loop;

  update channel_policy set
    per_short_cap_inr           = coalesce((p_changes->>'per_short_cap_inr')::numeric, per_short_cap_inr),
    daily_cap_inr               = coalesce((p_changes->>'daily_cap_inr')::numeric, daily_cap_inr),
    daily_longform_cap_inr      = coalesce((p_changes->>'daily_longform_cap_inr')::numeric, daily_longform_cap_inr),
    monthly_cap_inr             = coalesce((p_changes->>'monthly_cap_inr')::numeric, monthly_cap_inr),
    monthly_cap_after_gate2_inr = coalesce((p_changes->>'monthly_cap_after_gate2_inr')::numeric, monthly_cap_after_gate2_inr),
    daily_publish_cap           = coalesce((p_changes->>'daily_publish_cap')::int, daily_publish_cap),
    gate2_passed_at             = case
                                    when p_changes ? 'gate2_passed' and (p_changes->>'gate2_passed')::boolean
                                      then coalesce(gate2_passed_at, now())
                                    when p_changes ? 'gate2_passed' then null
                                    else gate2_passed_at end,
    variation_min_axes          = coalesce((p_changes->>'variation_min_axes')::int, variation_min_axes),
    similarity_max              = coalesce((p_changes->>'similarity_max')::numeric, similarity_max),
    hook_archetype_weekly_max   = coalesce((p_changes->>'hook_archetype_weekly_max')::int, hook_archetype_weekly_max),
    catchphrase_weekly_max      = coalesce((p_changes->>'catchphrase_weekly_max')::int, catchphrase_weekly_max),
    overlay_min_share           = coalesce((p_changes->>'overlay_min_share')::numeric, overlay_min_share),
    character_beat_max_s        = coalesce((p_changes->>'character_beat_max_s')::numeric, character_beat_max_s),
    money_shot_max              = coalesce((p_changes->>'money_shot_max')::int, money_shot_max),
    rerolls_max                 = coalesce((p_changes->>'rerolls_max')::int, rerolls_max),
    updated_at = now(),
    updated_by = 'approver:' || t.id
  where channel_id = t.channel_id
  returning * into p;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id, 'caps_set', 'channel_policy',
          t.channel_id::text, p_changes::text, p_changes);
  return p;
end $$;

create function bureau_kill_switch(p_token uuid, p_on boolean, p_reason text) returns channel_policy
language plpgsql as $$
declare t mcp_tokens; p channel_policy;
begin
  t := bureau_require_scope(p_token, 'approver');
  if p_on and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'invalid: turning the kill switch on needs a reason';
  end if;
  update channel_policy set
    kill_switch        = p_on,
    kill_switch_reason = case when p_on then trim(p_reason) else null end,
    kill_switch_at     = case when p_on then now() else null end,
    updated_at = now(),
    updated_by = 'approver:' || t.id
  where channel_id = t.channel_id
  returning * into p;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id,
          case when p_on then 'kill_switch_on' else 'kill_switch_off' end,
          'channel_policy', t.channel_id::text, coalesce(trim(p_reason), 'off'),
          jsonb_build_object('on', p_on));
  return p;
end $$;

-- ── Mark scheduled (manual Studio scheduling while the upload API is unaudited) ─

create function bureau_mark_scheduled(p_token uuid, p_publication uuid, p_at timestamptz)
returns publications
language plpgsql as $$
declare t mcp_tokens; pub publications;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into pub from publications where id = p_publication for update;
  if not found or pub.channel_id <> t.channel_id then
    raise exception 'not_found: publication % does not exist on this channel', p_publication;
  end if;
  if pub.status <> 'draft' then
    raise exception 'conflict: publication % is %, not draft', p_publication, pub.status;
  end if;
  if p_at is null then
    raise exception 'invalid: a schedule time is required';
  end if;

  -- Both publication triggers run here: enforce_review_pass (the review must be a pass) and
  -- enforce_channel_policy (kill switch, daily publish cap). Neither is bypassed.
  update publications set status = 'scheduled', scheduled_for = p_at, marked_scheduled_at = now()
   where id = p_publication
  returning * into pub;

  update episodes set status = 'scheduled', updated_at = now() where id = pub.episode_id;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id, 'mark_scheduled', 'publication',
          p_publication::text, p_at::text,
          jsonb_build_object('episode_id', pub.episode_id, 'platform', pub.platform));
  return pub;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Silence, read back: the blocker view names a failed alignment
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Prompt H: when forced alignment fails or is not confident, timings are null, durations
-- stay estimates, and stage 5 keeps refusing. Without this branch the view would say "stage
-- 6 has not run" about a script whose stage 6 ran and paid — the wrong next action.
--
-- And two branches that could not see a Bureau script: an overlay shot has no recipe and no
-- compiled parameters by design (it is rendered in-house), and a Bureau shot is compiled
-- AFTER the voice sets its duration, not before. So the recipe/rate branches apply to legacy
-- shots (render_route null), and the workspace-wide vendor checks apply only when a shot is
-- actually generated. verify:episode reads this view for a Bureau script and asserts the
-- alignment reason, which is how this was found.

create or replace view v_pipeline_blockers as
 SELECT s.id AS script_id,
    c.id AS concept_id,
    c.channel_id,
    c.title,
    s.created_at,
        CASE
            WHEN nv.needs_video AND NOT (EXISTS ( SELECT 1
               FROM integrations i
              WHERE i.kind = 'video'::text AND i.is_enabled AND i.last_verified_at IS NOT NULL)) THEN 'no verified video integration — enabling states intent, verifying states fact'::text
            WHEN nv.needs_video AND NOT (EXISTS ( SELECT 1
               FROM prompts p
              WHERE p.is_active)) THEN 'the prompt library has no active recipe — production reads the library, it never improvises'::text
            WHEN NOT (EXISTS ( SELECT 1
               FROM shots sh
              WHERE sh.script_id = s.id)) THEN 'no shots — stage 4 has not run'::text
            WHEN (EXISTS ( SELECT 1
               FROM shots sh
              WHERE sh.script_id = s.id AND sh.render_route IS NULL AND (sh.compiled_params IS NULL OR sh.prompt_id IS NULL))) THEN 'some shots have no compiled parameters — no library recipe matched'::text
            WHEN (EXISTS ( SELECT 1
               FROM shots sh
                 JOIN prompts p ON p.id = sh.prompt_id
              WHERE sh.script_id = s.id AND sh.render_route IS NULL AND NOT (EXISTS ( SELECT 1
                       FROM rate_card rc
                      WHERE rc.driver = p.driver AND rc.model = p.model AND rc.unit = 'credit'::text AND rc.is_verified AND rc.effective_from <= now())))) THEN 'no verified credit rate for the recipe these shots use — the call cannot be priced'::text
            WHEN s.pilot_rejected_at IS NOT NULL THEN 'the pilot shot was rejected — change the recipe and submit a new pilot'::text
            WHEN s.pilot_generation_id IS NOT NULL AND s.pilot_approved_at IS NULL THEN 'waiting on pilot approval — one shot was generated so the rest can be judged before they are paid for'::text
            WHEN (EXISTS ( SELECT 1
               FROM shots sh
              WHERE sh.script_id = s.id AND sh.duration_source <> 'derived_from_vo'::text)) THEN
            CASE
                WHEN (EXISTS ( SELECT 1 FROM vo_takes vt
                   WHERE vt.script_id = s.id AND vt.word_timings = '[]'::jsonb AND vt.asset_id IS NOT NULL))
                  THEN 'voice was synthesised but forced alignment did not confirm every word — timings are null, so durations stay estimates'::text
                WHEN ch.host_voice_id IS NULL AND NOT (EXISTS ( SELECT 1 FROM characters k
                   WHERE k.channel_id = c.channel_id AND k.voice_id IS NOT NULL))
                  THEN 'durations are still estimates and the channel has no host voice — stage 6 cannot run'::text
                ELSE 'durations are still estimates — stage 6 has not run'::text
            END
            ELSE NULL::text
        END AS blocker,
        CASE
            WHEN nv.needs_video AND NOT (EXISTS ( SELECT 1
               FROM integrations i
              WHERE i.kind = 'video'::text AND i.is_enabled AND i.last_verified_at IS NOT NULL)) THEN true
            WHEN nv.needs_video AND NOT (EXISTS ( SELECT 1
               FROM prompts p
              WHERE p.is_active)) THEN true
            ELSE false
        END AS blocker_is_workspace_wide,
    s.pilot_generation_id IS NOT NULL AND s.pilot_approved_at IS NULL AND s.pilot_rejected_at IS NULL AS awaiting_pilot_approval
   FROM scripts s
     JOIN concepts c ON c.id = s.concept_id
     JOIN channels ch ON ch.id = c.channel_id
     -- An all-overlay Bureau script needs no video vendor and no recipe: the workspace-wide
     -- blockers apply only when some shot is generated (or, for a legacy script, always).
     CROSS JOIN LATERAL ( SELECT NOT (EXISTS ( SELECT 1 FROM shots sh WHERE sh.script_id = s.id))
                              OR (EXISTS ( SELECT 1 FROM shots sh WHERE sh.script_id = s.id AND sh.render_route IS DISTINCT FROM 'overlay'::text)) AS needs_video) nv;

-- ═════════════════════════════════════════════════════════════════════════════
-- Read-side views for the control room and the MCP tools
-- ═════════════════════════════════════════════════════════════════════════════

create view v_ready_bundles as
select p.id as publication_id, p.channel_id, p.episode_id, p.slot_id, p.platform, p.status,
       p.title, p.description, p.tags, p.made_for_kids, p.altered_content_disclosed,
       p.scheduled_for, p.marked_scheduled_at, p.bundle, p.created_at,
       sl.slot_date, sl.series, sl.topic
  from publications p
  left join slots sl on sl.id = p.slot_id
 where p.bundle is not null;

-- RLS on the new rows is inherited from 0039's event trigger where it exists; views stay
-- closed to anon/authenticated, matching 0039.
do $$
begin
  if to_regrole('anon') is not null then
    execute 'revoke all on public.v_ready_bundles from anon, authenticated';
    execute 'revoke all on public.v_pipeline_blockers from anon, authenticated';
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0040', 'bureau_control_plane', array['-- applied from a lean bundle; text in supabase/migrations/0040_bureau_control_plane.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0041_bureau_publishing_and_metrics.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0041 bureau_publishing_and_metrics'; end $kiln_progress$;

-- 0041 — Bureau publishing behind its flags, and the metrics it reads back.
--
-- Forward-only, no DROP: `create or replace view` keeps v_publish_queue's columns.

-- ═════════════════════════════════════════════════════════════════════════════
-- The publish queue learns the Bureau's two differences (decision 0014)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 1. Disclosure: a Bureau publication carries a per-video decision (the bundle's
--    contains_synthetic_media — true only for a realistic money shot). `false` there is a
--    recorded decision, not an unset one, so it is not a blocker. Legacy rows keep the rule.
-- 2. Scheduling: a Bureau upload goes up private with publishAt = the slot, so a future
--    scheduled_for is the POINT of the upload, not a reason to wait.
-- 3. And it may not upload at all while channel_policy.youtube_api_audited is false — the
--    unaudited API caps uploads to private and the channel publishes by bundle instead. This
--    sits beside enforce_review_pass and enforce_channel_policy; it does not replace either.

create or replace view v_publish_queue as
 SELECT p.id AS publication_id,
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
    rv.decision AS review_decision,
    r.status AS render_status,
        CASE
            WHEN rv.decision IS DISTINCT FROM 'pass'::text THEN 'review_not_passed'::text
            WHEN r.status IS DISTINCT FROM 'ready'::text THEN 'render_not_ready'::text
            WHEN p.episode_id IS NOT NULL AND NOT COALESCE((SELECT cp.youtube_api_audited FROM channel_policy cp WHERE cp.channel_id = p.channel_id), false) THEN 'youtube_api_unaudited'::text
            WHEN p.episode_id IS NULL AND p.altered_content_disclosed IS NOT TRUE THEN 'disclosure_not_set'::text
            WHEN p.episode_id IS NOT NULL AND (p.bundle ->> 'contains_synthetic_media') IS NULL THEN 'disclosure_not_set'::text
            WHEN NOT (EXISTS ( SELECT 1
               FROM integrations i
              WHERE i.slug = 'youtube'::text AND i.is_enabled AND i.last_verified_at IS NOT NULL)) THEN 'no_verified_publish_integration'::text
            WHEN NOT (EXISTS ( SELECT 1
               FROM v_api_quota q
              WHERE q.slug = 'youtube'::text AND q.units_remaining >= 1600)) THEN 'insufficient_quota'::text
            WHEN p.episode_id IS NULL AND p.scheduled_for IS NOT NULL AND p.scheduled_for > now() THEN 'scheduled_for_later'::text
            ELSE NULL::text
        END AS blocker
   FROM publications p
     JOIN renders r ON r.id = p.render_id
     LEFT JOIN reviews rv ON rv.id = p.review_id
  WHERE p.status <> 'live'::text AND p.platform = 'youtube'::text;

-- ═════════════════════════════════════════════════════════════════════════════
-- Metrics the Bureau pulls
-- ═════════════════════════════════════════════════════════════════════════════

alter table metrics_snapshots
  add column if not exists engaged_views_source text;

comment on column metrics_snapshots.engaged_views_source is
  'Which report produced engaged_views, because the Analytics API has named Shorts metrics '
  'more than once. Null when engaged_views is null.';

-- One snapshot per publication per age bucket already holds (unique since 0001), so the
-- metrics task upserts on it and the Studio CSV import fills viewed_vs_swiped_pct on the
-- same row rather than adding a second source row.

-- Character-name mentions per day, for the Metrics page trend and metrics_summary.
create view v_character_mentions as
select c.channel_id,
       (c.published_at at time zone 'Asia/Kolkata')::date as day,
       m.slug,
       count(*) as mentions
  from comments c
  cross join lateral unnest(c.character_mentions) as m(slug)
 where c.published_at is not null
 group by 1, 2, 3;

do $$
begin
  if to_regrole('anon') is not null then
    execute 'revoke all on public.v_character_mentions from anon, authenticated';
    execute 'revoke all on public.v_publish_queue from anon, authenticated';
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0041', 'bureau_publishing_and_metrics', array['-- applied from a lean bundle; text in supabase/migrations/0041_bureau_publishing_and_metrics.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0042_long_form_segments.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0042 long_form_segments'; end $kiln_progress$;

-- 0042 — Long-form: an episode built from aired Shorts plus NEW connective scenes.
--
-- A long-form brief carries `segments`: the order of aired Shorts (by slot) and new scenes
-- (dialogue + shots) between them. Validation lives in src/lib/bureau/longform.ts and refuses
-- two Shorts back to back — "never raw re-stitching" (plan v2.2, Prompt F). A shot that reuses
-- an aired Short's clean master points at it with `source_render_id`; its duration is that
-- render's measured duration, never an estimate.
--
-- Forward-only, no DROP.

alter table briefs
  add column segments jsonb check (segments is null or jsonb_typeof(segments) = 'array');

comment on column briefs.segments is
  'Long-form only: [{type:"short", slot_id} | {type:"scene", lines, shots[]}] in running order. '
  'Null on a Short.';

alter table shots
  add column source_render_id uuid references renders(id) on delete restrict;

comment on column shots.source_render_id is
  'Set on a long-form shot that replays an aired Short''s clean master. render_route is '
  '''overlay'' for these (nothing is generated); the assembler reads this column first.';

alter table dub_jobs
  add column srt_asset_id uuid references assets(id) on delete set null;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0042', 'long_form_segments', array['-- applied from a lean bundle; text in supabase/migrations/0042_long_form_segments.sql'])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
commit;

-- ── Tell PostgREST the schema changed ───────────────────────────────────────
--
-- Outside the transaction, and not optional.
--
-- Supabase serves the app through PostgREST, which caches the schema in memory. The CLI
-- reloads that cache after a push; pasting SQL into the editor does not. So every table,
-- view and function this file created exists in the database and is invisible to the app
-- until this fires — and the error you get is "Could not find the table 'public.X' in the
-- schema cache", which reads exactly like the migration never ran.
--
-- That sentence cost an evening. It is in the file now so it cannot be forgotten.
notify pgrst, 'reload schema';

-- Confirm from the editor:
--   select version, name from supabase_migrations.schema_migrations order by version;
--   select slug, kind, is_enabled from integrations order by slug;
