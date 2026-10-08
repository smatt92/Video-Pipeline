-- Screens seed: one episode in each place an operator looks, for the Bureau channel, so the
-- app's screens have something to render locally (scripts/screens/serve.mjs). Development aid
-- only — never pasted into the hosted project, and nothing in CI reads it.
--
-- Apply after migrations + supabase/seed.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/screens/seed.sql
-- Re-runnable: everything it writes carries a fixed id and is deleted first.

begin;

\set ch '''b0000000-0000-4000-8000-000000000001'''
\set me '''a0000000-0000-4000-8000-0000000000aa'''

delete from publications where id::text like 'c5000000-%';
delete from episodes where id::text like 'e5000000-%';
delete from reviews where id::text like 'd5000000-%';
delete from renders where id::text like 'f5000000-%';
delete from scripts where id::text like '55000000-%';
delete from concepts where id::text like 'a5000000-%';
delete from briefs where id::text like 'b5000000-%';

insert into profiles (id, email, display_name, onboarding_completed_steps, onboarding_seen_at)
values (:me, 'owner@example.com', 'Sahil', array[1,2,3,4,5,6,7,8,9,10,11], now())
on conflict (id) do update set onboarding_completed_steps = excluded.onboarding_completed_steps, onboarding_seen_at = excluded.onboarding_seen_at;

-- Briefs: three pending (Approvals), six behind episodes.
insert into briefs (id, channel_id, slot_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, fact, titles, pinned_comment, created_by, status, approved_at, chosen_punchline, estimate_inr)
select ('b5000000-0000-4000-8000-00000000000' || i)::uuid, :ch, s, series, 'pip', 'Desk 4',
       premise, 'observational', 'cold_open', 'loop', 'bed_a', 'question',
       '["A","B","C"]'::jsonb, '[]'::jsonb, 'Pip files the form. The form files Pip.',
       '{"claim":"Paperclips were patented in 1899.","source_url":"https://example.org/clip"}'::jsonb,
       '["One","Two","Three"]'::jsonb, 'Which desk are you?', 'agent',
       case when i <= 3 then 'pending' else 'approved' end,
       case when i <= 3 then null else now() end,
       case when i <= 3 then null else 'A' end,
       120 + i * 7
  from (values
    (1, 'S010', 'incident', 'The vending machine files a complaint about being kicked on Mondays'),
    (2, 'S011', 'desk_tour', 'Pip gives a tour of the desk drawer nobody has opened since 1987'),
    (3, 'S012', 'myth', 'Is it true that staplers jam more often when you are late?'),
    (4, 'S004', 'archive', 'The archive keeps one copy of every lost umbrella, alphabetised'),
    (5, 'S005', 'myth', 'Do printers really know when you are in a hurry? The Bureau checks'),
    (6, 'S006', 'incident', 'A chair goes missing and the inquiry takes forty-one meetings'),
    (7, 'S007', 'desk_tour', 'The water cooler has seen things, and it is ready to talk now'),
    (8, 'S008', 'incident', 'Form 27B was approved in error and now nobody can stop it'),
    (9, 'S009', 'archive', 'The longest queue in Bureau history, measured in sandwiches')
  ) v(i, s, series, premise);

insert into concepts (id, channel_id, title, angle, rubric_version)
values ('a5000000-0000-4000-8000-000000000001', :ch, 'Screens seed', 'seed', 'v1');

insert into scripts (id, concept_id, version, hook, beats, vo_text, drafted_by, structure_hash)
select ('55000000-0000-4000-8000-00000000000' || i)::uuid, 'a5000000-0000-4000-8000-000000000001', i, 'Hook', '[]'::jsonb, 'Pip files the form.', 'seed', 'h' || i
  from generate_series(4, 9) i;

insert into renders (id, script_id, variant_group_id, variant_label, format, width, height, kind, status, layer)
select ('f5000000-0000-4000-8000-00000000000' || i)::uuid, ('55000000-0000-4000-8000-00000000000' || i)::uuid, gen_random_uuid(), 'A', 'shorts_9x16', 1080, 1920, 'final', 'ready', 'composite'
  from generate_series(4, 9) i;

