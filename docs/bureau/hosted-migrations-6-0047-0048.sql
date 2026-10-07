-- Kiln — migrations 0047 to 0048, bundled for the Supabase SQL editor.
--
-- GENERATED FILE. Do not edit; regenerate with `pnpm db:bundle`.
--
-- ── How to use ──────────────────────────────────────────────────────────────
--
--   1. Supabase dashboard → SQL Editor → New query
--   2. Paste this entire file
--   3. Run
--
-- Expected output is "Success. No rows returned". Anything else means nothing was
-- applied: the whole file is one transaction, so a failure rolls back every statement in
-- it. There is no half-applied state to clean up.
--
-- The last statement in this file is `notify pgrst, 'reload schema'`. Without it the
-- app keeps reporting "Could not find the table 'public.X' in the schema cache" even
-- though every table exists — PostgREST caches the schema and pasting SQL does not tell
-- it to reload. It is included; you do not need to run it separately.
--
-- ── Running it twice ────────────────────────────────────────────────────────
--
-- Safe. The guard below raises before any schema change if any of these versions is
-- already recorded, and the transaction rolls back. You will see an error that says so in
-- words — that error is the file working, not failing.
--
-- ── What it records ─────────────────────────────────────────────────────────
--
-- Each migration is written into supabase_migrations.schema_migrations, the same table
-- `supabase db push` uses. If the CLI starts working later it reads this as its own
-- history and reports the project up to date rather than replaying anything.
--
-- Migrations included (2):
--   0047  scene_stills
--   0048  channel_bibles

begin;

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key
);

alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;

-- ── Guard ───────────────────────────────────────────────────────────────────
do $kiln_guard$
declare
  seen text;
begin
  select string_agg(version, ', ' order by version) into seen
  from supabase_migrations.schema_migrations
  where version in ('0047', '0048');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0047_scene_stills.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0047 scene_stills'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0047', 'scene_stills', array[$kiln_0047$-- 0047 — Scene stills (decision 0021).
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
$kiln_0047$])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 0048_channel_bibles.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0048 channel_bibles'; end $kiln_progress$;

-- 0048 — The channel bible in the database (decision 0022).
--
-- Until now a channel's bible was a folder in the repo (channels/<slug>/), so adding a
-- channel, a cast member or a voice meant a laptop, a commit and a worker deploy. These two
-- tables hold the same content; `getBible(db, channelId)` reads them first and falls back to
-- the folder (saying so in a log line) only when a channel has no row here. The worker and
-- Vercel read the same rows, so a cast or voice change needs no deploy.
--
-- Forward-only. Two new tables; nothing existing is altered. Every reader in src/ tolerates
-- them being absent (the bundle may not be pasted yet): a missing table reads as "no DB
-- bible", which means the folder, which is exactly what it meant before.
--
-- ── Shape ────────────────────────────────────────────────────────────────────
--
-- channel_bibles holds the channel-wide parts as jsonb, validated by the same Zod schemas
-- the folder is validated by (src/lib/bureau/bible.ts) on every read — a malformed edit
-- fails the read by name rather than drafting against half a bible. channel_characters is
-- one row per cast member, so a cast change is a row, not a rewrite of one document.
--
-- `channel_characters` is the AUTHORED cast. `characters` (0037) stays what it was: the
-- runtime mirror `syncCast` writes from whichever bible is in force, carrying the routed
-- voice key and the usable reference frame. Two tables, two jobs; 0022 says why they are not
-- merged.
--
-- Vendor-neutral names throughout (rule 1: the generated types live outside the driver
-- layer). `voice` is {provider, preset_id, direct_voice_id?}; the driver layer maps it.

create table channel_bibles (
  channel_id    uuid primary key references channels(id) on delete cascade,
  world         jsonb not null,
  publishing    jsonb,
  -- { "<series id>": <series document> } — the series this channel runs.
  series        jsonb not null default '{}'::jsonb check (jsonb_typeof(series) = 'object'),
  policy        jsonb not null,
  trend_sources jsonb not null default '{"subreddits": [], "youtube": null}'::jsonb,
  version       integer not null default 1 check (version > 0),
  updated_at    timestamptz not null default now(),
  -- Who last wrote it: 'ui:<profile id>', 'import:<source>' or 'script:<name>'.
  updated_by    text not null check (length(updated_by) > 0)
);

comment on table channel_bibles is
  'A channel''s bible (world, publishing, series, content policy, trend sources). Read by '
  'getBible before channels/<slug>/; written only through the approver actions and the import.';

create table channel_characters (
  id                uuid primary key default gen_random_uuid(),
  channel_id        uuid not null references channels(id) on delete cascade,
  slug              text not null check (slug ~ '^[a-z_]+$'),
  name              text not null check (length(name) > 0),
  role              text not null check (length(role) > 0),
  desk              text not null default 'general',
  on_screen         boolean not null default true,
  season_introduced integer not null default 1 check (season_introduced > 0),
  personality       text not null check (length(personality) > 0),
  accent_hex        text not null check (accent_hex ~ '^#[0-9A-Fa-f]{6}$'),
  voice             jsonb not null check (voice ? 'provider'),
  voice_brief       text not null check (length(voice_brief) > 0),
  visual_lock       jsonb not null,
  catchphrase       jsonb not null,
  speech_rules      jsonb not null check (jsonb_typeof(speech_rules) = 'array'),
  never_do          jsonb not null check (jsonb_typeof(never_do) = 'array'),
  -- The locked reference frames, as written by frame:lock (storage:<key> or https), or [].
  reference_frame   jsonb not null default '[]'::jsonb check (jsonb_typeof(reference_frame) = 'array'),
  sort              integer not null default 0,
  active            boolean not null default true,
  updated_at        timestamptz not null default now(),
  unique (channel_id, slug)
);

create index channel_characters_channel_idx on channel_characters (channel_id, sort);

