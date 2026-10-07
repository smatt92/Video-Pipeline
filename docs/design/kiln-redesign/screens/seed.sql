-- Screenshot fixture for docs/design/kiln-redesign/screens/ — a LOCAL scratch database only.
-- Never paste into the hosted project: these rows are invented so every screen has something
-- to show (pending briefs, an episode in each state, ledger rows, a bundle, an authorship
-- trail). Re-runnable: it deletes its own rows first (fixed ids, prefix 5eed).
--
--   psql postgresql://postgres@127.0.0.1:55432/postgres -f docs/design/kiln-redesign/screens/seed.sql

begin;

\set ch '''b0000000-0000-4000-8000-000000000001'''
\set me '''00000000-0000-4000-8000-0000000000aa'''

delete from publications where id::text like '5eed%';
delete from reviews where id::text like '5eed%';
delete from renders where id::text like '5eed%';
delete from episodes where id::text like '5eed%';
delete from scripts where id::text like '5eed%';
delete from concepts where id::text like '5eed%';
delete from briefs where id::text like '5eed%';
delete from cost_ledger where id::text like '5eed%';
delete from notifications where id::text like '5eed%';
delete from authorship_log where id::text like '5eed%';
delete from channel_policy where channel_id = '5eed0000-0000-4000-8000-00000000c002';
delete from channels where id = '5eed0000-0000-4000-8000-00000000c002';
delete from trend_signals where id::text like '5eed%';
delete from trend_runs where id::text like '5eed%';

insert into profiles (id, email, display_name, onboarding_seen_at)
values (:me, 'sahil.matt@gmail.com', 'Sahil', now())
on conflict (id) do update set display_name = 'Sahil', onboarding_seen_at = coalesce(profiles.onboarding_seen_at, now());

update channels set handle = '@BureauofReality' where id = :ch and handle is null;

-- A second channel with no bible yet, so All channels has two rows and the switcher a list.
insert into channels (id, name, platform, niche, handle, is_active, slug)
values ('5eed0000-0000-4000-8000-00000000c002', 'Kitchen Physics', 'youtube', 'science of cooking', '@KitchenPhysics', true, 'kitchen-physics');
insert into channel_policy (channel_id) values ('5eed0000-0000-4000-8000-00000000c002');

-- Briefs: two pending (Approvals), four approved (episodes below).
insert into briefs (id, channel_id, slot_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type,
  music_bed, hook_archetype, punchlines, beat_sheet, script_text, fact, titles, pinned_comment, created_by, estimate_inr, status,
  chosen_punchline, approved_at, variation, policy, created_at, season, episode)
