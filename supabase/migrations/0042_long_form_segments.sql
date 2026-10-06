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
