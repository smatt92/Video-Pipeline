-- 0040 — The Bureau control plane: decisions as single transactions, the rates the router
-- and the voice stage price against, and the columns the episode run waits on.
--
-- Every approver decision (brief approve/reject, cut approve/reject, caps, kill switch,
-- mark scheduled) is ONE function here. Each one checks the token's scope itself, writes
-- the decision, and writes the authorship_log row in the same transaction — so a decision
-- without its log row, or a log row for a decision that rolled back, cannot exist. The
-- TypeScript layer checks scope too (it is what refuses with a readable message); this is
-- the check that holds if a future caller forgets.
--
-- Forward-only. No DROP: `create or replace view` keeps v_pipeline_blockers' columns and
-- changes one CASE branch.

-- ═════════════════════════════════════════════════════════════════════════════
-- Rates
-- ═════════════════════════════════════════════════════════════════════════════

-- The model router's three tiers. Published list prices, read 2026-10-06 from
-- platform.claude.com/docs/en/models/overview. Verified in the sense rate_card uses for the
-- existing Opus row: a published price, not a measured balance move (cost_source says so).
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('anthropic', 'claude-opus-5-5', '/v1/messages', 'input_token', 0.000004, 'USD', true,
   'Published list price: USD 4.00 per 1M input tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-opus-5-5', '/v1/messages', 'output_token', 0.00002, 'USD', true,
   'Published list price: USD 20.00 per 1M output tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages', 'input_token', 0.000002, 'USD', true,
   'Published list price: USD 2.00 per 1M input tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-sonnet-5-5', '/v1/messages', 'output_token', 0.00001, 'USD', true,
   'Published list price: USD 10.00 per 1M output tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-haiku-4-5-20251001', '/v1/messages', 'input_token', 0.000001, 'USD', true,
   'Published list price: USD 1.00 per 1M input tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z'),
  ('anthropic', 'claude-haiku-4-5-20251001', '/v1/messages', 'output_token', 0.000005, 'USD', true,
   'Published list price: USD 5.00 per 1M output tokens (models overview, read 2026-10-06).', '2026-10-01T00:00:00Z')
on conflict do nothing;

-- Embeddings for variation_check's similarity test. Published price USD 0.15 per 1M input
-- tokens. The API returns no token count, so the QUANTITY is estimated (characters / 4) and
-- the row says so through cost_source = 'rate_card'.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('gemini', 'gemini-embedding-001', '/v1beta/models:batchEmbedContents', 'input_token', 0.00000015, 'USD', true,
   'Published list price USD 0.15 per 1M input tokens. Token quantity is estimated as '
   'ceil(characters / 4) because the response carries no usage.', '2026-10-01T00:00:00Z')
on conflict do nothing;

-- Voice on the Runway API (plan v2.2, decision 0013). 1 credit per 50 characters at
-- USD 0.01 per credit = USD 0.0002 per character, for eleven_v3 and eleven_multilingual_v2.
-- A published price; every row priced from it is cost_source = 'rate_card' until a credit
-- balance is observed to move.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('runway', 'eleven_v3', '/v1/text_to_speech', 'character', 0.0002, 'USD', true,
   'Published: 1 credit per 50 characters, USD 0.01 per credit (plan v2.2 / Runway API pricing). '
   'Not yet observed against a balance.', '2026-10-01T00:00:00Z'),
  ('runway', 'eleven_multilingual_v2', '/v1/text_to_speech', 'character', 0.0002, 'USD', true,
   'Published: 1 credit per 50 characters, USD 0.01 per credit (plan v2.2 / Runway API pricing). '
   'Not yet observed against a balance.', '2026-10-01T00:00:00Z'),
  -- Dubbing and sound effects have no published per-unit rate. The credit itself is
  -- priced (USD 0.01); the QUANTITY comes from the vendor's own estimatedCost.credits on the
  -- submit response, and every surface that shows a dub cost says "rate unverified".
  ('runway', 'eleven_voice_dubbing', '/v1/voice_dubbing', 'credit', 0.01, 'USD', true,
   'USD 0.01 per API credit is published; credits per dub are NOT — quantity is the vendor''s '
   'submit-time estimatedCost (an upper bound). Rate unverified.', '2026-10-01T00:00:00Z'),
  ('runway', 'eleven_text_to_sound_v2', '/v1/sound_effect', 'credit', 0.01, 'USD', true,
   'USD 0.01 per API credit is published; credits per effect are NOT — quantity is the '
   'vendor''s submit-time estimatedCost. Rate unverified.', '2026-10-01T00:00:00Z')
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Columns the episode run and the dub task wait on
-- ═════════════════════════════════════════════════════════════════════════════