values
 ('5eed0000-0000-4000-8000-0000000b0002', :ch, 'S002', 'desk_tour', 'marlo', 'chemistry', 'Why fireworks have colours — Marlo tours the metal-salt shelf and one jar is labelled "do not".', 'question', 'tour', 'button',
  'desk', 'question', '["Strontium is red because it has never once been calm.", "Copper goes blue-green; the Bureau has filed a complaint about the green.", "Sodium is yellow. Sodium is always yellow. We have stopped asking sodium."]',
  '[]', 'Marlo walks the shelf.', '{"claim":"Strontium salts burn red; copper salts burn blue-green.","source_url":"https://en.wikipedia.org/wiki/Flame_test"}',
  '["Why fireworks have colours","The shelf of colours","Do not open the green jar"]', 'Which colour should we file next?', 'agent', 38.90, 'pending',
  null, null, '{"status":"pass"}', '{"status":"pass"}', now() - interval '3 hours', null, null),
 ('5eed0000-0000-4000-8000-0000000b0006', :ch, 'S006', 'deep', 'iyer', 'physics', 'What would happen if you fell into Jupiter — Dr Iyer narrates the descent, layer by layer.', 'what_if', 'descent', 'reveal',
  'deep', 'warning', '["You would never hit the ground. Jupiter does not have one.", "At 1,000 km down the air is thicker than water and twice as rude.", "The Bureau recommends against it, in writing."]',
  '[]', 'Dr Iyer narrates the fall.', '{"claim":"Jupiter has no solid surface; pressure rises with depth until hydrogen becomes metallic.","source_url":"https://science.nasa.gov/jupiter/"}',
  '["Falling into Jupiter","There is no ground","The descent"]', 'How far would you get?', 'agent', null, 'pending',
  null, null, '{"status":"pass"}', '{"status":"flag"}', now() - interval '1 hour', null, null),
 ('5eed0000-0000-4000-8000-0000000b0001', :ch, 'S001', 'incident', 'pip', 'astronomy', 'What if the Moon vanished — Pip files an incident report as the tides go quiet.', 'what_if', 'incident', 'button',
  'incident', 'question', '["No Moon, no big tides.", "The night shift would like a word.", "Pip has filed the paperwork; the Moon has not responded."]',
  '[]', 'Pip files the report.', '{"claim":"The Moon drives most of Earth''s tides.","source_url":"https://oceanservice.noaa.gov/facts/moon-tide.html"}',
  '["What if the Moon vanished","No Moon, no tides","Incident: Moon missing"]', 'What would you miss first?', 'agent', 40.12, 'approved',
  'No Moon, no big tides.', now() - interval '2 days', '{"status":"pass"}', '{"status":"pass"}', now() - interval '3 days', null, null),
 ('5eed0000-0000-4000-8000-0000000b0003', :ch, 'S003', 'pip', 'pip', 'physics', 'Orientation: what gravity actually is — Pip''s first day, and the floor keeps pulling.', 'explainer', 'orientation', 'button',
  'pip', 'direct_address', '["Gravity is the floor being clingy.", "Mass tells space how to curve; space tells Pip to sit down.", "Orientation complete. Please stop falling."]',
  '[]', 'Pip learns gravity.', '{"claim":"General relativity describes gravity as the curvature of spacetime by mass.","source_url":"https://en.wikipedia.org/wiki/General_relativity"}',
  '["What gravity actually is","Orientation: gravity","The clingy floor"]', 'Explain gravity in five words.', 'agent', 39.40, 'approved',
  'Gravity is the floor being clingy.', now() - interval '2 days', '{"status":"pass"}', '{"status":"pass"}', now() - interval '3 days', 1, 1),
 ('5eed0000-0000-4000-8000-0000000b0004', :ch, 'S004', 'archive', 'nib', 'history', 'The Dancing Plague of 1518 — Nib pulls the file from the archive and it will not stop tapping.', 'story', 'archive', 'button',
  'archive', 'story_open', '["The file is still tapping.", "Strasbourg, 1518: hundreds danced for weeks.", "Archived under: do not play music near this."]',
  '[]', 'Nib reads the file.', '{"claim":"In July 1518 hundreds of people in Strasbourg danced uncontrollably for weeks.","source_url":"https://en.wikipedia.org/wiki/Dancing_plague_of_1518"}',
  '["The Dancing Plague of 1518","The file that dances","Archive: 1518"]', 'Would you have danced?', 'agent', 41.00, 'approved',
  'The file is still tapping.', now() - interval '4 days', '{"status":"pass"}', '{"status":"pass"}', now() - interval '5 days', null, null),
 ('5eed0000-0000-4000-8000-0000000b0005', :ch, 'S005', 'myth', 'kaz', 'mythology', 'Ravana''s ten heads — Kaz sorts the popular interpretations into labelled boxes.', 'explainer', 'sort', 'button',
  'myth', 'number_claim', '["Ten heads, ten opinions, one Bureau form.", "Each head is a skill; the paperwork is a nightmare.", "Kaz ran out of boxes at head seven."]',
  '[]', 'Kaz sorts the heads.', '{"claim":"Ravana''s ten heads are often read as the six shastras and four vedas he mastered.","source_url":"https://en.wikipedia.org/wiki/Ravana"}',
  '["Ravana''s ten heads","Ten heads, one form","Sorting Ravana"]', 'Which reading do you know?', 'agent', 37.20, 'approved',
  'Ten heads, ten opinions, one Bureau form.', now() - interval '6 days', '{"status":"pass"}', '{"status":"pass"}', now() - interval '7 days', null, null);