insert into reviews (id, render_id, reviewer_id, decision, structure_novel)
select ('d5000000-0000-4000-8000-00000000000' || i)::uuid, ('f5000000-0000-4000-8000-00000000000' || i)::uuid, :me, 'pass', true
  from generate_series(8, 9) i;

-- Episodes: generating, assembling (after a cut approval), awaiting cut, cut_approved, bundled, scheduled.
insert into episodes (id, brief_id, channel_id, slot_id, status, status_detail, script_id, final_render_id, review_id, updated_at)
values
  ('e5000000-0000-4000-8000-000000000004', 'b5000000-0000-4000-8000-000000000004', :ch, 'S004', 'generating', 'generating video (3 of 7)', '55000000-0000-4000-8000-000000000004', null, null, now() - interval '2 minutes'),
  ('e5000000-0000-4000-8000-000000000005', 'b5000000-0000-4000-8000-000000000005', :ch, 'S005', 'assembling', 'rendering clean master · 42%', '55000000-0000-4000-8000-000000000005', 'f5000000-0000-4000-8000-000000000005', null, now() - interval '20 seconds'),
  ('e5000000-0000-4000-8000-000000000006', 'b5000000-0000-4000-8000-000000000006', :ch, 'S006', 'awaiting_cut', null, '55000000-0000-4000-8000-000000000006', 'f5000000-0000-4000-8000-000000000006', null, now() - interval '1 hour'),
  ('e5000000-0000-4000-8000-000000000007', 'b5000000-0000-4000-8000-000000000007', :ch, 'S007', 'cut_approved', null, '55000000-0000-4000-8000-000000000007', 'f5000000-0000-4000-8000-000000000007', null, now() - interval '5 seconds'),
  ('e5000000-0000-4000-8000-000000000008', 'b5000000-0000-4000-8000-000000000008', :ch, 'S008', 'bundled', null, '55000000-0000-4000-8000-000000000008', 'f5000000-0000-4000-8000-000000000008', 'd5000000-0000-4000-8000-000000000008', now() - interval '3 hours'),
  ('e5000000-0000-4000-8000-000000000009', 'b5000000-0000-4000-8000-000000000009', :ch, 'S009', 'scheduled', null, '55000000-0000-4000-8000-000000000009', 'f5000000-0000-4000-8000-000000000009', 'd5000000-0000-4000-8000-000000000009', now() - interval '1 day');

-- Bundles for the two finished episodes.
insert into publications (id, render_id, channel_id, review_id, episode_id, slot_id, platform, status, title, description, tags, bundle, scheduled_for, idempotency_key)
values
  ('c5000000-0000-4000-8000-000000000008', 'f5000000-0000-4000-8000-000000000008', :ch, 'd5000000-0000-4000-8000-000000000008', 'e5000000-0000-4000-8000-000000000008', 'S008', 'youtube', 'draft',
   'Form 27B Cannot Be Stopped', 'Form 27B was approved in error.', array['bureau','forms'],
   '{"title":"Form 27B Cannot Be Stopped","tags":["bureau","forms"],"made_for_kids":false,"contains_synthetic_media":true,"pinned_comment":"Which desk are you?"}'::jsonb, null, 'seed:bundle:8'),
  ('c5000000-0000-4000-8000-000000000009', 'f5000000-0000-4000-8000-000000000009', :ch, 'd5000000-0000-4000-8000-000000000009', 'e5000000-0000-4000-8000-000000000009', 'S009', 'youtube', 'scheduled',
   'The Longest Queue', 'Measured in sandwiches.', array['bureau'],
   '{"title":"The Longest Queue","tags":["bureau"],"made_for_kids":false,"contains_synthetic_media":true}'::jsonb, now() + interval '2 days', 'seed:bundle:9');

update episodes set publication_id = 'c5000000-0000-4000-8000-000000000008' where id = 'e5000000-0000-4000-8000-000000000008';
update episodes set publication_id = 'c5000000-0000-4000-8000-000000000009' where id = 'e5000000-0000-4000-8000-000000000009';

commit;