alter table episodes
  add column gen_wait_token text,
  add column kind           text not null default 'short' check (kind in ('short', 'long_form')),
  add column voice_detail   jsonb;

comment on column episodes.gen_wait_token is
  'Trigger wait token the episode run parks on while its gen_jobs are in flight. The '
  'dispatcher completes it when the last job for the episode reaches a terminal state — '
  'the run is woken, not polling.';

alter table dub_jobs
  add column request_id        text,
  add column credits_estimated numeric check (credits_estimated is null or credits_estimated >= 0),
  add column output_url_expires_at timestamptz;

-- ═════════════════════════════════════════════════════════════════════════════
-- Scope, in the database
-- ═════════════════════════════════════════════════════════════════════════════

create function bureau_require_scope(p_token uuid, p_scope text) returns mcp_tokens
language plpgsql as $$
declare t mcp_tokens;
begin
  select * into t from mcp_tokens where id = p_token;
  if not found or t.revoked_at is not null then
    raise exception 'token_invalid: token % is unknown or revoked', p_token;
  end if;
  if p_scope = 'approver' and t.scope <> 'approver' then
    raise exception 'scope_denied: this action needs the approver scope; token % is %', p_token, t.scope;
  end if;
  return t;
end $$;

comment on function bureau_require_scope is
  'Raise unless the token exists, is not revoked, and (for approver actions) carries the '
  'approver scope. Called first by every decision function below.';

-- ── Brief approve ─────────────────────────────────────────────────────────────