comment on table channel_characters is
  'The authored cast of a channel. One row per character; inactive rows are kept, not deleted. '
  '`characters` is the runtime mirror syncCast derives from this.';

alter table channel_bibles     enable row level security;
alter table channel_characters enable row level security;

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0048', 'channel_bibles', array[$kiln_0048$-- 0048 — The channel bible in the database (decision 0022).
--
-- Until now a channel's bible was a folder in the repo (channels/<slug>/), so adding a
-- channel, a cast member or a voice meant a laptop, a commit and a worker deploy. These two
-- tables hold the same content; `getBible(db, channelId)` reads them first and falls back to
-- the folder (saying so in a log line) only when a channel has no row here. The worker and
-- Vercel read the same rows, so a cast or voice change needs no deploy.
--
-- Forward-only. Two new tables; nothing existing is altered. Every reader in src/ tolerates
-- them being absent (the bundle may not be pasted yet): a missing table reads as "no DB
-- bible", which means the folder, which is exactly what it meant before.
--
-- ── Shape ────────────────────────────────────────────────────────────────────
--
-- channel_bibles holds the channel-wide parts as jsonb, validated by the same Zod schemas
-- the folder is validated by (src/lib/bureau/bible.ts) on every read — a malformed edit
-- fails the read by name rather than drafting against half a bible. channel_characters is
-- one row per cast member, so a cast change is a row, not a rewrite of one document.
--
-- `channel_characters` is the AUTHORED cast. `characters` (0037) stays what it was: the
-- runtime mirror `syncCast` writes from whichever bible is in force, carrying the routed
-- voice key and the usable reference frame. Two tables, two jobs; 0022 says why they are not
-- merged.
--
-- Vendor-neutral names throughout (rule 1: the generated types live outside the driver
-- layer). `voice` is {provider, preset_id, direct_voice_id?}; the driver layer maps it.

create table channel_bibles (
  channel_id    uuid primary key references channels(id) on delete cascade,
  world         jsonb not null,
  publishing    jsonb,
  -- { "<series id>": <series document> } — the series this channel runs.
  series        jsonb not null default '{}'::jsonb check (jsonb_typeof(series) = 'object'),
  policy        jsonb not null,
  trend_sources jsonb not null default '{"subreddits": [], "youtube": null}'::jsonb,
  version       integer not null default 1 check (version > 0),
  updated_at    timestamptz not null default now(),
  -- Who last wrote it: 'ui:<profile id>', 'import:<source>' or 'script:<name>'.
  updated_by    text not null check (length(updated_by) > 0)
);

comment on table channel_bibles is
  'A channel''s bible (world, publishing, series, content policy, trend sources). Read by '
  'getBible before channels/<slug>/; written only through the approver actions and the import.';

create table channel_characters (
  id                uuid primary key default gen_random_uuid(),
  channel_id        uuid not null references channels(id) on delete cascade,
  slug              text not null check (slug ~ '^[a-z_]+$'),
  name              text not null check (length(name) > 0),
  role              text not null check (length(role) > 0),
  desk              text not null default 'general',
  on_screen         boolean not null default true,
  season_introduced integer not null default 1 check (season_introduced > 0),
  personality       text not null check (length(personality) > 0),
  accent_hex        text not null check (accent_hex ~ '^#[0-9A-Fa-f]{6}$'),
  voice             jsonb not null check (voice ? 'provider'),
  voice_brief       text not null check (length(voice_brief) > 0),
  visual_lock       jsonb not null,
  catchphrase       jsonb not null,
  speech_rules      jsonb not null check (jsonb_typeof(speech_rules) = 'array'),
  never_do          jsonb not null check (jsonb_typeof(never_do) = 'array'),
  -- The locked reference frames, as written by frame:lock (storage:<key> or https), or [].
  reference_frame   jsonb not null default '[]'::jsonb check (jsonb_typeof(reference_frame) = 'array'),
  sort              integer not null default 0,
  active            boolean not null default true,
  updated_at        timestamptz not null default now(),
  unique (channel_id, slug)
);

create index channel_characters_channel_idx on channel_characters (channel_id, sort);

comment on table channel_characters is
  'The authored cast of a channel. One row per character; inactive rows are kept, not deleted. '
  '`characters` is the runtime mirror syncCast derives from this.';

alter table channel_bibles     enable row level security;
alter table channel_characters enable row level security;
$kiln_0048$])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- Import: channels/bureau-of-reality/ → channel_bibles + channel_characters (0022)
-- GENERATED by scripts/bible-import.mjs from the JSON in the repo. Do not edit by hand.
-- Idempotent: on conflict do nothing — an edit already made in the app is never overwritten.
-- ════════════════════════════════════════════════════════════════════════════

