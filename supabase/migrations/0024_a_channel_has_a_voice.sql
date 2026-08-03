-- Migration 0024 — the host voice is a setting, not a fixture
--
-- ─────────────────────────────────────────────────────────────
-- Which of the two kinds: SPECIFICATION ERROR, of the quiet sort.
--
-- Not a schema that contradicts itself on its own page — a schema that never expressed a
-- fact the pipeline structurally depends on. `vo_takes.voice_id` records which voice *was*
-- used; nothing records which voice *should be* used. The settings screen reads
-- `VOICE_SETTINGS.hostVoice`, which is a constant in a fixtures file.
--
-- The consequence is not cosmetic, and it is why this is a specification error rather than
-- an omission. Stage 6 takes a `voiceId` argument. With nowhere to read one from, stage 6
-- can only be triggered by hand. Stage 5 refuses every shot whose `duration_source` is not
-- `derived_from_vo`, and **only stage 6 sets that value**. So the whole 03 → 04 → 05 chain
-- submits zero shots, always — complete, green, and inert.
--
-- One missing column made four working stages produce nothing, and no test could show it:
-- every stage passes its own harness, and the emptiness only appears end to end.
--
-- ── On the channel, not in a global setting ──────────────────────────────────
--
-- ARCHITECTURE.md §0.1 treats the channel as the unit that accumulates value. Two channels
-- in different niches want different voices, and a workspace-wide host voice would have to
-- be undone the moment a second channel exists. Per-channel is where it belongs even while
-- there is only one.
-- ─────────────────────────────────────────────────────────────

alter table channels
  add column host_voice_id  text,
  add column voice_language text not null default 'en';

comment on column channels.host_voice_id is
  'The voice stage 6 renders this channel''s voiceover with. Null means stage 6 cannot run '
  'unattended, which in turn means stage 5 has nothing to submit — it refuses any shot '
  'whose duration is still the shotlist estimate. Setting this is what makes the pipeline '
  'chain from an approved concept to a submitted generation without a human in the middle.';

comment on column channels.voice_language is
  'BCP-47-ish language tag passed to the voice vendor. Defaulted rather than nullable: '
  'every vendor needs one, and "unset" is not a language.';

-- ─────────────────────────────────────────────────────────────
-- Why a chain would stop, in one place
--
-- The failure this exists to make visible is silence: an approved concept that produces a
-- script, a shotlist, and then nothing at all. Reading it back from four tables is how that
-- goes unnoticed for a week.
-- ─────────────────────────────────────────────────────────────

create view v_pipeline_blockers as
select
  s.id                                as script_id,
  c.id                                as concept_id,
  c.channel_id,
  c.title,
  s.created_at,
  case
    when ch.host_voice_id is null then 'no host voice on the channel — stage 6 cannot run'
    when not exists (select 1 from shots sh where sh.script_id = s.id)
      then 'no shots — stage 4 has not run'
    when exists (
      select 1 from shots sh
       where sh.script_id = s.id and sh.compiled_params is null
    ) then 'some shots have no compiled parameters — no library recipe matched'
    when exists (
      select 1 from shots sh
       where sh.script_id = s.id and sh.duration_source <> 'derived_from_vo'
    ) then 'durations are still estimates — stage 6 has not run'
    else null
  end as blocker
from scripts s
join concepts c on c.id = s.concept_id
join channels ch on ch.id = c.channel_id;

comment on view v_pipeline_blockers is
  'For every script, the first reason it cannot reach a generation — or null when nothing '
  'is blocking it. Ordered by how early the stage sits, so the answer is the *first* thing '
  'to fix rather than a list. Exists because the failure mode of this pipeline is silence: '
  'an approved concept that yields a script, a shotlist, and then nothing.';

notify pgrst, 'reload schema';
