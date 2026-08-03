-- Migration 0018 — a shot can be trimmed and shots can be reordered
--
-- The review screen's two editing gestures are in/out handles and drag reorder. Neither
-- has anywhere to live, and reorder cannot be done at all with the constraint as written.
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: 1 is EVOLUTION, 2 is a SPECIFICATION ERROR.
--
-- 1 — trims. `shots.duration_s` was correct for its original case: stage 4 authors a
-- duration, stage 6 replaces it with one derived from word timings, and stage 5 generates
-- a clip of that length. Review is the second case and it asks a question the column
-- cannot answer — "use 0.4s to 3.1s of this clip" is not a duration, it is a window, and
-- overwriting duration_s with the window's length would destroy the record of what was
-- generated and paid for. A generated clip is expensive and immutable; the trim is cheap
-- and revisable. They are different facts. Evolution.
--
-- 2 — reorder. `unique (script_id, idx)` is correct and `idx` is the ordering, so the two
-- together make the ordinary reordering operation impossible: swapping two shots requires
-- a moment where both hold the same idx, and a plain UPDATE hits the constraint mid-
-- statement. The schema specifies an ordered collection and forbids reordering it. That is
-- a contradiction on its own page — the constraint and the column disagree about what idx
-- is for — and it is a specification error rather than a gap.
--
-- The fix is not to drop the constraint. Losing it would let two shots share an index, and
-- the concat list is built in idx order, so a duplicate silently produces a cut whose
-- shot order depends on scan order. That is the silent-wrongness failure this whole area
-- keeps producing. The fix is a function that renumbers in two phases inside one
-- statement, which is what the constraint should have shipped with.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 1. In and out points
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column trim_in_s  numeric,
  add column trim_out_s numeric,
  add constraint shots_trim_window_valid
    check (
      (trim_in_s is null and trim_out_s is null)
      or (trim_in_s is not null and trim_out_s is not null
          and trim_in_s >= 0 and trim_out_s > trim_in_s)
    );

comment on column shots.trim_in_s is
  'Seconds into the generated clip where this shot starts. NULL means untrimmed — which '
  'is not the same as 0, because 0 is a decision somebody made and NULL is one nobody has. '
  'Never overwrites duration_s: that records what was generated and billed, this records '
  'what the cut uses, and conflating them loses the ability to say a clip was paid for and '
  'mostly discarded.';

comment on constraint shots_trim_window_valid on shots is
  'Both or neither, and out strictly after in. A half-set window is the state a dragged '
  'handle passes through, and persisting one would produce a zero-length or negative '
  'segment that ffmpeg accepts and renders as nothing.';

-- The effective length of a shot in the cut. Generated so nothing has to remember the
-- rule, and so the assembler and the review screen cannot disagree about it.
alter table shots
  add column effective_duration_s numeric
    generated always as (
      case when trim_in_s is not null and trim_out_s is not null
        then trim_out_s - trim_in_s
        else duration_s
      end
    ) stored;

comment on column shots.effective_duration_s is
  'What this shot contributes to the cut. duration_s when untrimmed, the window otherwise. '
  'Generated rather than computed at each call site because 07-assemble asserts the render '
  'against the sum of these, and a render whose length disagrees with its rows is a failed '
  'render — so two implementations of this arithmetic is two chances to disagree.';

-- ─────────────────────────────────────────────────────────────
-- 2. Reordering, atomically
--
-- Two phases in one statement. The first moves every shot in the script to a negative
-- index, which cannot collide with the positive ones being assigned; the second writes the
-- new order. Both inside one function call, so no other transaction observes the negatives.
--
-- Takes the complete new order and rejects a partial one. A caller that passes three of
-- five ids is holding a stale list — the other two were added since it loaded — and
-- renumbering against it would silently drop them to the end in whatever order the scan
-- returned.
-- ─────────────────────────────────────────────────────────────

create or replace function reorder_shots(p_script_id uuid, p_shot_ids uuid[])
returns int
language plpgsql
as $$
declare
  existing uuid[];
  moved int;
