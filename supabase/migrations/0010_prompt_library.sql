-- Migration 0010 — the prompt library becomes selectable, and shots say what they need
--
-- One finding, and it is the evolution kind rather than the specification kind.
--
-- `shots` was designed before there was a library to select from, so it carries a
-- description and nothing categorical. That was complete for its own purposes and
-- incomplete the moment compilation had more than one recipe to choose between: matching a
-- free-text description against a template is a guess, and the fallback ("first entry for
-- this driver") would compile all six shots of a video to the same camera. Nothing in the
-- spec was wrong; a new consumer needed a signal the producer had no reason to emit.

-- ─────────────────────────────────────────────────────────────
-- 1. A shot says what kind of frame it is
--
-- Closed vocabulary, mirrored in src/lib/shots/kinds.ts and enforced here so the two
-- cannot drift. Editorial rather than technical — what the frame *is*, not how a vendor
-- makes it — which keeps a second vendor's library a set of new rows rather than a new
-- vocabulary.
--
-- Nullable, because shots written before this migration have no kind and inventing one for
-- them would be a guess recorded as a fact. Those rows simply do not match any recipe and
-- appear in v_unresolved_shots saying so.
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column shot_kind text
    check (shot_kind is null or shot_kind in (
      'establishing', 'subject_medium', 'detail_macro', 'action_insert',
      'environment_move', 'abstract', 'graphic_plate'
    ));

comment on column shots.shot_kind is
  'What kind of frame this is, from the closed vocabulary in src/lib/shots/kinds.ts. The '
  'signal compilation matches against prompts.tags. Null on shots written before the '
  'library existed — they match nothing, and say so, rather than being assigned a guess.';

create index on shots (shot_kind) where shot_kind is not null;

-- ─────────────────────────────────────────────────────────────
-- 2. The library gets an identity and a lifecycle
--
-- `prompts` had no key beyond its uuid, so "name X version 2" could exist twice and a
-- lookup would depend on scan order — the same defect 0002 fixed on rate_card, for the
-- same reason: this table decides what gets generated and what it costs.
--
-- Retirement is a flag, never a delete. `shots.prompt_id` references this table with no
-- ON DELETE clause, so Postgres already refuses to remove a referenced recipe — which is
-- correct and is a error message rather than a workflow. A retired recipe stops being
-- selected, keeps its rows, and keeps whatever win_rate it earned.
-- ─────────────────────────────────────────────────────────────

alter table prompts
  add column is_active  boolean not null default true,
  add column retired_at timestamptz,
  add column retired_reason text;

-- One row per (name, version). Editing a recipe adds a version; it never mutates one,
-- because shots.compiled_params snapshots what was used and win_rate is earned by a
-- specific set of parameters. Rewriting a recipe in place would make both meaningless.
create unique index prompts_name_version_key on prompts (name, version);

create index on prompts (driver, is_active) where is_active;
create index on prompts using gin (tags);

comment on column prompts.is_active is
  'False = retired. Not selected by compilation, never deleted. A recipe that produced a '
  'clip you shipped is evidence about how that clip was made.';

comment on column prompts.win_rate is
  'Backfilled from generation success and QA outcomes. Deliberately null until generations '
  'exist — ranking over an all-null column is a coin toss wearing a confident interface, '
  'so compilation orders by it only where it is present.';

-- Provenance. CLAUDE.md: a recipe discovered in an exploratory MCP session is persisted
-- here with discovered_in='claude-code-mcp' and the exact params. Constrained so the field
-- stays groupable — "where did our working recipes come from?" is answerable only if the
-- answer is from a closed set.
alter table prompts
  add constraint prompts_discovered_in_check
  check (discovered_in is null or discovered_in in ('claude-code-mcp', 'manual', 'imported'));

-- A recipe without the parameters it was proven with is worthless: the template alone does
-- not reproduce the clip, and a row that looks like a recipe and cannot reproduce anything
-- is worse than an empty library, because the library is trusted.
alter table prompts
  add constraint prompts_params_not_empty
  check (params is not null and params <> '{}'::jsonb);

comment on column prompts.params is
  'The exact vendor parameters the recipe was proven with, verbatim as submitted. Not a '
  'summary and not defaults — motion, aspect, quality, seed policy, whatever was actually '
  'sent. Enforced non-empty: a recipe that cannot reproduce its own sample is not a recipe.';

-- ─────────────────────────────────────────────────────────────
-- 3. What is blocked, and what would unblock it
--
-- The worklist for an exploratory session: which shot kinds are waiting, how many shots
-- and scripts each is holding up, and whether any active recipe already serves it.
-- ─────────────────────────────────────────────────────────────

create view v_unresolved_shots as
select
  s.id                as shot_id,
  s.script_id,
  s.idx,
  s.shot_kind,
  s.description,
  s.duration_s,
  s.compile_note,
  c.title             as concept_title,
  ch.name             as channel_name,
  (select count(*) from prompts p
    where p.is_active and s.shot_kind is not null and s.shot_kind = any(p.tags))
                      as matching_recipes
from shots s
join scripts sc on sc.id = s.script_id
join concepts c  on c.id = sc.concept_id
join channels ch on ch.id = c.channel_id
where s.compiled_params is null;

comment on view v_unresolved_shots is
  'Every shot that cannot be generated, with what it is asking for. matching_recipes is '
  'zero when nothing in the library serves this kind — which is the queue for an '
  'exploratory session, not an error state.';

create view v_recipe_gaps as
select
  s.shot_kind,
  count(*)                        as shots_waiting,
  count(distinct s.script_id)     as scripts_blocked,
  sum(s.duration_s)               as seconds_waiting,
  (select count(*) from prompts p
    where p.is_active and s.shot_kind = any(p.tags)) as active_recipes
from shots s
where s.compiled_params is null and s.shot_kind is not null
group by s.shot_kind
order by count(*) desc;

comment on view v_recipe_gaps is
  'The exploratory session worklist, ordered by how much is blocked on each kind. A row '
  'with active_recipes = 0 is a kind nobody has a working recipe for yet.';

-- ─────────────────────────────────────────────────────────────
-- 4. v_shot_readiness has to say what the shot was asking for
--
-- 0009 created it one migration before `shot_kind` existed, so it answers "can stage 5
-- submit this?" without saying what would make the answer yes. That is half a view: the
-- reason a shot is not generatable is the actionable part, and having to join back to
-- `shots` for it means two places will spell the readiness rule differently within a month.
-- ─────────────────────────────────────────────────────────────

drop view v_shot_readiness;

create view v_shot_readiness as
select
  s.id            as shot_id,
  s.script_id,
  s.idx,
  s.status,
  s.shot_kind,
  s.duration_s,
  s.duration_source,
  s.prompt_id is not null and s.compiled_params is not null as generatable,
  s.compile_note,
  s.vo_char_start is not null                               as covers_speech,
  (select count(*) from prompts p
    where p.is_active and s.shot_kind is not null and s.shot_kind = any(p.tags))
                                                            as matching_recipes
from shots s;

comment on view v_shot_readiness is
  'One row per shot: can stage 5 submit this, and if not, what is missing. Generatable '
  'requires a resolved library prompt and compiled params — never improvised ones. '
  'matching_recipes = 0 means nothing in the library serves this kind yet.';
