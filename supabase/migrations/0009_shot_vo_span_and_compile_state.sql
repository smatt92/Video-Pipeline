-- Migration 0009 — shots need to say which words they cover, and whether they compiled
--
-- Two gaps found while building stage 4. Both are the shape the earlier ones were: a
-- design that was correct for the case in front of it, used by a stage that arrived later.

-- ─────────────────────────────────────────────────────────────
-- 1. A shot has to know which speech it covers
--
-- Migration 0004 inverted the DAG so voice runs ahead of video: word timings define the
-- beat boundaries, and those boundaries set `shots.duration_s` with
-- `duration_source = 'derived_from_vo'`. That is the right ordering and it is currently
-- uncomputable, because nothing connects a shot to a range of speech.
--
-- The assumption underneath 0004 is that shots and beats are one-to-one. They are not, and
-- stage 4 is where that becomes obvious: a 3-beat script routinely wants 5 or 6 shots,
-- because a beat is an argument and a shot is a camera. As soon as one beat produces two
-- shots, "the beat's word timings set the shot's duration" has no answer for which half of
-- the words belongs to which shot.
--
-- Character offsets into `scripts.vo_text` rather than a beat index, because `vo_text` is
-- the exact string sent for synthesis and word timings come back aligned to it. A beat
-- index would need re-resolving to characters anyway, through the same joining rules that
-- built vo_text, and any drift there silently mistimes the video.
--
-- Nullable: a shot may deliberately cover no speech — an establishing frame, a cut to a
-- product shot under a pause. Those keep an authored duration and stage 6 leaves them
-- alone rather than deriving zero.
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column vo_char_start int,
  add column vo_char_end   int;

alter table shots
  add constraint shots_vo_span_valid
  check (
    (vo_char_start is null and vo_char_end is null)
    or (vo_char_start is not null and vo_char_end is not null
        and vo_char_start >= 0 and vo_char_end > vo_char_start)
  );

comment on column shots.vo_char_start is
  'Half-open character range [start, end) into scripts.vo_text that this shot is on screen '
  'for. The link stage 6 needs to turn word timings into a real duration. Null means the '
  'shot covers no speech and keeps its authored duration.';

create index on shots (script_id, vo_char_start);

-- ─────────────────────────────────────────────────────────────
-- 2. "Not compiled" and "could not be compiled" are different states
--
-- `prompt_id` and `compiled_params` are both nullable, and null means both "stage 4 has
-- not run" and "stage 4 ran and found no library prompt for this shot". Those are
-- different instructions — wait, versus go and discover a recipe — and a stuck video is
-- exactly when someone needs to know which they are looking at.
--
-- The same distinction `last_checked_at` bought for integrations in 0007. It keeps
-- arriving because a nullable result column can only ever encode two of the three states
-- any attempted operation actually has.
--
-- CLAUDE.md is explicit that production reads the prompt library and never improvises, so
-- "no matching prompt" is a legitimate, expected outcome rather than an error. It has to be
-- recordable without pretending a shot failed.
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column compiled_at    timestamptz,
  add column compile_note   text;

comment on column shots.compiled_at is
  'When compiled_params was last written. With compile_note this separates never-compiled '
  '(both null) from compiled (set) from attempted-and-unresolved (note set, compiled_at '
  'null) — which is the normal state for a shot whose recipe is not in the library yet.';

comment on column shots.compile_note is
  'Why compilation did not produce params: which tags were sought, what the library had. '
  'Production reads the library and never improvises (CLAUDE.md), so an empty library is a '
  'expected outcome with a next action, not a failure.';

-- ─────────────────────────────────────────────────────────────
-- 3. Shots that are ready to generate
--
-- The precondition stage 5 checks, in one place, so it cannot be spelled differently in
-- two. A shot is generatable when a library prompt was resolved and its params compiled.
-- ─────────────────────────────────────────────────────────────

create view v_shot_readiness as
select
  s.id            as shot_id,
  s.script_id,
  s.idx,
  s.status,
  s.duration_s,
  s.duration_source,
  s.prompt_id is not null and s.compiled_params is not null as generatable,
  s.compile_note,
  s.vo_char_start is not null                               as covers_speech
from shots s;

comment on view v_shot_readiness is
  'One row per shot: can stage 5 submit this? Generatable requires a resolved library '
  'prompt and compiled params — never improvised ones.';

-- ─────────────────────────────────────────────────────────────
-- 4. A script is charged by more than one stage
--
-- 0006 keyed LLM spend on (script_id, entry_kind, unit) so a retry could not double-charge
-- a drafting call. That was right for the only stage charging a script at the time.
--
-- Stage 4 charges the same script for the shotlist call, and the key rejects it — the two
-- rows collide with stage 3's. The first workaround was to route stage 4's *successful*
-- charge through the failed-draft path, which has a run-scoped key; that works and is a
-- lie, because a discriminator reading `failed_draft` on a successful call is a trap for
-- whoever queries it next.
--
-- The missing dimension is which stage spent the money. Adding it also makes cost-per-stage
-- answerable, which is a question the headline metric will want long before it is asked:
-- "is drafting or shot-listing the expensive part?" currently has no query.
-- ─────────────────────────────────────────────────────────────

alter table cost_ledger
  add column stage text;

comment on column cost_ledger.stage is
  'Pipeline stage that spent this, matching the src/trigger/ file name — 03-script, '
  '04-shotlist. Null on spend that is not attributable to a numbered stage. Part of the '
  'idempotency key, because two stages legitimately charge the same script.';

drop index cost_ledger_script_entry_key;

create unique index cost_ledger_script_stage_entry_key
  on cost_ledger (script_id, coalesce(stage, ''), entry_kind, unit)
  where script_id is not null;

create index on cost_ledger (stage) where stage is not null;

-- Existing rows predate the column and all came from stage 3.
update cost_ledger set stage = '03-script' where script_id is not null and stage is null;

create view v_cost_by_stage as
select
  stage,
  count(*)                          as entries,
  sum(cost_usd)                     as cost_usd,
  sum(cost_inr)                     as cost_inr
from cost_ledger
where stage is not null
group by stage;

comment on view v_cost_by_stage is
  'Which stage the money went to. Cheap to add now, and the first thing anyone asks when '
  'cost per video is higher than expected.';