begin
  select array_agg(id order by id) into existing from shots where script_id = p_script_id;

  if existing is null then
    raise exception 'reorder_shots: script % has no shots', p_script_id;
  end if;

  if (select array_agg(id order by id) from unnest(p_shot_ids) as t(id)) is distinct from existing then
    raise exception
      'reorder_shots: the id list is not this script''s shots. Expected % ids, got %. A '
      'partial or stale list would renumber the shots it names and leave the rest wherever '
      'the scan put them.',
      array_length(existing, 1), array_length(p_shot_ids, 1);
  end if;

  -- Phase 1: out of the way. Negative indexes cannot collide with the ones about to be
  -- written, and `unique (script_id, idx)` holds throughout.
  update shots
  set idx = -idx - 1
  where script_id = p_script_id;

  -- Phase 2: the new order.
  update shots s
  set idx = o.position - 1
  from unnest(p_shot_ids) with ordinality as o(id, position)
  where s.id = o.id and s.script_id = p_script_id;

  get diagnostics moved = row_count;
  return moved;
end $$;

comment on function reorder_shots(uuid, uuid[]) is
  'Renumber a script''s shots to the given order. Two phases in one statement so the '
  'unique constraint on (script_id, idx) is never violated mid-way — which is why a plain '
  'UPDATE cannot do this and why the constraint must not be dropped to make it possible.';

-- ─────────────────────────────────────────────────────────────
-- 3. Review needs to know whether the structure is novel
--
-- `reviews.structure_novel` is NOT NULL and nothing computes it. ARCHITECTURE.md §0.2
-- gives it a job — hard-block publish when the last N videos share a beat structure — and
-- a column the reviewer supplies by hand is a column that says whatever makes the review
-- pass.
--
-- A view rather than a trigger: the *threshold* is an editorial judgement and belongs
-- outside SQL, but "how many other scripts share this hash" is arithmetic and belongs here.
-- ─────────────────────────────────────────────────────────────

create view v_script_structure_novelty as
select
  s.id                                          as script_id,
  s.structure_hash,
  count(*) filter (where o.id is not null)      as shared_with,
  -- studio-stub hashes are per-session by construction and can never collide, so they must
  -- not be reported as novel-because-unique. They are novel-because-unmeasured, which is a
  -- different claim and the review screen says so.
  s.structure_hash like 'studio-stub:%'         as unmeasured,
  array_remove(array_agg(o.id), null)           as shared_script_ids
from scripts s
left join scripts o
  on o.structure_hash = s.structure_hash
 and o.id <> s.id
 and o.structure_hash not like 'studio-stub:%'
group by s.id, s.structure_hash;

comment on view v_script_structure_novelty is
  'How many other scripts are built the same way. A collision is not plagiarism and is not '
  'on its own a reason to refuse — the publish threshold is editorial and lives outside '
  'SQL. This is the arithmetic the reviewer should not be doing by hand into a NOT NULL '
  'boolean.';

-- ─────────────────────────────────────────────────────────────
-- 4. A review is about a render, and there can be more than one
--
-- `reviews` already keys on render_id and orders by created_at desc, so re-reviewing is
-- supported. What is missing is which review is the current one: `enforce_review_pass`
-- reads the review named by the publication, so a superseded 'reshoot' can gate a
-- publication forever if somebody points at the wrong row.
-- ─────────────────────────────────────────────────────────────

create view v_current_review as
select distinct on (r.render_id)
  r.render_id,
  r.id           as review_id,
  r.decision,
  r.notes,
  r.reshoot_shot_ids,
  r.structure_novel,
  r.human_edit_count,
  r.created_at
from reviews r
order by r.render_id, r.created_at desc;

comment on view v_current_review is
  'The latest review per render. The publish gate reads whichever review the publication '
  'names, deliberately — this is what the UI should offer so a superseded decision is not '
  'the one that gets cited.';

notify pgrst, 'reload schema';
