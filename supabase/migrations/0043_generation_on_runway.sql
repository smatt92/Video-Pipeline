-- 0043 — Generation on the Runway API (decision 0015): the rates the router prices against,
-- two recipes that wait to be watched, and the variation refusal in the database.
--
-- Forward-only. Inserts and one `create or replace function`; no DROP, no column change, so
-- the generated types do not move.

-- ═════════════════════════════════════════════════════════════════════════════
-- Rates
-- ═════════════════════════════════════════════════════════════════════════════

-- Per second, endpoint null: the estimator looks a video rate up by (driver, model, unit
-- 'second', endpoint null), because one model is reachable on two endpoints (Veo is
-- image-to-video with a start frame, text-to-video without) and costs the same on both.
--
-- Verified in the sense 0040 used for the voice rows: a published price, not a measured
-- balance move. The figures are plan v2.3's (Sahil, 06-Oct-2026). The vendor's SDK carries
-- no prices, and the pricing page was not readable from the environment that wrote this;
-- 0015 says so and 0008 lists it. What makes a wrong figure visible rather than silent: a
-- terminal Runway task reports its final charge, and the dispatcher writes it as a
-- `reconcile` row with cost_source = 'measured' beside every estimate priced from here.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('runway', 'gen4_turbo', null, 'second', 0.05, 'USD', true,
   'Published: 5 credits per second, USD 0.01 per credit (plan v2.3). Billed seconds are whole, 2–10. '
   'Not yet read from the pricing page by the build; the measured reconcile on each task is the check.',
   '2026-10-01T00:00:00Z'),
  ('runway', 'veo3.1_fast', null, 'second', 0.10, 'USD', true,
   'Published: 10 credits per second WITH AUDIO OFF (15 with audio), USD 0.01 per credit (plan v2.3). '
   'The driver always sends audio:false. Billed seconds are 4, 6 or 8. Measured reconcile is the check.',
   '2026-10-01T00:00:00Z'),
  ('runway', 'gen4_image', '/v1/text_to_image', 'image_720p', 0.05, 'USD', true,
   'Published: 5 credits per image at 720p, USD 0.01 per credit (plan v2.3).', '2026-10-01T00:00:00Z'),
  ('runway', 'gen4_image', '/v1/text_to_image', 'image_1080p', 0.08, 'USD', true,
   'Published: 8 credits per image at 1080p, USD 0.01 per credit (plan v2.3).', '2026-10-01T00:00:00Z'),
  ('runway', 'gen4_image_turbo', '/v1/text_to_image', 'image', 0.02, 'USD', true,
   'Published: 2 credits per image, USD 0.01 per credit (plan v2.3). Needs at least one reference image.',
   '2026-10-01T00:00:00Z')
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Recipes — present, and retired until someone watches one work
-- ═════════════════════════════════════════════════════════════════════════════

-- Production reads the library; it never improvises (CLAUDE.md). These two are the shapes
-- the Bureau router needs, written down so nobody has to guess the params — and retired,
-- because `accepts_character_ref` means "observed to carry the reference through", and
-- nobody has observed Gen-4 Turbo hold a chalk-line stickman yet (0015, the open risk).
-- While they are retired the router finds no recipe, the estimator says "no active recipe
-- for character_beat", and every character beat is planned as an overlay with that reason
-- on the episode. The handover gives the one statement that activates each, after
-- `pnpm verify:runway-video` has produced a clip somebody watched.
insert into prompts (name, version, driver, model, template, params, tags, discovered_in,
                     is_active, accepts_character_ref, retired_at, retired_reason)
values
  ('bureau-character-beat-gen4-turbo', 1, 'runway', 'gen4_turbo',
   'Animate this exact chalk-line character, keeping its line weight, proportions and accent colour unchanged: {{description}}. Camera locked, navy blueprint background stays still.',
   '{"max_duration_s": 10}'::jsonb, '{subject_medium}', 'manual', false, false, now(),
   'Not yet observed. Run pnpm verify:runway-video with a locked frame, watch the clip, then activate (0015 / HANDOVER-PROMPT-I).'),
  ('bureau-money-shot-veo31-fast', 1, 'runway', 'veo3.1_fast',
   '{{description}}. Cinematic, no text, no people.',
   '{"max_duration_s": 8}'::jsonb, '{establishing}', 'manual', false, false, now(),
   'Not yet observed. Generate one money shot, watch it, then activate (0015 / HANDOVER-PROMPT-I).')
on conflict (name, version) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Brief approve — refuses a brief whose repetition check could not run
-- ═════════════════════════════════════════════════════════════════════════════

-- 0040's function, unchanged except for the block marked NEW. `approveBrief` in TypeScript
-- refuses first with a readable sentence; this is the refusal that holds for a caller that
-- skips it. A `fail` stays approvable — flagged, and a human overriding a flag is the design
-- — but a check that did not run gives the human nothing to weigh. Reads the pre-0043
-- spelling 'incomplete' as well, so no stored row slips through on its name.
create or replace function bureau_brief_approve(
  p_token uuid, p_brief uuid, p_punchline text, p_choice text, p_edits jsonb
) returns uuid
language plpgsql as $$
declare
  t   mcp_tokens;
  b   briefs;
  ep  uuid;
  ed  jsonb := coalesce(p_edits, '{}'::jsonb);
begin
  t := bureau_require_scope(p_token, 'approver');

  select * into b from briefs where id = p_brief for update;
  if not found or b.channel_id <> t.channel_id then
    raise exception 'not_found: brief % does not exist on this channel', p_brief;
  end if;
  if b.status <> 'pending' then
    raise exception 'conflict: brief % is %, not pending', p_brief, b.status;
  end if;
  if p_punchline is null or length(trim(p_punchline)) = 0 then
    raise exception 'invalid: a punchline is required';
  end if;

  -- NEW (0043)
  if coalesce(b.variation->>'status', '') in ('refused', 'incomplete', '')
     or coalesce(b.variation->'similarity'->>'checked', 'false') <> 'true' then
    raise exception 'conflict: variation_check refused brief %: %', p_brief,
      coalesce(b.variation->>'refused_reason',
               'similarity not computed — ' || coalesce(b.variation->'similarity'->>'reason', 'no reason recorded'));
  end if;

  update briefs set
    status           = 'approved',
    chosen_punchline = trim(p_punchline),
    approved_edits   = ed,
    approved_at      = now(),
    approved_by_token = t.id,
    premise          = coalesce(nullif(trim(ed->>'premise'), ''), premise),
    script_text      = coalesce(nullif(trim(ed->>'script_text'), ''), script_text),
    pinned_comment   = coalesce(nullif(trim(ed->>'pinned_comment'), ''), pinned_comment)
  where id = p_brief;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (b.channel_id, 'approver', t.id, t.profile_id, 'brief_approve', 'brief', p_brief::text,
          trim(p_punchline),
          jsonb_build_object('choice', p_choice, 'edits', ed, 'slot_id', b.slot_id));

  insert into episodes (brief_id, channel_id, slot_id, kind)
  values (p_brief, b.channel_id, b.slot_id, case when b.series = 'long_form' then 'long_form' else 'short' end)
  returning id into ep;

  return ep;
end $$;