insert into channel_bibles (channel_id, world, publishing, series, policy, trend_sources, version, updated_by)
select (select id from channels where slug = 'bureau-of-reality'), '{"name":"The Bureau of Reality","premise":"A tired government department that keeps physics, time, history and myth working. Every Short is one real mechanism explained through a workplace conflict.","palette":{"paper":"#0B1F3A","grid":"#1C3A63","chalk":"#F4F1E8"},"style_rules":["White chalk-line stick figures on deep navy blueprint paper with faint grid lines.","Exactly one accent colour per character; nothing else on screen is saturated except overlays.","Adult office satire: memos, forms, budget meetings, compliance, burnout. Never a children''s cartoon.","No pastel nursery palettes, no squeaky voices, no sing-song narration, no toys, no classroom framing.","No resemblance to any existing franchise, mascot or real person."],"negative_prompt":"realistic human, photorealism, 3D plastic, anime, chibi, pastel kids style, nursery colours, text, watermark, logos, existing cartoon characters, extra limbs, inconsistent accessories","still_style":"White chalk line drawing on deep navy blueprint paper with faint grid lines, like a technical sketch on a blackboard; flat, hand-drawn, no shading, no photorealism."}'::jsonb, '{"hashtags":["science","physics","animation","explained","officecomedy"],"tags":["science","explained","animation","office comedy"],"category":"Comedy"}'::jsonb, '{"archive":{"id":"archive","name":"The Archive","day":"Thu","lead":["nib"],"template":"Case file → evidence → best current explanation","runtime_s":{"min":45,"target":60,"max":70},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":2,"purpose":"Visual paradox — the frame that makes a thumb stop. No dialogue needed.","render_route_hint":"character_beat|money_shot","loop_anchor":true},{"id":"stakes","start_s":2,"end_s":8,"purpose":"Who is in trouble and what breaks if nobody fixes it. Director Ohm memo allowed.","render_route_hint":"character_beat"},{"id":"mechanism_1","start_s":8,"end_s":18,"purpose":"First step of the real mechanism.","render_route_hint":"overlay","overlay":{"kind":"map","elements":["where and when"],"camera":"slow dolly-in","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_2","start_s":18,"end_s":29,"purpose":"Second step; the counter-intuitive part.","render_route_hint":"overlay","overlay":{"kind":"timeline","elements":["the evidence in order"],"camera":"slow pan","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_3","start_s":29,"end_s":40,"purpose":"Third step; ties back to the paradox.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["the best current explanation, labelled as such"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"fact","start_s":40,"end_s":55,"purpose":"One sourced real-world fact, spoken and shown as a filed stamp; URL logged to fact_sources.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["stamped case-file card","source line in small caps"],"camera":"static","notes":"Source domain visible; never a fabricated citation."}},{"id":"button","start_s":55,"end_s":60,"purpose":"Button gag, then a loop line that hands back to frame one.","render_route_hint":"character_beat","loop_line":true}],"structure_variants":[{"id":"case_file","shape":"Nib opens the file; three exhibits."},{"id":"competing_theories","shape":"Three theories, each tested against one exhibit."},{"id":"reconstruction","shape":"Nib rebuilds the scene as a blueprint model."}],"ending_types":["loop_back","cliffhanger_memo","reversal","callback_gag","deadpan_fact","form_stamped"],"premise_types":["unexplained_event","lost_object","impossible_artifact","historical_misconception"],"desks":["archive"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","serialised":false,"comment_sourced":false,"money_shot_allowed":true,"rules":["History mysteries only. No true crime, no victims as content, no living people.","Separate the record, the legend and the best current explanation in words."]},"complaint":{"id":"complaint","name":"Complaint Box","day":"Sun","lead":["complaint_box"],"template":"Real viewer comment → answer","runtime_s":{"min":45,"target":60,"max":70},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":2,"purpose":"Visual paradox — the frame that makes a thumb stop. No dialogue needed.","render_route_hint":"character_beat|money_shot","loop_anchor":true},{"id":"stakes","start_s":2,"end_s":8,"purpose":"Who is in trouble and what breaks if nobody fixes it. Director Ohm memo allowed.","render_route_hint":"character_beat"},{"id":"mechanism_1","start_s":8,"end_s":18,"purpose":"First step of the real mechanism.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["the question, pinned"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_2","start_s":18,"end_s":29,"purpose":"Second step; the counter-intuitive part.","render_route_hint":"overlay","overlay":{"kind":"cross_section","elements":["the mechanism"],"camera":"slow dolly-in","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_3","start_s":29,"end_s":40,"purpose":"Third step; ties back to the paradox.","render_route_hint":"overlay","overlay":{"kind":"graph","elements":["the answer in one picture"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"fact","start_s":40,"end_s":55,"purpose":"One sourced real-world fact, spoken and shown as a filed stamp; URL logged to fact_sources.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["stamped case-file card","source line in small caps"],"camera":"static","notes":"Source domain visible; never a fabricated citation."}},{"id":"button","start_s":55,"end_s":60,"purpose":"Button gag, then a loop line that hands back to frame one.","render_route_hint":"character_beat","loop_line":true}],"structure_variants":[{"id":"hand_off","shape":"Box reads it, hands it to the right desk."},{"id":"desk_argument","shape":"Two desks argue whose complaint it is."},{"id":"viewer_was_right","shape":"The viewer was right and the Bureau files a correction."}],"ending_types":["loop_back","cliffhanger_memo","reversal","callback_gag","deadpan_fact","form_stamped"],"premise_types":["viewer_question","viewer_misconception","viewer_challenge"],"desks":["complaints","gravity","time_calendars","archive","myth","chemistry","biology"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","serialised":false,"comment_sourced":true,"money_shot_allowed":true,"rules":["Built from complaint_candidates(); credit the handle only if the comment is public.","Never mock the viewer."]},"deep":{"id":"deep","name":"Deep Desk","day":"Sat","lead":["marlo","iyer"],"template":"Visual paradox → explanation (space, ocean)","runtime_s":{"min":45,"target":60,"max":70},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":2,"purpose":"Visual paradox — the frame that makes a thumb stop. No dialogue needed.","render_route_hint":"character_beat|money_shot","loop_anchor":true},{"id":"stakes","start_s":2,"end_s":8,"purpose":"Who is in trouble and what breaks if nobody fixes it. Director Ohm memo allowed.","render_route_hint":"character_beat"},{"id":"mechanism_1","start_s":8,"end_s":18,"purpose":"First step of the real mechanism.","render_route_hint":"overlay","overlay":{"kind":"orbit","elements":["the body and its motion"],"camera":"slow orbit","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_2","start_s":18,"end_s":29,"purpose":"Second step; the counter-intuitive part.","render_route_hint":"overlay","overlay":{"kind":"cross_section","elements":["what is underneath / inside"],"camera":"slow dolly-in","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_3","start_s":29,"end_s":40,"purpose":"Third step; ties back to the paradox.","render_route_hint":"overlay","overlay":{"kind":"graph","elements":["the number that makes it make sense"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"fact","start_s":40,"end_s":55,"purpose":"One sourced real-world fact, spoken and shown as a filed stamp; URL logged to fact_sources.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["stamped case-file card","source line in small caps"],"camera":"static","notes":"Source domain visible; never a fabricated citation."}},{"id":"button","start_s":55,"end_s":60,"purpose":"Button gag, then a loop line that hands back to frame one.","render_route_hint":"character_beat","loop_line":true}],"structure_variants":[{"id":"field_report","shape":"Marlo reports from the location; Iyer corrects the timing."},{"id":"scale_ladder","shape":"Zoom from human scale to the object in three steps."},{"id":"complaint_from_site","shape":"A memo from the planet/creature complains; the desk explains."}],"ending_types":["loop_back","cliffhanger_memo","reversal","callback_gag","deadpan_fact","form_stamped"],"premise_types":["visual_paradox","extreme_environment","scale_shock","strange_creature"],"desks":["planet","ocean","orbit","gravity","time_calendars"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","serialised":false,"comment_sourced":false,"money_shot_allowed":true,"rules":["At most one money shot per Short (space/ocean).","Numbers come from a primary source."]},"desk_tour":{"id":"desk_tour","name":"Desk Tour","day":"Tue","lead":["rotating_desk_head"],"template":"Tour → three-beat mechanism → twist","runtime_s":{"min":45,"target":60,"max":70},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":2,"purpose":"Visual paradox — the frame that makes a thumb stop. No dialogue needed.","render_route_hint":"character_beat|money_shot","loop_anchor":true},{"id":"stakes","start_s":2,"end_s":8,"purpose":"Who is in trouble and what breaks if nobody fixes it. Director Ohm memo allowed.","render_route_hint":"character_beat"},{"id":"mechanism_1","start_s":8,"end_s":18,"purpose":"First step of the real mechanism.","render_route_hint":"overlay","overlay":{"kind":"cross_section","elements":["the object, cut open"],"camera":"slow dolly-in","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_2","start_s":18,"end_s":29,"purpose":"Second step; the counter-intuitive part.","render_route_hint":"overlay","overlay":{"kind":"particles","elements":["what the parts actually do"],"camera":"slow orbit","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_3","start_s":29,"end_s":40,"purpose":"Third step; ties back to the paradox.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["the twist, labelled"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"fact","start_s":40,"end_s":55,"purpose":"One sourced real-world fact, spoken and shown as a filed stamp; URL logged to fact_sources.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["stamped case-file card","source line in small caps"],"camera":"static","notes":"Source domain visible; never a fabricated citation."}},{"id":"button","start_s":55,"end_s":60,"purpose":"Button gag, then a loop line that hands back to frame one.","render_route_hint":"character_beat","loop_line":true}],"structure_variants":[{"id":"walkthrough","shape":"Desk head walks Pip through three stations."},{"id":"inspection","shape":"Pip inspects the desk with a checklist; each item a beat."},{"id":"wrong_desk","shape":"Pip arrives at the wrong desk; the right answer emerges by contrast."},{"id":"night_shift","shape":"The desk at 3am — what it does when nobody watches."}],"ending_types":["loop_back","cliffhanger_memo","reversal","callback_gag","deadpan_fact","form_stamped"],"premise_types":["how_it_works","why_it_looks_like_that","hidden_department","misconception_fix"],"desks":["chemistry","optics","acoustics","botany","materials","weather","biology"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","serialised":false,"comment_sourced":false,"money_shot_allowed":true,"rules":["The desk head is a new or rotating character; the regular cast appears only as cameo.","Twist must be a true fact, not a gag."]},"incident":{"id":"incident","name":"Incident Report","day":"Mon","lead":["pip","marlo"],"template":"Accident → consequence ladder → real-world fact","runtime_s":{"min":45,"target":60,"max":70},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":2,"purpose":"Visual paradox — the frame that makes a thumb stop. No dialogue needed.","render_route_hint":"character_beat|money_shot","loop_anchor":true},{"id":"stakes","start_s":2,"end_s":8,"purpose":"Who is in trouble and what breaks if nobody fixes it. Director Ohm memo allowed.","render_route_hint":"character_beat"},{"id":"mechanism_1","start_s":8,"end_s":18,"purpose":"First step of the real mechanism.","render_route_hint":"overlay","overlay":{"kind":"exploded_view","elements":["the broken system","the switch Pip touched"],"camera":"slow dolly-in","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_2","start_s":18,"end_s":29,"purpose":"Second step; the counter-intuitive part.","render_route_hint":"overlay","overlay":{"kind":"graph","elements":["consequence curve over hours/days"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_3","start_s":29,"end_s":40,"purpose":"Third step; ties back to the paradox.","render_route_hint":"overlay","overlay":{"kind":"orbit","elements":["what restores equilibrium"],"camera":"slow orbit","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"fact","start_s":40,"end_s":55,"purpose":"One sourced real-world fact, spoken and shown as a filed stamp; URL logged to fact_sources.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["stamped case-file card","source line in small caps"],"camera":"static","notes":"Source domain visible; never a fabricated citation."}},{"id":"button","start_s":55,"end_s":60,"purpose":"Button gag, then a loop line that hands back to frame one.","render_route_hint":"character_beat","loop_line":true}],"structure_variants":[{"id":"ladder_hourly","shape":"Consequences escalate hour by hour; each rung a mechanism beat."},{"id":"ladder_by_scale","shape":"Consequences escalate by scale: desk → city → planet."},{"id":"rewind","shape":"Open on the disaster, rewind to the button press, then play the mechanism forward."},{"id":"blame_meeting","shape":"Told as an incident review meeting; each desk testifies one beat."}],"ending_types":["loop_back","cliffhanger_memo","reversal","callback_gag","deadpan_fact","form_stamped"],"premise_types":["what_if_removed","what_if_reversed","what_if_scaled","spill_or_leak","wrong_setting"],"desks":["gravity","orbit","optics","chemistry","biology","weather","time_calendars"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","serialised":false,"comment_sourced":false,"money_shot_allowed":true,"rules":["Pip causes it; Marlo explains it; nobody is punished on screen.","Consequences must be physically correct, not just funny."]},"long_form":{"id":"long_form","name":"Long-form episode","day":"Sun (alternate)","lead":["ensemble"],"template":"Cold open → aired Shorts reframed by NEW connective scenes → mid-episode Complaint Box → ending that sets up the next fortnight","runtime_s":{"min":480,"target":600,"max":720},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":30,"purpose":"New scene; never a re-cut Short.","render_route_hint":"character_beat"},{"id":"act_1","start_s":30,"end_s":240,"purpose":"Two aired Shorts, each introduced and closed by a new connective scene.","render_route_hint":"overlay"},{"id":"complaint_box","start_s":240,"end_s":300,"purpose":"Mid-episode Complaint Box moment.","render_route_hint":"character_beat"},{"id":"act_2","start_s":300,"end_s":540,"purpose":"Two or three aired Shorts with new framing; one new mechanism overlay.","render_route_hint":"overlay"},{"id":"ending","start_s":540,"end_s":600,"purpose":"Sets up the next fortnight.","render_route_hint":"character_beat"}],"structure_variants":[{"id":"anthology","shape":"Desk-by-desk anthology with Pip as guide."},{"id":"crisis_day","shape":"One crisis day; Shorts are the incidents."},{"id":"special","shape":"Seasonal special built around a festival or date."}],"ending_types":["setup_next_fortnight","cliffhanger_memo","callback_gag"],"premise_types":["anthology","crisis","seasonal_special","archive_volume"],"desks":["ensemble"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only.","serialised":false,"comment_sourced":false,"money_shot_allowed":true,"rules":["Never raw re-stitching: every included Short is framed by new scenes.","Generated character beats ≤ 90 s total; overlays preferred.","One approval brief per episode; estimate target ≤ ₹1,500."]},"myth":{"id":"myth","name":"Myth Desk","day":"Fri","lead":["kaz"],"template":"Myth → parallel in another culture → meaning","runtime_s":{"min":45,"target":60,"max":70},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":2,"purpose":"Visual paradox — the frame that makes a thumb stop. No dialogue needed.","render_route_hint":"character_beat|money_shot","loop_anchor":true},{"id":"stakes","start_s":2,"end_s":8,"purpose":"Who is in trouble and what breaks if nobody fixes it. Director Ohm memo allowed.","render_route_hint":"character_beat"},{"id":"mechanism_1","start_s":8,"end_s":18,"purpose":"First step of the real mechanism.","render_route_hint":"overlay","overlay":{"kind":"map","elements":["where each version is told"],"camera":"slow dolly-in","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_2","start_s":18,"end_s":29,"purpose":"Second step; the counter-intuitive part.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["the shared motif side by side"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_3","start_s":29,"end_s":40,"purpose":"Third step; ties back to the paradox.","render_route_hint":"overlay","overlay":{"kind":"timeline","elements":["how the story travelled or changed"],"camera":"slow pan","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"fact","start_s":40,"end_s":55,"purpose":"One sourced real-world fact, spoken and shown as a filed stamp; URL logged to fact_sources.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["stamped case-file card","source line in small caps"],"camera":"static","notes":"Source domain visible; never a fabricated citation."}},{"id":"button","start_s":55,"end_s":60,"purpose":"Button gag, then a loop line that hands back to frame one.","render_route_hint":"character_beat","loop_line":true}],"structure_variants":[{"id":"two_tellings","shape":"Two cultures tell it; Kaz finds the common thread."},{"id":"object_story","shape":"One object (lamp, mask, drum) leads into the myths."},{"id":"festival_eve","shape":"Framed on the eve of a festival; the meaning is the payoff."}],"ending_types":["loop_back","cliffhanger_memo","reversal","callback_gag","deadpan_fact","form_stamped"],"premise_types":["shared_motif","festival_origin","creature_comparison","symbol_meaning"],"desks":["myth"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","serialised":false,"comment_sourced":false,"money_shot_allowed":true,"rules":["Comparative and interpretive: ''is said to mean'', ''one popular reading''.","No devotional framing; deities are never characters; nothing is ranked."]},"pip":{"id":"pip","name":"Pip''s First Year","day":"Wed","lead":["pip"],"template":"Serialised arc, one idea per episode","runtime_s":{"min":45,"target":60,"max":70},"beat_sheet":[{"id":"cold_open","start_s":0,"end_s":2,"purpose":"Visual paradox — the frame that makes a thumb stop. No dialogue needed.","render_route_hint":"character_beat|money_shot","loop_anchor":true},{"id":"stakes","start_s":2,"end_s":8,"purpose":"Who is in trouble and what breaks if nobody fixes it. Director Ohm memo allowed.","render_route_hint":"character_beat"},{"id":"mechanism_1","start_s":8,"end_s":18,"purpose":"First step of the real mechanism.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["the idea Pip is learning"],"camera":"slow dolly-in","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_2","start_s":18,"end_s":29,"purpose":"Second step; the counter-intuitive part.","render_route_hint":"overlay","overlay":{"kind":"timeline","elements":["how the idea was discovered"],"camera":"slow pan","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"mechanism_3","start_s":29,"end_s":40,"purpose":"Third step; ties back to the paradox.","render_route_hint":"overlay","overlay":{"kind":"graph","elements":["the idea applied"],"camera":"static","notes":"","palette":"chalk on navy; one accent from the lead character","max_labels":3}},{"id":"fact","start_s":40,"end_s":55,"purpose":"One sourced real-world fact, spoken and shown as a filed stamp; URL logged to fact_sources.","render_route_hint":"overlay","overlay":{"kind":"diagram","elements":["stamped case-file card","source line in small caps"],"camera":"static","notes":"Source domain visible; never a fabricated citation."}},{"id":"button","start_s":55,"end_s":60,"purpose":"Button gag, then a loop line that hands back to frame one.","render_route_hint":"character_beat","loop_line":true}],"structure_variants":[{"id":"lesson","shape":"A senior teaches Pip; Pip finds the flaw."},{"id":"diary","shape":"Pip''s diary entry framing; flashbacks are the beats."},{"id":"test_day","shape":"Pip sits an exam; each question is a beat."},{"id":"shadowing","shape":"Pip shadows a desk for a day; three tasks are the beats."}],"ending_types":["loop_back","cliffhanger_memo","reversal","callback_gag","deadpan_fact","form_stamped"],"premise_types":["orientation","first_assignment","mistake_and_fix","mentorship","rivalry","promotion_test"],"desks":["intern_pool","gravity","time_calendars","archive","myth","optics","biology"],"music_bed_pool":["bed_typewriter_shuffle","bed_fluorescent_hum","bed_filing_cabinet_waltz","bed_tape_deck_noir","bed_lamp_buzz_minimal","bed_archive_harpsichord","bed_deep_sonar","bed_lantern_strings","bed_chalk_percussion","bed_overtime_jazz"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","serialised":true,"comment_sourced":false,"money_shot_allowed":true,"rules":["Every episode carries season and episode numbers.","Continuity: a fact learned in an earlier episode is never contradicted."]}}'::jsonb, '{"version":1,"summary":"Bureau of Reality content policy. policy_lint applies the deterministic rules below; anything it cannot decide is flagged for the judge model and, failing that, for Sahil. A flag is never a silent pass.","required":{"sourced_facts_exactly":1,"fact_source_classes":["gov","edu","space_agency","met_ocean_agency","museum","peer_reviewed","standards_body"],"script_max_words":150,"punchlines":3,"titles":3,"titles_distinct_hook_archetypes":true},"hook_archetypes":["question","contradiction","number_claim","warning","story_open","direct_address","demonstration"],"reject_categories":[{"id":"finance_advice","why":"Finance hosts and advice are a named 2026 enforcement pattern and outside the channel''s remit.","patterns":["\\b(invest|investing|stock tip|buy the dip|crypto|bitcoin|portfolio|returns? of \\d+%|get rich|passive income|trading strategy)\\b"]},{"id":"health_advice","why":"Health advice from a generated character is a liability and a named enforcement pattern.","patterns":["\\b(cure|treat(s|ment)? for|dosage|you should (take|stop taking)|supplement|detox|lose weight|diagnos(e|is)|medical advice)\\b"]},{"id":"politics","why":"No politics or elections.","patterns":["\\b(election|vote for|ballot|campaign|democrat|republican|BJP|Congress party|parliament(ary)? candidate|prime minister|president (trump|biden|modi)|left[- ]wing|right[- ]wing)\\b"]},{"id":"real_living_people","why":"No real living people. Historical figures are allowed only as part of a sourced fact.","patterns":["\\b(elon musk|taylor swift|mr ?beast|modi|trump|biden|zuckerberg|bezos|ronaldo|messi|shah rukh|virat kohli)\\b"],"judge":"Any proper name not on the cast list that could be a living person."},{"id":"franchise_or_brand","why":"No borrowed IP and no brands.","patterns":["\\b(marvel|disney|pixar|star wars|harry potter|pok[eé]mon|minecraft|fortnite|gta|nintendo|coca[- ]cola|pepsi|apple iphone|samsung|nike|mcdonald''?s|netflix)\\b"]},{"id":"true_crime","why":"The Archive covers history mysteries, never crimes against victims as entertainment.","patterns":["\\b(murder(ed|er)?|serial killer|homicide|kidnapp(ed|ing)|cold case|crime scene|victim''?s body|true crime)\\b"]},{"id":"devotional_framing","why":"Myth Desk is comparative and interpretive, never devotional.","patterns":["\\b(pray to|worship|blessings? of|the one true|lord .* will|chant this|miracle cure|sin(ful)? to)\\b"],"judge":"Statements that assert a religious claim as true rather than reporting what a tradition says."},{"id":"kid_coded","why":"Adult office satire; kids-coded AI content is the most scrutinised category.","patterns":["\\b(kids|children|toddler|nursery|bedtime story|abc|learn your colou?rs|baby shark|for little ones|preschool|cocomelon)\\b"],"styling_fields":["music_bed","shot_list.style"]}],"myth_interpretation_markers":["is said to","one popular reading","is often interpreted","tradition holds","according to"],"realistic_scene_disclosure":"containsSyntheticMedia is true only when a money shot depicts a realistic scene (photoreal ocean, space, fireworks). Chalk-line animation alone is not realistic altered content."}'::jsonb, '{"subreddits":["askscience","space","explainlikeimfive","todayilearned","Physics"],"youtube":{"region_code":"IN","category_ids":["28","27"],"queries":["how does it work science","physics explained"]}}'::jsonb, 1, 'import:channels/bureau-of-reality'
 where (select id from channels where slug = 'bureau-of-reality') is not null