-- Episodes in four states.
insert into episodes (id, brief_id, channel_id, slot_id, status, status_detail, estimate_inr, updated_at, created_at)
values
 ('5eed0000-0000-4000-8000-0000000e0001', '5eed0000-0000-4000-8000-0000000b0001', :ch, 'S001', 'awaiting_cut', null, 40.12, now() - interval '40 minutes', now() - interval '2 days'),
 ('5eed0000-0000-4000-8000-0000000e0003', '5eed0000-0000-4000-8000-0000000b0003', :ch, 'S003', 'halted', 'The approved punchline is not in the script, so it cannot be voiced.', 39.40, now() - interval '5 hours', now() - interval '2 days'),
 ('5eed0000-0000-4000-8000-0000000e0004', '5eed0000-0000-4000-8000-0000000b0004', :ch, 'S004', 'generating', 'stills 3/7', 41.00, now() - interval '4 minutes', now() - interval '1 day'),
 ('5eed0000-0000-4000-8000-0000000e0005', '5eed0000-0000-4000-8000-0000000b0005', :ch, 'S005', 'bundled', null, 37.20, now() - interval '1 day', now() - interval '6 days');

-- A bundle for S005 (Ready): concept → script → render → passing review → publication.
insert into concepts (id, channel_id, title, angle, rubric_version, status)
values ('5eed0000-0000-4000-8000-0000000c0005', :ch, 'Ravana''s ten heads', 'sorting the interpretations', 'v1', 'approved');
insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
values ('5eed0000-0000-4000-8000-0000000a0005', '5eed0000-0000-4000-8000-0000000c0005', 'Ten heads.', '[]', 'Ten heads, ten opinions, one Bureau form.', 'agent', 'seed');
insert into renders (id, script_id, variant_group_id, variant_label, format, width, height, duration_s, status)
values ('5eed0000-0000-4000-8000-0000000d0005', '5eed0000-0000-4000-8000-0000000a0005', '5eed0000-0000-4000-8000-0000000d0f05', 'A', 'shorts_9x16', 1080, 1920, 48.2, 'ready');
insert into reviews (id, render_id, reviewer_id, decision, structure_novel)
values ('5eed0000-0000-4000-8000-0000000f0005', '5eed0000-0000-4000-8000-0000000d0005', :me, 'pass', true);
insert into publications (id, render_id, channel_id, review_id, title, description, tags, status, platform, bundle, episode_id, slot_id)
values ('5eed0000-0000-4000-8000-000000090005', '5eed0000-0000-4000-8000-0000000d0005', :ch, '5eed0000-0000-4000-8000-0000000f0005',
  'Ravana''s ten heads — sorted', 'Kaz sorts the popular interpretations of Ravana''s ten heads. #Shorts', '{Shorts,Ravana,BureauOfReality}',
  'draft', 'youtube', '{"files":{}}', '5eed0000-0000-4000-8000-0000000e0005', 'S005');

-- Ledger: estimates for the run in flight, one measured row.
insert into cost_ledger (id, driver, quantity, unit, cost_usd, cost_inr, entry_kind, usd_inr_rate, stage, channel_id, cost_source, occurred_at)
values
 ('5eed0000-0000-4000-8000-00000000a001', 'anthropic', 1200, 'tokens', 0.0080, 0.70, 'estimate', 88, '20-brief', :ch, 'rate_card', now() - interval '3 hours'),
 ('5eed0000-0000-4000-8000-00000000a002', 'runway', 5, 'credits', 0.05, 4.40, 'estimate', 88, '21-still', :ch, 'rate_card', now() - interval '20 minutes'),
 ('5eed0000-0000-4000-8000-00000000a003', 'runway', 5, 'credits', 0.05, 4.40, 'estimate', 88, '21-still', :ch, 'rate_card', now() - interval '10 minutes'),
 ('5eed0000-0000-4000-8000-00000000a004', 'runway', 507, 'characters', 0.1014, 8.92, 'estimate', 88, '06-voice', :ch, 'rate_card', now() - interval '1 day');

insert into notifications (id, channel_id, kind, text, delivered, created_at)
values
 ('5eed0000-0000-4000-8000-00000000b001', :ch, 'cut_ready', 'S001 is cut and waiting for your review.', true, now() - interval '40 minutes'),
 ('5eed0000-0000-4000-8000-00000000b002', :ch, 'qc_failed', 'S003 stopped: the approved punchline is not in the script.', true, now() - interval '5 hours');

