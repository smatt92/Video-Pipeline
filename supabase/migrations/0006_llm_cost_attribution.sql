-- Migration 0006 — the ledger has to be able to hold LLM spend
--
-- CLAUDE.md rule 5: every external call that costs money writes a cost_ledger row at
-- submit time. Stage 3 drafts a script with a paid LLM call, and today that row cannot be
-- written at all — `cost_ledger_has_subject` (0002) requires generation_id or render_id,
-- and a script draft is neither. The rule was unenforceable for the first paid call in
-- the pipeline, which is the kind of gap that gets discovered by a cost figure that is
-- quietly too low rather than by an error.

-- ─────────────────────────────────────────────────────────────
-- 1. Two more subjects: the script, and the concept
--
-- The script is the obvious one — a successful draft is charged to what it produced.
--
-- The concept is the one that is easy to miss and matters more. A refusal, a truncation
-- and a schema violation are all billed exactly like a success, and none of them produces
-- a scripts row to hang the charge on. Without a second subject the only options are to
-- drop the row, which under-reports the metric the whole project is measured by, or to
-- write a scripts row for a draft that does not exist, which corrupts the originality
-- evidence that table is for (ARCHITECTURE.md §0.2). Both are worse than a column.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column script_id  uuid references scripts(id)  on delete cascade,
  add column concept_id uuid references concepts(id) on delete cascade;

comment on column cost_ledger.script_id is
  'Set on LLM spend that produced this script. Drafting, and later re-drafting, is money '
  'spent before a single shot exists — attributing it to the script is what makes '
  'cost-per-video include the part that happened before any video did.';

comment on column cost_ledger.concept_id is
  'Set on every drafting call, alongside script_id when a script came out of it. Set '
  'alone when one did not: a refused or truncated draft is billed and produced nothing, '
  'and spend with no row is the one accounting failure this project cannot tolerate.';

create index on cost_ledger (script_id)  where script_id  is not null;
create index on cost_ledger (concept_id) where concept_id is not null;

alter table cost_ledger
  drop constraint cost_ledger_has_subject;

alter table cost_ledger
  add constraint cost_ledger_has_subject
  check (generation_id is not null or render_id is not null
         or script_id is not null or concept_id is not null);

-- ─────────────────────────────────────────────────────────────
-- 2. Retries must not double-write here either
--
-- The generation key is (generation_id, entry_kind). This one carries `unit` as well,
-- and the asymmetry is deliberate rather than an oversight: one LLM call is priced at two
-- different rates — input tokens and output tokens are 5× apart — so it writes two rows.
--
-- The alternative, one row with unit='token' and a blended cost, would make
-- quantity × unit_cost ≠ cost_usd on the ledger's own arithmetic. A ledger whose rows do
-- not multiply out is a ledger nobody can check.
-- ─────────────────────────────────────────────────────────────

create unique index cost_ledger_script_entry_key
  on cost_ledger (script_id, entry_kind, unit)
  where script_id is not null;

-- Failed drafts have no such key, and must not get one by concept: two refusals on the
-- same concept are two real charges, not a duplicate. What has to be idempotent is the
-- *retry* of a single task run, so the caller supplies a key derived from the run.
--
-- CLAUDE.md rule 6 already requires this of every generation; the ledger simply had
-- nowhere to record it for spend that is not a generation.
alter table cost_ledger
  add column idempotency_key text;

comment on column cost_ledger.idempotency_key is
  'Caller-supplied, for ledger rows with no natural key — currently failed drafts, which '
  'are charged to a concept and can legitimately recur. Derived from the task run id, '
  'which is stable across attempts, so a retried attempt lands on the same row.';

create unique index cost_ledger_idempotency_key_uniq
  on cost_ledger (idempotency_key)
  where idempotency_key is not null;

-- ─────────────────────────────────────────────────────────────
-- 3. rate_card's key is missing `unit`
--
-- 0002 keyed it (driver, model, effective_from); 0003 added endpoint. Neither includes
-- unit, which was harmless while every rate was priced in exactly one thing — credits per
-- generation, seconds of video. An LLM call is priced in two: input tokens and output
-- tokens, same driver, same model, same endpoint, same date, 5× apart.
--
-- So the two rows below collide, and `on conflict do nothing` silently keeps one of them.
-- Found by inserting them and counting, not by reading the constraint: the failure mode
-- is not an error, it is a rate card that looks populated and prices half the call.
-- ─────────────────────────────────────────────────────────────

drop index rate_card_driver_model_endpoint_effective_key;

-- coalesce for the same reason 0003 used it: endpoint is nullable and NULLs never compare
-- equal, so a plain constraint would permit unlimited duplicate NULL-endpoint rows — the
-- exact case it exists to forbid.
create unique index rate_card_driver_model_endpoint_unit_effective_key
  on rate_card (driver, model, coalesce(endpoint, ''), unit, effective_from);

-- ─────────────────────────────────────────────────────────────
-- 4. Published rates for the drafting model
--
-- In the migration rather than seed.sql on purpose. seed.sql is local-only and explicitly
-- "never runs against production"; that is right for placeholder credit rates that have to
-- be replaced with an observed balance delta, but wrong for these. A published list price
-- is the same number in every environment, and a production database that cannot price a
-- call refuses to make it (rule 5) — so shipping these as data is what lets stage 3 run at
-- all after a deploy.
--
-- These are the only is_verified rows in rate_card, and the reason is narrow: the vendor
-- publishes the number. Every video rate stays unverified until someone watches a credit
-- balance move, because nobody publishes those.
--
-- unit_cost is per single token, not per million — the ledger multiplies quantity by
-- unit_cost and quantity is a token count.
-- ─────────────────────────────────────────────────────────────

insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('anthropic', 'claude-opus-5', '/v1/messages', 'input_token',  0.000005, 'USD', true,
   'Published list price: USD 5.00 per 1M input tokens. Read from Anthropic''s pricing '
   'table on 2026-08-01. effective_from is epoch rather than the date the price took '
   'effect, which is not published — it means "as far back as this project priced '
   'anything", and a later rate supersedes it by inserting a row, never by UPDATE.',
   '1970-01-01T00:00:00Z'),
  ('anthropic', 'claude-opus-5', '/v1/messages', 'output_token', 0.000025, 'USD', true,
   'Published list price: USD 25.00 per 1M output tokens. Read from Anthropic''s pricing '
   'table on 2026-08-01. Same note on effective_from as the input row.',
   '1970-01-01T00:00:00Z')
on conflict (driver, model, coalesce(endpoint, ''), unit, effective_from) do nothing;

-- Cache reads and cache writes are priced differently again, and are deliberately absent.
-- Stage 3 does not use prompt caching, and a rate card row for a call nobody makes is a
-- number waiting to be wrong.

-- ─────────────────────────────────────────────────────────────
-- 5. Fold script spend into the cost views
--
-- Two changes to v_script_cost, both to stop understating:
--
--   The FROM was `shots`, so a script with no shots yet produced no row at all — which is
--   the exact state a script is in the moment after it is drafted and charged. It now
--   starts from `scripts`.
--
--   Drafting cost is added to generation cost. The two are aggregated in separate
--   subqueries rather than in one join: joining shots→generations→cost_ledger and
--   script-attributed cost_ledger rows in a single query fans the rows out and sums the
--   draft cost once per generation.
--
-- The third term is the modelling choice. Draft spend charged to a concept with no script
-- — a refusal, a truncation — belongs to the video that concept eventually became, but
-- there is no row saying which script that is. It is attributed to the *lowest-version*
-- script of the concept, so it is counted exactly once no matter how many redrafts follow.
--
-- That is a decision, not a fact. It makes the first version of a script look more
-- expensive than the second, which is true in the sense that the failures happened on the
-- way to it, and false in the sense that version 2 benefited from them. The alternative —
-- leaving it out of v_script_cost — makes cost-per-video quietly exclude money that was
-- actually spent, and this project's headline metric is the one number that must not
-- flatter itself.
-- ─────────────────────────────────────────────────────────────

drop view if exists v_cost_per_1k_views;
drop view if exists v_render_cost;
drop view if exists v_script_cost;

create view v_script_cost as
select
  sc.id as script_id,
  coalesce(gen.cost_inr, 0) + coalesce(draft.cost_inr, 0)  as cost_inr,
  coalesce(gen.cost_inr, 0)                                as generation_cost_inr,
  coalesce(draft.cost_inr, 0)                              as draft_cost_inr,
  coalesce(gen.generations_used, 0)                        as generations_used,
  coalesce(gen.generations_wasted, 0)                      as generations_wasted
from scripts sc
left join lateral (
  select
    sum(cl.cost_inr)                                        as cost_inr,
    count(distinct g.id)                                    as generations_used,
    count(distinct g.id) filter (where g.status = 'failed') as generations_wasted
  from shots s
  left join generations g  on g.shot_id = s.id
  left join cost_ledger cl on cl.generation_id = g.id
  where s.script_id = sc.id
) gen on true
left join lateral (
  select
    coalesce((
      select sum(cl.cost_inr) from cost_ledger cl where cl.script_id = sc.id
    ), 0)
    + case when sc.version = (
        select min(v.version) from scripts v where v.concept_id = sc.concept_id
      ) then coalesce((
        select sum(cl.cost_inr)
        from cost_ledger cl
        where cl.concept_id = sc.concept_id and cl.script_id is null
      ), 0) else 0 end
    as cost_inr
) draft on true;

comment on view v_script_cost is
  'Everything a script has cost, counted once: the LLM call that drafted it plus every '
  'generation against its shots, including wasted ones. A reshoot that cost money and '
  'produced nothing is part of what the script cost. The two components stay separately '
  'visible because they answer different questions — draft cost is fixed per script, '
  'generation cost is what a longer video buys.';

-- Unchanged from 0003 apart from reading the widened v_script_cost. The divisor and the
-- LEFT JOIN are both load-bearing; see the notes on FIX 4 and FIX 5 there.
create view v_render_cost as
select
  r.id        as render_id,
  r.script_id,
  coalesce(vsc.cost_inr, 0) / nullif(count(*) over (partition by r.script_id), 0)
    + coalesce((select sum(cl.cost_inr) from cost_ledger cl where cl.render_id = r.id), 0)
    as cost_inr,
  coalesce(vsc.generations_used, 0)   as generations_used,
  coalesce(vsc.generations_wasted, 0) as generations_wasted
from renders r
left join v_script_cost vsc on vsc.script_id = r.script_id
where r.kind = 'final';

comment on view v_render_cost is
  'Cost attributable to one final render, now including its share of the drafting call. '
  'Script-level spend is divided across the final renders of the same script because '
  'variants share it; SUM over this column is meaningful, SUM over an undivided one '
  'would not be. Rough cuts are excluded — they are a review artifact, not an output.';

create view v_cost_per_1k_views as
select
  p.id as publication_id,
  vrc.cost_inr,
  ms.views,
  case when ms.views > 0 then vrc.cost_inr / (ms.views / 1000.0) end as cost_per_1k_views
from publications p
join v_render_cost vrc     on vrc.render_id = p.render_id
join metrics_snapshots ms  on ms.publication_id = p.id and ms.age_bucket = '7d';

comment on view v_cost_per_1k_views is
  'The only number that touches the business question.';