create function bureau_brief_approve(
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

-- ── Brief reject ──────────────────────────────────────────────────────────────

create function bureau_brief_reject(p_token uuid, p_brief uuid, p_reason text) returns void
language plpgsql as $$
declare t mcp_tokens; b briefs;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into b from briefs where id = p_brief for update;
  if not found or b.channel_id <> t.channel_id then
    raise exception 'not_found: brief % does not exist on this channel', p_brief;
  end if;
  if b.status <> 'pending' then
    raise exception 'conflict: brief % is %, not pending', p_brief, b.status;
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'invalid: a reason is required';
  end if;

  update briefs set status = 'rejected', rejected_at = now(), reject_reason = trim(p_reason)
   where id = p_brief;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (b.channel_id, 'approver', t.id, t.profile_id, 'brief_reject', 'brief', p_brief::text,
          trim(p_reason), jsonb_build_object('slot_id', b.slot_id));
end $$;

-- ── Cut approve / reject ──────────────────────────────────────────────────────

create function bureau_cut_decide(p_token uuid, p_episode uuid, p_approve boolean, p_note text)
returns jsonb
language plpgsql as $$
declare t mcp_tokens; e episodes; b briefs; rv uuid;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into e from episodes where id = p_episode for update;
  if not found or e.channel_id <> t.channel_id then
    raise exception 'not_found: episode % does not exist on this channel', p_episode;
  end if;
  if e.status <> 'awaiting_cut' then
    raise exception 'conflict: episode % is %, not awaiting_cut', p_episode, e.status;
  end if;
  if e.final_render_id is null then
    raise exception 'conflict: episode % has no final render to review', p_episode;
  end if;
  if not p_approve and (p_note is null or length(trim(p_note)) = 0) then
    raise exception 'invalid: a rejection needs a note';
  end if;
  select * into b from briefs where id = e.brief_id;

  -- reviews.reviewer_id is a person; an approver token always names one (mcp_tokens check).
  insert into reviews (render_id, reviewer_id, decision, notes, structure_novel)
  values (e.final_render_id, t.profile_id, case when p_approve then 'pass' else 'reshoot' end,
          nullif(trim(coalesce(p_note, '')), ''),
          coalesce((b.variation->>'passed')::boolean, false))
  returning id into rv;

  update episodes set
    status     = case when p_approve then 'cut_approved' else 'cut_rejected' end,
    review_id  = rv,
    updated_at = now()
  where id = p_episode;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (e.channel_id, 'approver', t.id, t.profile_id,
          case when p_approve then 'cut_approve' else 'cut_reject' end,
          'episode', p_episode::text, coalesce(nullif(trim(coalesce(p_note, '')), ''), case when p_approve then 'approved' end),
          jsonb_build_object('render_id', e.final_render_id, 'review_id', rv));

  return jsonb_build_object('review_id', rv, 'cut_wait_token', e.cut_wait_token);
end $$;

-- ── Caps and the kill switch ──────────────────────────────────────────────────

create function bureau_caps_set(p_token uuid, p_changes jsonb) returns channel_policy
language plpgsql as $$
declare
  t mcp_tokens; p channel_policy; k text;
  allowed text[] := array['per_short_cap_inr','daily_cap_inr','daily_longform_cap_inr',
    'monthly_cap_inr','monthly_cap_after_gate2_inr','daily_publish_cap','gate2_passed',
    'variation_min_axes','similarity_max','hook_archetype_weekly_max','catchphrase_weekly_max',
    'overlay_min_share','character_beat_max_s','money_shot_max','rerolls_max'];
begin
  t := bureau_require_scope(p_token, 'approver');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'invalid: no changes given';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then
      raise exception 'invalid: "%" is not a cap this tool can set', k;
    end if;
  end loop;

  update channel_policy set
    per_short_cap_inr           = coalesce((p_changes->>'per_short_cap_inr')::numeric, per_short_cap_inr),
    daily_cap_inr               = coalesce((p_changes->>'daily_cap_inr')::numeric, daily_cap_inr),
    daily_longform_cap_inr      = coalesce((p_changes->>'daily_longform_cap_inr')::numeric, daily_longform_cap_inr),
    monthly_cap_inr             = coalesce((p_changes->>'monthly_cap_inr')::numeric, monthly_cap_inr),
    monthly_cap_after_gate2_inr = coalesce((p_changes->>'monthly_cap_after_gate2_inr')::numeric, monthly_cap_after_gate2_inr),
    daily_publish_cap           = coalesce((p_changes->>'daily_publish_cap')::int, daily_publish_cap),
    gate2_passed_at             = case
                                    when p_changes ? 'gate2_passed' and (p_changes->>'gate2_passed')::boolean
                                      then coalesce(gate2_passed_at, now())
                                    when p_changes ? 'gate2_passed' then null
                                    else gate2_passed_at end,
    variation_min_axes          = coalesce((p_changes->>'variation_min_axes')::int, variation_min_axes),
    similarity_max              = coalesce((p_changes->>'similarity_max')::numeric, similarity_max),
    hook_archetype_weekly_max   = coalesce((p_changes->>'hook_archetype_weekly_max')::int, hook_archetype_weekly_max),
    catchphrase_weekly_max      = coalesce((p_changes->>'catchphrase_weekly_max')::int, catchphrase_weekly_max),
    overlay_min_share           = coalesce((p_changes->>'overlay_min_share')::numeric, overlay_min_share),
    character_beat_max_s        = coalesce((p_changes->>'character_beat_max_s')::numeric, character_beat_max_s),
    money_shot_max              = coalesce((p_changes->>'money_shot_max')::int, money_shot_max),
    rerolls_max                 = coalesce((p_changes->>'rerolls_max')::int, rerolls_max),
    updated_at = now(),
    updated_by = 'approver:' || t.id
  where channel_id = t.channel_id
  returning * into p;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id, 'caps_set', 'channel_policy',
          t.channel_id::text, p_changes::text, p_changes);
  return p;