insert into authorship_log (id, channel_id, actor_scope, profile_id, action, subject_type, subject_id, exact_text, occurred_at)
values
 ('5eed0000-0000-4000-8000-00000000c101', :ch, 'approver', :me, 'brief.approve', 'brief', '5eed0000-0000-4000-8000-0000000b0001', 'No Moon, no big tides.', now() - interval '2 days'),
 ('5eed0000-0000-4000-8000-00000000c102', :ch, 'approver', :me, 'brief.approve', 'brief', '5eed0000-0000-4000-8000-0000000b0003', 'Gravity is the floor being clingy.', now() - interval '2 days'),
 ('5eed0000-0000-4000-8000-00000000c103', :ch, 'agent', null, 'brief.create', 'brief', '5eed0000-0000-4000-8000-0000000b0002', null, now() - interval '3 hours');

-- Trends (O5): a run with YouTube partial (category 27 has no chart in IN), Reddit not configured,
-- and signals across the five sources with relevance — some for the channel, most not, two never scored.
insert into trend_runs (id, channel_id, trigger, started_at, finished_at, inserted, updated, sources, relevance)
values ('5eed0000-0000-4000-8000-0000000e0001', :ch, 'schedule', now() - interval '3 hours 2 minutes', now() - interval '3 hours', 118, 14,
  '[{"source":"reddit","ok":false,"count":0,"detail":"not configured: REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are not set — Reddit refuses unauthenticated reads (403 since 28-May-2026)."},
    {"source":"youtube","ok":true,"count":43,"detail":"category 27: no most-popular chart for this category in IN (HTTP 404 notFound — Requested entity was not found.)","failures":[{"part":"category 27","kind":"no_chart","detail":"no most-popular chart for this category in IN (HTTP 404 notFound — Requested entity was not found.) — Google does not publish which categories have one; keep it as a query instead, or remove it"}]},
    {"source":"google_trends","ok":true,"count":20},
    {"source":"wikipedia","ok":true,"count":50},
    {"source":"hn","ok":true,"count":30}]'::jsonb,
  '{"scored":130,"unscored":2,"detail":"2 new terms not embedded: embeddings vendor rate-limited (429) on all 4 attempts","embedded":61,"nicheRebuilt":false}'::jsonb);

insert into trend_signals (id, channel_id, source, term, region, velocity, volume, relevance, captured_at, raw)
select ('5eed0000-0000-4000-8000-0000000f' || lpad(n::text, 4, '0'))::uuid, :ch, src, term, reg, vel, vol, rel, now() - (h || ' hours')::interval, '{}'::jsonb
from (values
  (1, 'hn', 'Physicists measure gravity at the millimetre scale for the first time', null, 61.2, 412, 0.81, 3),
  (2, 'wikipedia', 'Total solar eclipse of 2027', null, 18420, 96110, 0.78, 3),
  (3, 'youtube', 'How does a fridge actually move heat? | Science explained', 'IN', 2210.5, 160400, 0.76, 3),
  (4, 'hn', 'Why the Moon is slowly drifting away from Earth', null, 33.8, 251, 0.74, 9),
  (5, 'wikipedia', 'Speed of light', null, -1210, 24410, 0.71, 3),
  (6, 'youtube', 'Why do bridges hum in the wind?', 'IN', 840, 51200, 0.69, 27),
  (7, 'google_trends', 'kourtney kardashian', 'US', null, 200000, 0.31, 3),
  (8, 'google_trends', 'why is the stock market down today', 'US', null, 50000, 0.38, 3),
  (9, 'youtube', 'iPhone 18 Pro unboxing — first look', 'IN', 15600, 1250000, 0.42, 3),
  (10, 'google_trends', 'india vs australia', 'IN', null, 500000, 0.27, 3),
  (11, 'wikipedia', 'Deaths in 2026', null, 4210, 88120, 0.33, 3),
  (12, 'hn', 'Show HN: A Postgres extension for time-series compression', null, 22.1, 188, 0.49, 3),
  (13, 'youtube', 'Samsung Galaxy S27 Ultra camera test', 'IN', 9210, 640000, 0.40, 9),
  (14, 'wikipedia', 'Taylor Swift', null, 820, 51900, 0.29, 3),
  (15, 'hn', 'The economics of open-source maintainers', null, 12.4, 140, 0.52, 3),
  (16, 'google_trends', 'diwali 2026 date', 'IN', null, 100000, 0.35, 3),
  (17, 'wikipedia', 'Black hole', null, 3110, 31020, null, 3),
  (18, 'youtube', 'Desi street food tour in Old Delhi', 'IN', 3300, 210000, null, 3)
) as t(n, src, term, reg, vel, vol, rel, h);

commit;
