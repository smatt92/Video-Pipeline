-- 0047 — Scene stills (decision 0021).
--
-- Every Bureau shot that is not a money shot is planned as a generated STILL — one 9:16
-- image of the scene, no people — drawn full-bleed with a slow camera move. The chalk
-- overlay stays as the fallback when a still cannot be had.
--
-- Forward-only. One CHECK widened, one column added. No row is rewritten, so every script
-- planned before this migration keeps its routes.
--
-- ── Why the switch is a column ──────────────────────────────────────────────
--
-- `channel_policy.stills_enabled` is the per-channel kill switch for stills (true by
-- default). It is also the probe the code reads to know whether this migration has been
-- pasted: until the column exists, `stillsAvailability` answers "unavailable — 0047 is not
-- applied" and every shot plans as an overlay, exactly as before. The code ships before the
-- bundle is pasted and works either side of it.

alter table shots drop constraint if exists shots_render_route_check;
alter table shots
  add constraint shots_render_route_check
  check (render_route is null or render_route in ('overlay','still','character_beat','acted_beat','money_shot'));

comment on column shots.render_route is
  'Which engine renders the shot. still = one generated scene image (no people) drawn with a '
  'slow camera move (0021); overlay = in-house chalk diagram, and the fallback for a still. '
  'Distinct from shot_kind (framing vocabulary for recipes) on purpose.';

alter table channel_policy
  add column stills_enabled boolean not null default true;

comment on column channel_policy.stills_enabled is
  'Kill switch for scene stills on this channel. false → every shot plans as an overlay, with '
  'that reason recorded on the episode. Also the probe for whether 0047 is applied.';