on conflict (channel_id) do nothing;

insert into channel_characters (channel_id, slug, name, role, desk, on_screen, season_introduced, personality, accent_hex, voice, voice_brief, visual_lock, catchphrase, speech_rules, never_do, reference_frame, sort, active)
select (select id from channels where slug = 'bureau-of-reality'), v.* from (values
  ('pip', 'Pip', 'New intern; audience surrogate', 'intern_pool', true, 1, 'Bright, fast, curious, slightly reckless. Asks the question the viewer is thinking. Breaks things by being helpful.', '#22D3EE', '{"provider":"runway","preset_id":"Chad","direct_voice_id":null}'::jsonb, 'Bright, fast, curious young adult; not childlike.', '{"line":"white chalk line, cyan accent","props":["cyan scarf line","oversized lanyard"],"head_body_ratio":"1:3","line_weight":"medium","silhouette":"slight forward lean; lanyard swings past the knees"}'::jsonb, '{"text":"I read the manual. Most of it.","max_per_week":1}'::jsonb, '["Short sentences, quick rhythm; questions more than statements.","Never explains the mechanism alone — gets corrected or finishes someone else''s line.","No baby talk, no ''yay'', no exclamation stacks."]'::jsonb, '["Never shown as a child or in a classroom.","Never wins an argument with Mrs. Iyer.","Never loses the lanyard."]'::jsonb, '["PLACEHOLDER_PIP_REF_1"]'::jsonb, 0, true),
  ('marlo', 'Marlo', '400-year veteran of the Gravity Desk', 'gravity', true, 1, 'Deadpan, unhurried, has seen every incident twice. Loves procedure because procedure is what stops planets falling.', '#F59E0B', '{"provider":"runway","preset_id":"Clint","direct_voice_id":null}'::jsonb, 'Deadpan baritone, dry.', '{"line":"white chalk line, amber accent","props":["floating coffee mug that orbits him slowly"],"head_body_ratio":"1:3.5","line_weight":"heavy","silhouette":"tall, stooped, hands behind back"}'::jsonb, '{"text":"File it under ''falling''.","max_per_week":1}'::jsonb, '["Deadpan baritone; understatement over volume.","Uses exact numbers when he has them and says ''roughly'' when he does not.","Delivers the mechanism; jokes only by implication."]'::jsonb, '["Never runs.","Never panics on screen.","The mug never touches a surface."]'::jsonb, '["PLACEHOLDER_MARLO_REF_1"]'::jsonb, 1, true),
  ('iyer', 'Mrs. Iyer', 'Head of Time & Calendars', 'time_calendars', true, 1, 'Crisp, exacting, dry wit. Has opinions about leap seconds. Owns every festival and calendar episode.', '#E0409C', '{"provider":"runway","preset_id":null,"direct_voice_id":null}'::jsonb, 'Crisp Indian-English, dry wit, warm underneath.', '{"line":"white chalk line, magenta accent","props":["reading glasses on a chain","steel filter-coffee tumbler and davara"],"head_body_ratio":"1:3","line_weight":"medium","silhouette":"upright; glasses pushed up to correct someone"}'::jsonb, '{"text":"That is not what the calendar says.","max_per_week":1}'::jsonb, '["Crisp Indian-English register; precise dates and units.","Corrects others in one line, never a lecture.","Respectful about every culture''s calendar; explains, never ranks."]'::jsonb, '["Never a caricature or accent joke.","Never wrong about a date.","Never without the tumbler on her desk."]'::jsonb, '["PLACEHOLDER_IYER_REF_1"]'::jsonb, 2, true),
  ('nib', 'Nib', 'Archivist', 'archive', true, 1, 'Whispery, conspiratorial, delighted by unsolved files. Separates evidence from legend scrupulously.', '#9CA3AF', '{"provider":"runway","preset_id":null,"direct_voice_id":null}'::jsonb, 'Whispery, conspiratorial, playful.', '{"line":"graphite-grey line","props":["pencil-shaped body with eraser hat","case-file folder"],"head_body_ratio":"1:4","line_weight":"fine","silhouette":"thin, sharpened point at the feet"}'::jsonb, '{"text":"Case reopened.","max_per_week":1}'::jsonb, '["Whispers; leans into the camera.","Labels every claim: ''the record says'', ''the legend says'', ''the best current explanation is''.","No true crime, no gore, no living people."]'::jsonb, '["Never treats a crime as entertainment.","Never states legend as fact.","Never gets sharpened on screen."]'::jsonb, '["PLACEHOLDER_NIB_REF_1"]'::jsonb, 3, true),
  ('kaz', 'Kaz', 'Myth Desk liaison', 'myth', true, 1, 'Warm storyteller; compares how cultures told the same idea. Respectful, curious, never devotional.', '#FDBA4D', '{"provider":"runway","preset_id":null,"direct_voice_id":null}'::jsonb, 'Warm storyteller, unhurried.', '{"line":"white chalk line; lantern for a head","props":["lantern head whose glow changes colour by culture discussed"],"head_body_ratio":"1:3","line_weight":"medium","silhouette":"lantern ring on top; glow halo"}'::jsonb, '{"text":"Every culture had a word for this.","max_per_week":1}'::jsonb, '["Warm, measured storytelling cadence.","Interpretations are labelled: ''is said to mean'', ''one popular reading is''.","Compares at least two cultures; never ranks them; never preaches."]'::jsonb, '["Never devotional framing.","Never mocks a belief.","Never depicts deities as characters."]'::jsonb, '["PLACEHOLDER_KAZ_REF_1"]'::jsonb, 4, true),
  ('ohm', 'Director Ohm', 'Never-seen head of the Bureau', 'directorate', false, 1, 'Speaks only in memos; raises the stakes; never explains why.', '#C9A227', '{"provider":"runway","preset_id":"Marlene","direct_voice_id":null}'::jsonb, 'Filtered, formal memo voice.', '{"line":"a humming brass desk lamp — the only visible presence","props":["brass desk lamp that flickers when speaking"],"head_body_ratio":"n/a","line_weight":"medium","silhouette":"lamp only; never a body"}'::jsonb, '{"text":"This will be noted.","max_per_week":1}'::jsonb, '["Filtered memo voice; one or two lines per episode at most.","Always formal; always slightly ominous."]'::jsonb, '["Never seen.","Never jokes.","Never named by first name."]'::jsonb, '["PLACEHOLDER_OHM_REF_1"]'::jsonb, 5, true),
  ('complaint_box', 'Complaint Box', 'Reads real viewer comments on Sundays', 'complaints', true, 1, 'Gravelly, put-upon, secretly loves the questions.', '#B7793F', '{"provider":"runway","preset_id":null,"direct_voice_id":null}'::jsonb, 'Gravelly, weary, fond.', '{"line":"white chalk line, wood-brown accent","props":["talking wooden suggestion box; the slot is the mouth"],"head_body_ratio":"n/a","line_weight":"medium","silhouette":"box on a short post"}'::jsonb, '{"text":"Another one in the slot.","max_per_week":1}'::jsonb, '["Gravelly; reads the comment verbatim, credits the handle only if the comment is public.","Hands the question to the right desk; never answers it alone."]'::jsonb, '["Never reads a private comment.","Never mocks the viewer."]'::jsonb, '["PLACEHOLDER_COMPLAINT_BOX_REF_1"]'::jsonb, 6, true),
  ('auditor', 'The Auditor', 'Season 2 antagonist (from 06-Jan)', 'audit', true, 2, 'Clipped, corporate, believes reality is over budget.', '#EF4444', '{"provider":"runway","preset_id":null,"direct_voice_id":null}'::jsonb, 'Clipped, corporate.', '{"line":"white chalk line, red accent","props":["clipboard"],"head_body_ratio":"1:3.5","line_weight":"medium","silhouette":"rigid posture, clipboard at chest"}'::jsonb, '{"text":"And who signed off on gravity?","max_per_week":1}'::jsonb, '["Clipped corporate jargon; KPIs about physics.","Never shouts; always taking notes."]'::jsonb, '["Never appears before Season 2.","Never resembles a real executive or politician."]'::jsonb, '["PLACEHOLDER_AUDITOR_REF_1"]'::jsonb, 7, true)
) as v(slug, name, role, desk, on_screen, season_introduced, personality, accent_hex, voice, voice_brief, visual_lock, catchphrase, speech_rules, never_do, reference_frame, sort, active)
 where (select id from channels where slug = 'bureau-of-reality') is not null