end $$;

create function bureau_kill_switch(p_token uuid, p_on boolean, p_reason text) returns channel_policy
language plpgsql as $$
declare t mcp_tokens; p channel_policy;
begin
  t := bureau_require_scope(p_token, 'approver');
  if p_on and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'invalid: turning the kill switch on needs a reason';
  end if;
  update channel_policy set
    kill_switch        = p_on,
    kill_switch_reason = case when p_on then trim(p_reason) else null end,
    kill_switch_at     = case when p_on then now() else null end,
    updated_at = now(),
    updated_by = 'approver:' || t.id
  where channel_id = t.channel_id
  returning * into p;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id,
          case when p_on then 'kill_switch_on' else 'kill_switch_off' end,
          'channel_policy', t.channel_id::text, coalesce(trim(p_reason), 'off'),
          jsonb_build_object('on', p_on));
  return p;
end $$;

-- ── Mark scheduled (manual Studio scheduling while the upload API is unaudited) ─

create function bureau_mark_scheduled(p_token uuid, p_publication uuid, p_at timestamptz)
returns publications
language plpgsql as $$
declare t mcp_tokens; pub publications;
begin
  t := bureau_require_scope(p_token, 'approver');
  select * into pub from publications where id = p_publication for update;
  if not found or pub.channel_id <> t.channel_id then
    raise exception 'not_found: publication % does not exist on this channel', p_publication;
  end if;
  if pub.status <> 'draft' then
    raise exception 'conflict: publication % is %, not draft', p_publication, pub.status;
  end if;
  if p_at is null then
    raise exception 'invalid: a schedule time is required';
  end if;

  -- Both publication triggers run here: enforce_review_pass (the review must be a pass) and
  -- enforce_channel_policy (kill switch, daily publish cap). Neither is bypassed.
  update publications set status = 'scheduled', scheduled_for = p_at, marked_scheduled_at = now()
   where id = p_publication
  returning * into pub;

  update episodes set status = 'scheduled', updated_at = now() where id = pub.episode_id;

  insert into authorship_log (channel_id, actor_scope, token_id, profile_id, action,
                              subject_type, subject_id, exact_text, payload)
  values (t.channel_id, 'approver', t.id, t.profile_id, 'mark_scheduled', 'publication',
          p_publication::text, p_at::text,
          jsonb_build_object('episode_id', pub.episode_id, 'platform', pub.platform));
  return pub;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Silence, read back: the blocker view names a failed alignment
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Prompt H: when forced alignment fails or is not confident, timings are null, durations
-- stay estimates, and stage 5 keeps refusing. Without this branch the view would say "stage
-- 6 has not run" about a script whose stage 6 ran and paid — the wrong next action.

