-- 0052 — The "3D explainer" video type (engineered), and the series of a second channel.
--
-- Forward-only. Four CHECKs widened, two columns added, one recipe seeded. No row is
-- rewritten: every script planned before this keeps its routes, every brief its series.
--
-- ── picture_clip ────────────────────────────────────────────────────────────
--
-- A new render route: a clip made FROM the shot's own generated picture (image-to-video,
-- first frame = the picture). The engineered format draws every beat as a picture and, on the
-- action beats, animates that picture. It is not a character beat: no character reference is
-- involved, and the planner's character-beat rules (seconds cap, locked frame) do not apply to
-- it. Reusing 'character_beat' for it would have put two meanings under one word in the same
-- column — the collision CLAUDE.md asks to rename the moment it is noticed.
--
-- ── shots.graphics ──────────────────────────────────────────────────────────
--
-- The graphics layer we draw over a shot (stage badge, verdict pill, callouts, meters, the
-- caption keyword). Named "graphics", not "overlay": `overlay` already means the chalk-diagram
-- route and `overlay_spec` its scene, and a third meaning beside them is how a column ends up
-- read wrongly for months. NULL = this shot has no graphics, never "unknown".
--
-- ── briefs.hero_objects ─────────────────────────────────────────────────────
--
-- The one to three objects an engineered episode keeps consistent in every picture (the
-- device, the vehicle). Per episode, not per channel: the object differs by topic. The
-- episode run generates one reference sheet per object and passes it as a tagged reference.
--
-- ── Series ids ──────────────────────────────────────────────────────────────
--
-- 'evolution' and 'inside' are Built Like That's series. A series id is a CHECK value
-- (channels/_template/README.md: "a new id is a migration") — this is that migration.
--
-- ── The recipe ──────────────────────────────────────────────────────────────
--
-- One gen4_turbo recipe for picture_clip, seeded RETIRED, exactly as 0044 seeded its two: a
-- migration never switches a vendor spend path on by itself, and a fresh database (every
-- harness, CI) keeps an empty active library. Its params carry `route: picture_clip`, so the
-- router never hands it a money shot or an acted beat, and the shot-kind compiler of the
-- legacy lane skips it (recipeForRoute in estimate.ts; shots/run.ts). The Built Like That
-- data bundle (10b) activates it, in one visible statement, because the reason 0044's were
-- retired — `accepts_character_ref` unobserved — does not apply to a clip that animates our
-- own picture, and every clip still passes the Cuts gate. Until it is active, both motion
-- levels plan their clips as pictures and Approvals says so.

alter table shots drop constraint if exists shots_render_route_check;
alter table shots
  add constraint shots_render_route_check
  check (render_route is null or render_route in ('overlay','still','picture_clip','character_beat','acted_beat','money_shot'));

alter table gen_jobs drop constraint if exists gen_jobs_render_route_check;
alter table gen_jobs
  add constraint gen_jobs_render_route_check
  check (render_route in ('picture_clip','character_beat','acted_beat','money_shot'));

alter table briefs drop constraint if exists briefs_series_check;
alter table briefs
  add constraint briefs_series_check
  check (series in ('incident','desk_tour','pip','archive','myth','deep','complaint','long_form','evolution','inside'));

alter table slots drop constraint if exists slots_series_check;
alter table slots
  add constraint slots_series_check
  check (series in ('incident','desk_tour','pip','archive','myth','deep','complaint','long_form','sequel','evolution','inside'));

alter table shots add column if not exists graphics jsonb
  check (graphics is null or jsonb_typeof(graphics) = 'object');

comment on column shots.graphics is
  'The graphics layer drawn over this shot by the assembler (engineered format): stage badge, '
  'verdict pill, callouts, meters, caption keyword. NULL = no graphics. Never drawn by a model.';

alter table briefs add column if not exists hero_objects jsonb not null default '[]'::jsonb
  check (jsonb_typeof(hero_objects) = 'array' and jsonb_array_length(hero_objects) <= 3);

comment on column briefs.hero_objects is
  'Engineered format: the 1–3 objects kept consistent in every picture of the episode, each '
  '{tag, name, look}. One reference sheet per object is generated per episode.';

comment on column shots.render_route is
  'Which engine renders the shot. still = one generated picture with our camera move (0021); '
  'picture_clip = a clip animated from that picture (0052); overlay = in-house chalk diagram, '
  'and the floor every route falls back to.';

insert into prompts (name, version, driver, model, template, params, tags, discovered_in,
                     is_active, accepts_character_ref, retired_at, retired_reason)
values
  ('engineered-picture-clip-gen4-turbo', 1, 'runway', 'gen4_turbo',
   'Animate this exact 3D render, keeping every object, colour and decal unchanged: {{description}}. Physically plausible motion, slight motion blur, camera moves gently with the action. No text appears.',
   '{"max_duration_s": 10, "route": "picture_clip"}'::jsonb, '{detail_macro}', 'manual', false, false, now(),
   'Seeded retired by 0052. The Built Like That bundle (10b) activates it; until then 3D-explainer clips are planned as pictures.')
on conflict (name, version) do nothing;