on conflict (channel_id, slug) do nothing;

-- Voices chosen on the Voices screen (0046) become the cast's own voice; the override rows go.
-- Only an override the router would accept is folded (a known preset, or a direct voice id).
update channel_characters cc
   set voice = case when o.voice_provider = 'runway'
                    then jsonb_build_object('provider', 'runway', 'preset_id', o.voice_id, 'direct_voice_id', cc.voice->'direct_voice_id')
                    else jsonb_build_object('provider', o.voice_provider, 'preset_id', cc.voice->'preset_id', 'direct_voice_id', o.voice_id) end,
       updated_at = now()
  from channel_voice_overrides o
 where o.channel_id = (select id from channels where slug = 'bureau-of-reality') and cc.channel_id = o.channel_id and cc.slug = o.character_slug
   and ((o.voice_provider = 'runway' and o.voice_id in ('Maya', 'Arjun', 'Serene', 'Bernard', 'Billy', 'Mark', 'Clint', 'Mabel', 'Chad', 'Leslie', 'Eleanor', 'Elias', 'Elliot', 'Grungle', 'Brodie', 'Sandra', 'Kirk', 'Kylie', 'Lara', 'Lisa', 'Malachi', 'Marlene', 'Martin', 'Miriam', 'Monster', 'Paula', 'Pip', 'Rusty', 'Ragnar', 'Xylar', 'Maggie', 'Jack', 'Katie', 'Noah', 'James', 'Rina', 'Ella', 'Mariah', 'Frank', 'Claudia', 'Niki', 'Vincent', 'Kendrick', 'Myrna', 'Tom', 'Wanda', 'Benjamin', 'Kiana', 'Rachel')) or (o.voice_provider = 'elevenlabs' and length(trim(o.voice_id)) > 0));

