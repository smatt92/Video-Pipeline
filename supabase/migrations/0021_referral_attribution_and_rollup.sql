-- Migration 0021 — referral attribution, and an aggregate a partner conversation can use
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: EVOLUTION, and the unusual sort — the schema is not wrong, it
-- simply never had to answer a commercial question before.
--
-- `integrations` records that a vendor is connected and whether it verified. That was the
-- whole job while the only consumer was the pipeline, which needs to know if a credential
-- works and nothing else about where it came from.
--
-- A partnership needs one more fact: whether a signup at the vendor happened *through*
-- Kiln. That fact is only observable at the moment somebody clicks through to create the
-- account — afterwards there is no way to recover it from either side, which is why this
-- is cheap now and impossible later. Nothing else in the schema has that property, and it
-- is the entire argument for doing it before it is needed.
-- ─────────────────────────────────────────────────────────────

alter table integrations
  add column referral_code   text,
  add column referral_source text,
  add column referred_at     timestamptz,
  add constraint integrations_referral_complete
    check (
      (referral_code is null and referred_at is null)
      or (referral_code is not null and referred_at is not null)
    );

comment on column integrations.referral_code is
  'The code Kiln sent the vendor when this account was created through our connect flow. '
  'Null means either the account predates the flow or the person signed up directly — the '
  'two are indistinguishable and must not be guessed apart, because an attribution claim '
  'that cannot be evidenced is worse than no claim in exactly the conversation it exists '
  'for.';

comment on column integrations.referral_source is
  'Where in Kiln the click originated: ''onboarding'', ''settings'', ''refusal''. The third '
  'is the interesting one — a refusal names the missing vendor and offers the connect link, '
  'so it is the highest-intent path in the product and worth being able to count separately.';

comment on constraint integrations_referral_complete on integrations is
  'A code without a timestamp is an attribution nobody can date, which is not evidence. '
  'Both or neither.';

-- ─────────────────────────────────────────────────────────────
-- The aggregate
--
-- Deliberately an aggregate and deliberately anonymised. What a partner conversation needs
-- is volume through Kiln — videos made, credits consumed, over a period. What it must not
-- carry is concept titles, script text, prompts or channel names, because those are the
-- operator's editorial work and are not ours to hand over.
--
-- So this view exposes counts and sums keyed on nothing but a month and a driver. There is
-- no id in it to join back to anything, which is what makes it safe to paste into an email
-- rather than merely intended to be.
-- ─────────────────────────────────────────────────────────────

create view v_partner_rollup as
select
  date_trunc('month', cl.occurred_at)::date            as period,
  cl.driver,
  cl.unit,
  sum(cl.quantity)                                     as units_consumed,
  round(sum(cl.cost_inr), 2)                           as cost_inr,
  count(distinct cl.generation_id)
    filter (where cl.generation_id is not null)        as generations,
  count(distinct r.id)                                 as renders_completed
from cost_ledger cl
left join generations g on g.id = cl.generation_id
left join shots s       on s.id = g.shot_id
left join renders r     on r.script_id = s.script_id and r.status = 'ready'
-- Estimates are excluded: an estimate is a row written before the vendor answered, and
-- counting both it and its reconciliation would double every figure here.
where cl.entry_kind <> 'estimate'
group by 1, 2, 3;

comment on view v_partner_rollup is
  'Volume through Kiln by month and driver. No ids, no titles, no prompts — nothing that '
  'could identify a video or a channel, because this is the shape that gets pasted into an '
  'email and the safety has to be in the view rather than in the discipline of whoever '
  'pastes it. Estimate rows are excluded so reconciled spend is not counted twice.';

create view v_referral_attribution as
select
  i.slug                                          as driver,
  i.referral_source,
  date_trunc('month', i.referred_at)::date        as period,
  count(*)                                        as accounts_connected,
  count(*) filter (where i.last_verified_at is not null) as accounts_verified
from integrations i
where i.referral_code is not null
group by 1, 2, 3;

comment on view v_referral_attribution is
  'Signups attributable to Kiln, by vendor and by where in the product the click came from. '
  'accounts_verified is the honest denominator for any conversion claim: a connected '
  'integration that never verified is a form somebody filled in, not a working account.';

notify pgrst, 'reload schema';
