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