delete from channel_voice_overrides o
 where o.channel_id = (select id from channels where slug = 'bureau-of-reality')
   and ((o.voice_provider = 'runway' and o.voice_id in ('Maya', 'Arjun', 'Serene', 'Bernard', 'Billy', 'Mark', 'Clint', 'Mabel', 'Chad', 'Leslie', 'Eleanor', 'Elias', 'Elliot', 'Grungle', 'Brodie', 'Sandra', 'Kirk', 'Kylie', 'Lara', 'Lisa', 'Malachi', 'Marlene', 'Martin', 'Miriam', 'Monster', 'Paula', 'Pip', 'Rusty', 'Ragnar', 'Xylar', 'Maggie', 'Jack', 'Katie', 'Noah', 'James', 'Rina', 'Ella', 'Mariah', 'Frank', 'Claudia', 'Niki', 'Vincent', 'Kendrick', 'Myrna', 'Tom', 'Wanda', 'Benjamin', 'Kiana', 'Rachel')) or (o.voice_provider = 'elevenlabs' and length(trim(o.voice_id)) > 0))
   and exists (select 1 from channel_characters cc where cc.channel_id = o.channel_id and cc.slug = o.character_slug);

do $kiln_import$
begin
  if (select id from channels where slug = 'bureau-of-reality') is null then
    raise exception 'No channel with slug bureau-of-reality: the bible import has nothing to attach to. Nothing in this file has been applied.';
  end if;
  if (select count(*) from channel_characters where channel_id = (select id from channels where slug = 'bureau-of-reality')) < 8 then
    raise exception 'The bureau-of-reality cast did not import completely. Nothing in this file has been applied.';
  end if;
end
$kiln_import$;

-- ════════════════════════════════════════════════════════════════════════════
commit;

-- ── Tell PostgREST the schema changed ───────────────────────────────────────
--
-- Outside the transaction, and not optional.
--
-- Supabase serves the app through PostgREST, which caches the schema in memory. The CLI
-- reloads that cache after a push; pasting SQL into the editor does not. So every table,
-- view and function this file created exists in the database and is invisible to the app
-- until this fires — and the error you get is "Could not find the table 'public.X' in the
-- schema cache", which reads exactly like the migration never ran.
--
-- That sentence cost an evening. It is in the file now so it cannot be forgotten.
notify pgrst, 'reload schema';

-- Confirm from the editor:
--   select version, name from supabase_migrations.schema_migrations order by version;
--   select slug, kind, is_enabled from integrations order by slug;