create or replace view v_pipeline_blockers as
 SELECT s.id AS script_id,
    c.id AS concept_id,
    c.channel_id,
    c.title,
    s.created_at,
        CASE
            WHEN NOT (EXISTS ( SELECT 1
               FROM integrations i
              WHERE i.kind = 'video'::text AND i.is_enabled AND i.last_verified_at IS NOT NULL)) THEN 'no verified video integration — enabling states intent, verifying states fact'::text
            WHEN NOT (EXISTS ( SELECT 1
               FROM prompts p
              WHERE p.is_active)) THEN 'the prompt library has no active recipe — production reads the library, it never improvises'::text
            WHEN NOT (EXISTS ( SELECT 1
               FROM shots sh
              WHERE sh.script_id = s.id)) THEN 'no shots — stage 4 has not run'::text
            WHEN (EXISTS ( SELECT 1
               FROM shots sh
              WHERE sh.script_id = s.id AND (sh.compiled_params IS NULL OR sh.prompt_id IS NULL))) THEN 'some shots have no compiled parameters — no library recipe matched'::text
            WHEN (EXISTS ( SELECT 1
               FROM shots sh
                 JOIN prompts p ON p.id = sh.prompt_id
              WHERE sh.script_id = s.id AND NOT (EXISTS ( SELECT 1
                       FROM rate_card rc
                      WHERE rc.driver = p.driver AND rc.model = p.model AND rc.unit = 'credit'::text AND rc.is_verified AND rc.effective_from <= now())))) THEN 'no verified credit rate for the recipe these shots use — the call cannot be priced'::text
            WHEN s.pilot_rejected_at IS NOT NULL THEN 'the pilot shot was rejected — change the recipe and submit a new pilot'::text
            WHEN s.pilot_generation_id IS NOT NULL AND s.pilot_approved_at IS NULL THEN 'waiting on pilot approval — one shot was generated so the rest can be judged before they are paid for'::text
            WHEN (EXISTS ( SELECT 1
               FROM shots sh
              WHERE sh.script_id = s.id AND sh.duration_source <> 'derived_from_vo'::text)) THEN
            CASE
                WHEN (EXISTS ( SELECT 1 FROM vo_takes vt
                   WHERE vt.script_id = s.id AND vt.word_timings = '[]'::jsonb AND vt.asset_id IS NOT NULL))
                  THEN 'voice was synthesised but forced alignment did not confirm every word — timings are null, so durations stay estimates'::text
                WHEN ch.host_voice_id IS NULL AND NOT (EXISTS ( SELECT 1 FROM characters k
                   WHERE k.channel_id = c.channel_id AND k.voice_id IS NOT NULL))
                  THEN 'durations are still estimates and the channel has no host voice — stage 6 cannot run'::text
                ELSE 'durations are still estimates — stage 6 has not run'::text
            END
            ELSE NULL::text
        END AS blocker,
        CASE
            WHEN NOT (EXISTS ( SELECT 1
               FROM integrations i
              WHERE i.kind = 'video'::text AND i.is_enabled AND i.last_verified_at IS NOT NULL)) THEN true
            WHEN NOT (EXISTS ( SELECT 1
               FROM prompts p
              WHERE p.is_active)) THEN true
            ELSE false
        END AS blocker_is_workspace_wide,
    s.pilot_generation_id IS NOT NULL AND s.pilot_approved_at IS NULL AND s.pilot_rejected_at IS NULL AS awaiting_pilot_approval
   FROM scripts s
     JOIN concepts c ON c.id = s.concept_id
     JOIN channels ch ON ch.id = c.channel_id;

-- ═════════════════════════════════════════════════════════════════════════════
-- Read-side views for the control room and the MCP tools
-- ═════════════════════════════════════════════════════════════════════════════

create view v_ready_bundles as
select p.id as publication_id, p.channel_id, p.episode_id, p.slot_id, p.platform, p.status,
       p.title, p.description, p.tags, p.made_for_kids, p.altered_content_disclosed,
       p.scheduled_for, p.marked_scheduled_at, p.bundle, p.created_at,
       sl.slot_date, sl.series, sl.topic
  from publications p
  left join slots sl on sl.id = p.slot_id
 where p.bundle is not null;

-- RLS on the new rows is inherited from 0039's event trigger where it exists; views stay
-- closed to anon/authenticated, matching 0039.
do $$
begin
  if to_regrole('anon') is not null then
    execute 'revoke all on public.v_ready_bundles from anon, authenticated';
    execute 'revoke all on public.v_pipeline_blockers from anon, authenticated';
  end if;
end $$;
