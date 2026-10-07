-- Kiln — migrations 0052 to 0052, bundled for the Supabase SQL editor.
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
-- Migrations included (1):
--   0052  engineered_explainer

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
  where version in ('0052');

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;

-- ════════════════════════════════════════════════════════════════════════════
-- 0052_engineered_explainer.sql
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_progress$ begin raise notice 'applying 0052 engineered_explainer'; end $kiln_progress$;

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

insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0052', 'engineered_explainer', array[$kiln_0052$-- 0052 — The "3D explainer" video type (engineered), and the series of a second channel.
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
$kiln_0052$])
on conflict (version) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- Built Like That (@BuiltLikeThat) — the channel, made by createChannel (scripts/channel-sql.mjs)
-- GENERATED. Do not edit; regenerate with: node scripts/channel-sql.mjs <db-url> <out.sql>
--
--   · the channel row, its policy (caps as the Bureau's: ₹150 / ₹600 / ₹15,000; drawn-share
--     floor 25%), both publish targets recorded OFF with no account id
--   · its bible from channels/built-like-that/ (one off-screen narrator; series "Every Attempt
--     Failed" and "The Machine Inside", both defaulting to the 3D explainer, key motion, brisk)
--   · 20 bank topics (B17–B36, undated: nothing is drafted until one is dated)
--   · the picture-clip recipe 0052 seeded retired, ACTIVATED (the last statement)
-- ════════════════════════════════════════════════════════════════════════════

do $kiln_channel$
begin
  if exists (select 1 from channels where slug = 'built-like-that') then
    raise exception 'Already applied: a channel with slug built-like-that exists. Nothing in this file has been run and the transaction is rolling back.';
  end if;
end
$kiln_channel$;

-- channels: 1 row(s)
insert into channels ("id", "name", "platform", "niche", "handle", "external_id", "token_expires_at", "is_active", "created_at", "host_voice_id", "voice_language", "token_last_refreshed_at", "token_refresh_error", "token_refresh_failures", "slug")
select "id", "name", "platform", "niche", "handle", "external_id", "token_expires_at", "is_active", "created_at", "host_voice_id", "voice_language", "token_last_refreshed_at", "token_refresh_error", "token_refresh_failures", "slug" from jsonb_populate_recordset(null::channels, $kiln$[{"id":"97f96398-b570-438c-a953-ee7a88ef87ca","name":"Built Like That","platform":"youtube","niche":"How everyday engineering works and why it is built that way","handle":"@BuiltLikeThat","external_id":null,"token_expires_at":null,"is_active":true,"created_at":"2026-10-07T19:52:30.102Z","host_voice_id":null,"voice_language":"en","token_last_refreshed_at":null,"token_refresh_error":null,"token_refresh_failures":0,"slug":"built-like-that"}]$kiln$::jsonb);

-- channel_policy: 1 row(s)
insert into channel_policy ("channel_id", "per_short_cap_inr", "daily_cap_inr", "daily_longform_cap_inr", "monthly_cap_inr", "monthly_cap_after_gate2_inr", "gate2_passed_at", "daily_publish_cap", "default_slot_time", "slot_timezone", "kill_switch", "kill_switch_reason", "kill_switch_at", "youtube_api_audited", "instagram_publish_enabled", "variation_window", "variation_min_axes", "similarity_window", "similarity_max", "hook_archetype_weekly_max", "catchphrase_weekly_max", "overlay_min_share", "character_beat_max_s", "money_shot_max", "rerolls_max", "updated_at", "updated_by", "stills_enabled", "seconds_per_picture", "max_pictures_per_shot", "line_gap_s", "tail_s", "loudness_target_lufs", "caption_scale", "hook_scale", "hook_s", "made_for_kids_default", "synthetic_disclosure", "relevance_threshold", "voice_overflow")
select "channel_id", "per_short_cap_inr", "daily_cap_inr", "daily_longform_cap_inr", "monthly_cap_inr", "monthly_cap_after_gate2_inr", "gate2_passed_at", "daily_publish_cap", "default_slot_time", "slot_timezone", "kill_switch", "kill_switch_reason", "kill_switch_at", "youtube_api_audited", "instagram_publish_enabled", "variation_window", "variation_min_axes", "similarity_window", "similarity_max", "hook_archetype_weekly_max", "catchphrase_weekly_max", "overlay_min_share", "character_beat_max_s", "money_shot_max", "rerolls_max", "updated_at", "updated_by", "stills_enabled", "seconds_per_picture", "max_pictures_per_shot", "line_gap_s", "tail_s", "loudness_target_lufs", "caption_scale", "hook_scale", "hook_s", "made_for_kids_default", "synthetic_disclosure", "relevance_threshold", "voice_overflow" from jsonb_populate_recordset(null::channel_policy, $kiln$[{"channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","per_short_cap_inr":"150","daily_cap_inr":"600","daily_longform_cap_inr":"1500","monthly_cap_inr":"15000","monthly_cap_after_gate2_inr":"25000","gate2_passed_at":null,"daily_publish_cap":1,"default_slot_time":"18:00:00","slot_timezone":"Asia/Kolkata","kill_switch":false,"kill_switch_reason":null,"kill_switch_at":null,"youtube_api_audited":false,"instagram_publish_enabled":false,"variation_window":14,"variation_min_axes":4,"similarity_window":60,"similarity_max":"0.85","hook_archetype_weekly_max":2,"catchphrase_weekly_max":1,"overlay_min_share":"0.25","character_beat_max_s":"8","money_shot_max":1,"rerolls_max":2,"updated_at":"2026-10-07T19:52:30.105Z","updated_by":null,"stills_enabled":true,"seconds_per_picture":"6","max_pictures_per_shot":4,"line_gap_s":"0.18","tail_s":"0.6","loudness_target_lufs":"-14","caption_scale":"0.032","hook_scale":"0.05","hook_s":"2","made_for_kids_default":false,"synthetic_disclosure":"auto","relevance_threshold":"0.65","voice_overflow":false}]$kiln$::jsonb);

-- channel_publish_targets: 2 row(s)
insert into channel_publish_targets ("channel_id", "platform", "enabled", "handle", "external_id", "created_at")
select "channel_id", "platform", "enabled", "handle", "external_id", "created_at" from jsonb_populate_recordset(null::channel_publish_targets, $kiln$[{"channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","platform":"youtube","enabled":false,"handle":"@BuiltLikeThat","external_id":null,"created_at":"2026-10-07T19:52:30.110Z"},{"channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","platform":"instagram","enabled":false,"handle":"@BuiltLikeThat","external_id":null,"created_at":"2026-10-07T19:52:30.110Z"}]$kiln$::jsonb);

-- channel_bibles: 1 row(s)
insert into channel_bibles ("channel_id", "world", "publishing", "series", "policy", "trend_sources", "version", "updated_at", "updated_by")
select "channel_id", "world", "publishing", "series", "policy", "trend_sources", "version", "updated_at", "updated_by" from jsonb_populate_recordset(null::channel_bibles, $kiln$[{"channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","world":{"name":"Built Like That","palette":{"grid":"#22324D","chalk":"#F2F4F7","paper":"#0E1726"},"premise":"How everyday engineering works and why it is built that way","still_style":"Clean photoreal 3D render, studio CG rather than a photograph: white test objects with yellow-and-black target decals, spotless studio-clean surfaces, soft even daylight, gentle contact shadows, crisp detail.","style_rules":["Clean photoreal 3D renders of real engineered objects: studio-clean, soft daylight, white test objects with yellow-and-black target decals; dark navy lab backdrop for cutaways.","Every label, number and verdict is a graphic drawn by the editor, never painted into a picture.","No brands, no logos, no real living people, no franchise designs.","Adult and precise, never kid-coded: no toys, no nursery colours, no classroom framing."],"negative_prompt":"text, letters, numbers, labels, captions, logos, brand names, watermark, cartoon, line drawing, anime, human faces"},"publishing":{"tags":["how it works","engineering","explained","3D animation","design history"],"category":"Science & Technology","hashtags":["engineering","howitworks","BuiltLikeThat","science","design"]},"series":{"inside":{"id":"inside","day":"Fri","lead":["narrator"],"name":"The Machine Inside","desks":["vehicles","buildings","rail","household","electrical","safety"],"rules":["The hidden part is the hero object; it stays the same object in every picture.","Numbers are sourced or hedged; the part is named, never the brand.","Never copy another video's script, topic order or wording."],"motion":"key","template":"The everyday object → what would go wrong without it → the rule → the attempts at the hidden part → the part that works, opened up step by step → loop back","runtime_s":{"max":55,"min":38,"target":45},"beat_sheet":[{"id":"hook","end_s":3,"purpose":"The danger, in the second person, shown as a see-through or dramatic scene.","start_s":0,"loop_anchor":true},{"id":"question","end_s":6,"purpose":"The plain question the viewer now has.","start_s":3},{"id":"rule","end_s":10,"purpose":"The one physical rule that makes the problem hard, with a callout on the key part.","start_s":6},{"id":"attempts","end_s":30,"purpose":"Numbered attempts, each with a badge and a verdict; each fails in a new way until the last.","start_s":10},{"id":"mechanism","end_s":42,"purpose":"The design that worked, step by step in cutaways, with one or two hedged figures on meters.","start_s":30},{"id":"loop","end_s":45,"purpose":"A last line that returns to the opening picture.","start_s":42,"loop_line":true}],"serialised":false,"voice_pace":"brisk","ending_types":["loop_back","quiet_reveal","callback_to_hook"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","premise_types":["hidden_failsafe","why_this_part","what_happens_in_one_second"],"visual_format":"engineered","music_bed_pool":["bed_workshop_pulse","bed_clean_synth_tick","bed_lab_drone_minimal","bed_steel_percussion","bed_bright_pluck_motion"],"comment_sourced":false,"money_shot_allowed":false,"structure_variants":[{"id":"inside_open_up","shape":"Start outside the object and open it layer by layer to the hidden part."},{"id":"inside_without_it","shape":"Show the object with the part removed, then the attempts to put something in its place."},{"id":"inside_one_second","shape":"Slow one second of the object working, attempt by attempt, until the real part does it."}]},"evolution":{"id":"evolution","day":"Tue","lead":["narrator"],"name":"Every Attempt Failed","desks":["vehicles","buildings","rail","household","electrical","safety"],"rules":["Every attempt fails in a NEW way; the last one works.","Numbers are sourced or hedged; the part is named, never the brand.","Never copy another video's script, topic order or wording."],"motion":"key","template":"The danger → the question → the rule that makes it hard → numbered attempts, each failing in a new way → the one that worked, step by step → loop back","runtime_s":{"max":55,"min":38,"target":45},"beat_sheet":[{"id":"hook","end_s":3,"purpose":"The danger, in the second person, shown as a see-through or dramatic scene.","start_s":0,"loop_anchor":true},{"id":"question","end_s":6,"purpose":"The plain question the viewer now has.","start_s":3},{"id":"rule","end_s":10,"purpose":"The one physical rule that makes the problem hard, with a callout on the key part.","start_s":6},{"id":"attempts","end_s":30,"purpose":"Numbered attempts, each with a badge and a verdict; each fails in a new way until the last.","start_s":10},{"id":"mechanism","end_s":42,"purpose":"The design that worked, step by step in cutaways, with one or two hedged figures on meters.","start_s":30},{"id":"loop","end_s":45,"purpose":"A last line that returns to the opening picture.","start_s":42,"loop_line":true}],"serialised":false,"voice_pace":"brisk","ending_types":["loop_back","quiet_reveal","callback_to_hook"],"music_policy":"Original beds only, rendered in-house or generated with commercial rights. No licensed or library music.","premise_types":["why_this_shape","what_went_wrong_first","the_hidden_failsafe"],"visual_format":"engineered","music_bed_pool":["bed_workshop_pulse","bed_clean_synth_tick","bed_lab_drone_minimal","bed_steel_percussion","bed_bright_pluck_motion"],"comment_sourced":false,"money_shot_allowed":false,"structure_variants":[{"id":"evolution_chronological","shape":"Attempts in the order history tried them, oldest first."},{"id":"evolution_by_failure","shape":"Attempts grouped by how they failed: each new failure teaches the next fix."},{"id":"evolution_near_miss","shape":"Open on the attempt that almost worked, rewind to the first, then forward to the answer."}]}},"policy":{"summary":"Built Like That content policy. policy_lint applies the deterministic rules below (and, for 3D explainers, that every number is sourced or hedged); anything it cannot decide is flagged for the judge model and, failing that, for Sahil. A flag is never a silent pass.","version":1,"required":{"titles":3,"punchlines":3,"script_max_words":150,"fact_source_classes":["gov","edu","space_agency","met_ocean_agency","museum","peer_reviewed","standards_body"],"sourced_facts_exactly":1,"titles_distinct_hook_archetypes":true},"hook_archetypes":["question","contradiction","number_claim","warning","story_open","direct_address","demonstration"],"reject_categories":[{"id":"finance_advice","why":"Finance hosts and advice are a named 2026 enforcement pattern and outside the channel's remit.","patterns":["\\b(invest|investing|stock tip|buy the dip|crypto|bitcoin|portfolio|returns? of \\d+%|get rich|passive income|trading strategy)\\b"]},{"id":"health_advice","why":"Health advice from a generated character is a liability and a named enforcement pattern.","patterns":["\\b(cure|treat(s|ment)? for|dosage|you should (take|stop taking)|supplement|detox|lose weight|diagnos(e|is)|medical advice)\\b"]},{"id":"politics","why":"No politics or elections.","patterns":["\\b(election|vote for|ballot|campaign|democrat|republican|BJP|Congress party|parliament(ary)? candidate|prime minister|president (trump|biden|modi)|left[- ]wing|right[- ]wing)\\b"]},{"id":"real_living_people","why":"No real living people. Historical figures are allowed only as part of a sourced fact.","judge":"Any proper name not on the cast list that could be a living person.","patterns":["\\b(elon musk|taylor swift|mr ?beast|modi|trump|biden|zuckerberg|bezos|ronaldo|messi|shah rukh|virat kohli)\\b"]},{"id":"franchise_or_brand","why":"No borrowed IP and no brands: the part is named, never the maker.","patterns":["\\b(marvel|disney|pixar|star wars|harry potter|pok[eé]mon|minecraft|fortnite|gta|nintendo|coca[- ]cola|pepsi|apple iphone|samsung|nike|mcdonald'?s|netflix)\\b"]},{"id":"kid_coded","why":"An engineering channel for adults; kids-coded AI content is the most scrutinised category.","patterns":["\\b(kids|children|toddler|nursery|bedtime story|abc|learn your colou?rs|baby shark|for little ones|preschool|cocomelon)\\b"],"styling_fields":["music_bed","shot_list.style"]}],"realistic_scene_disclosure":"Every 3D explainer is photoreal CG of real objects, so containsSyntheticMedia is set on every upload of this channel (Settings → Publishing, auto).","myth_interpretation_markers":["is said to","one popular reading","is often interpreted","tradition holds","according to"]},"trend_sources":{"hn":{"top_n":30},"youtube":{"queries":["how it works engineering","engineering explained","how is it made machine","why is it designed this way"],"region_code":"IN","category_ids":["28"]},"wikipedia":{"top_n":50,"languages":["en"]},"subreddits":[],"google_trends":null},"version":1,"updated_at":"2026-10-07T19:52:30.112Z","updated_by":"bundle:channel-sql"}]$kiln$::jsonb);

-- channel_characters: 1 row(s)
insert into channel_characters ("id", "channel_id", "slug", "name", "role", "desk", "on_screen", "season_introduced", "personality", "accent_hex", "voice", "voice_brief", "visual_lock", "catchphrase", "speech_rules", "never_do", "reference_frame", "sort", "active", "updated_at")
select "id", "channel_id", "slug", "name", "role", "desk", "on_screen", "season_introduced", "personality", "accent_hex", "voice", "voice_brief", "visual_lock", "catchphrase", "speech_rules", "never_do", "reference_frame", "sort", "active", "updated_at" from jsonb_populate_recordset(null::channel_characters, $kiln$[{"id":"3b44a061-20f4-4ffc-bb3d-7ed21eed2883","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","slug":"narrator","name":"Narrator","role":"the off-screen narrator","desk":"main","on_screen":false,"season_introduced":1,"personality":"Brisk, curious and a little dry; talks to the viewer as someone who would have made the same mistake as the first engineer.","accent_hex":"#FFD23F","voice":{"provider":"runway","preset_id":"James","direct_voice_id":null},"voice_brief":"A clear, brisk, warm male explainer voice; confident, never shouty, never sing-song.","visual_lock":{"line":"never drawn — an off-screen voice","props":[],"silhouette":"never drawn — an off-screen voice","line_weight":"n/a","head_body_ratio":"n/a"},"catchphrase":{"text":"Built like that.","max_per_week":1},"speech_rules":["Short lines, one idea each; second person where it fits.","Every measured number is a numeral and hedged unless it is the sourced fact's own figure.","Names the part, never the brand."],"never_do":["Appears on screen.","Names a brand or a living person."],"reference_frame":[],"sort":0,"active":true,"updated_at":"2026-10-07T19:52:30.116Z"}]$kiln$::jsonb);

-- characters: 1 row(s)
insert into characters ("id", "name", "driver", "external_ref_id", "reference_urls", "notes", "created_at", "channel_id", "slug", "role", "accent_hex", "voice_id", "on_screen", "season_introduced", "bible", "synced_at")
select "id", "name", "driver", "external_ref_id", "reference_urls", "notes", "created_at", "channel_id", "slug", "role", "accent_hex", "voice_id", "on_screen", "season_introduced", "bible", "synced_at" from jsonb_populate_recordset(null::characters, $kiln$[{"id":"0ca1eed2-1d56-4225-a07b-5f265953a961","name":"Narrator","driver":null,"external_ref_id":null,"reference_urls":[],"notes":"Brisk, curious and a little dry; talks to the viewer as someone who would have made the same mistake as the first engineer.","created_at":"2026-10-07T19:52:30.124Z","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","slug":"narrator","role":"the off-screen narrator","accent_hex":"#FFD23F","voice_id":"runway:James","on_screen":false,"season_introduced":1,"bible":{"id":"narrator","desk":"main","name":"Narrator","role":"the off-screen narrator","voice":{"provider":"runway","preset_id":"James"},"never_do":["Appears on screen.","Names a brand or a living person."],"on_screen":false,"accent_hex":"#FFD23F","catchphrase":{"text":"Built like that.","max_per_week":1},"personality":"Brisk, curious and a little dry; talks to the viewer as someone who would have made the same mistake as the first engineer.","visual_lock":{"line":"never drawn — an off-screen voice","props":[],"silhouette":"never drawn — an off-screen voice","line_weight":"n/a","head_body_ratio":"n/a"},"voice_brief":"A clear, brisk, warm male explainer voice; confident, never shouty, never sing-song.","speech_rules":["Short lines, one idea each; second person where it fits.","Every measured number is a numeral and hedged unless it is the sourced fact's own figure.","Names the part, never the brand."],"season_introduced":1,"elevenlabs_voice_id":null,"reference_frame_ids":[]},"synced_at":"2026-10-07T19:52:30.121Z"}]$kiln$::jsonb);

-- slots: 20 row(s)
insert into slots ("id", "channel_id", "kind", "slot_date", "series", "series_name", "lead", "episode", "topic", "hook", "seasonal_tag", "topic_status", "notes", "created_at")
select "id", "channel_id", "kind", "slot_date", "series", "series_name", "lead", "episode", "topic", "hook", "seasonal_tag", "topic_status", "notes", "created_at" from jsonb_populate_recordset(null::slots, $kiln$[{"id":"B17","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Traffic lights: from a gas lamp that exploded to an LED that cannot burn out","hook":"The first traffic light blew up in a policeman's face.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.138Z"},{"id":"B18","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Airbags: why they do not just inflate harder","hook":"It hits your face faster than you can blink — on purpose.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.139Z"},{"id":"B19","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Seat belts: lap belt to three-point","hook":"The first seat belt held you in and broke you in half.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.140Z"},{"id":"B20","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Level crossing barriers: why they fail closed","hook":"Cut the power and the barrier comes down by itself.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.141Z"},{"id":"B21","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"Pressure cookers: the three ways it lets go","hook":"That whistle is the second safety valve. There is a third.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.142Z"},{"id":"B22","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Train couplers: link-and-pin to the knuckle","hook":"Two wagons roll together and you are standing between them.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.143Z"},{"id":"B23","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"Circuit breakers: the strip that bends and the coil that snaps","hook":"The switch in your fuse box trips in two different ways.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.143Z"},{"id":"B24","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"Toilet flush: siphon versus flapper","hook":"There is no pump in your toilet. Gravity does it all.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.144Z"},{"id":"B25","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"Escalator brakes: what stops the stairs when the power cuts","hook":"Kill the power mid-ride and the stairs do not roll back.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.145Z"},{"id":"B26","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Lift safety brakes: why a snapped cable does not drop the car","hook":"Cut the cable and the lift stops itself in the shaft.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.146Z"},{"id":"B27","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Crumple zones: why cars are built to crush","hook":"The stiffest car is the one that hurts you most.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.148Z"},{"id":"B28","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"Smoke alarms: two ways to smell a fire","hook":"One kind of smoke alarm sleeps through the fire you are most likely to have.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.148Z"},{"id":"B29","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Railway signals: why the default is red","hook":"A broken signal shows red. That is not an accident.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.149Z"},{"id":"B30","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"The fuse in a plug: the wire meant to melt","hook":"The weakest wire in your house is there on purpose.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.150Z"},{"id":"B31","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Fire sprinkler heads: the glass bulb","hook":"One sprinkler opens. Not all of them. Here is why.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.151Z"},{"id":"B32","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"Car brakes: why a liquid pushes harder than your foot","hook":"Your foot cannot stop a car. A little liquid can.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.151Z"},{"id":"B33","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Revolving doors: why they fold flat","hook":"Push hard enough and a revolving door collapses — on purpose.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.152Z"},{"id":"B34","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"The dead man's switch in a train cab","hook":"Let go of the handle and the train stops itself.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.152Z"},{"id":"B35","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"evolution","series_name":"Every Attempt Failed","lead":"narrator","episode":null,"topic":"Tyre treads: why grooves","hook":"A smooth tyre grips better — until it rains.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.153Z"},{"id":"B36","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","kind":"bank","slot_date":null,"series":"inside","series_name":"The Machine Inside","lead":"narrator","episode":null,"topic":"Lift doors: what stops them closing on you","hook":"Put your hand in the gap and the doors already know.","seasonal_tag":null,"topic_status":"bank","notes":"Built Like That seed (0052)","created_at":"2026-10-07T19:52:30.155Z"}]$kiln$::jsonb);

-- authorship_log: 1 row(s)
insert into authorship_log ("id", "occurred_at", "channel_id", "actor_scope", "token_id", "profile_id", "action", "subject_type", "subject_id", "exact_text", "payload")
select "id", "occurred_at", "channel_id", "actor_scope", "token_id", "profile_id", "action", "subject_type", "subject_id", "exact_text", "payload" from jsonb_populate_recordset(null::authorship_log, $kiln$[{"id":"4e7a20bc-4c15-4324-9df2-b19f53fbcd39","occurred_at":"2026-10-07T19:52:30.128Z","channel_id":"97f96398-b570-438c-a953-ee7a88ef87ca","actor_scope":"approver","token_id":null,"profile_id":null,"action":"channel_create","subject_type":"channel","subject_id":"97f96398-b570-438c-a953-ee7a88ef87ca","exact_text":null,"payload":{"slug":"built-like-that","targets":["youtube","instagram"],"template":"built-like-that","accent_hex":null}}]$kiln$::jsonb);

-- The 3D explainer's clips: one recipe, activated here rather than by the migration (0052).
-- Delete this statement before pasting if you would rather watch a clip first; until it runs,
-- both motion levels plan their clips as pictures and Approvals says so.
update prompts set is_active = true, retired_at = null, retired_reason = null
 where name = 'engineered-picture-clip-gen4-turbo' and version = 1;

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
