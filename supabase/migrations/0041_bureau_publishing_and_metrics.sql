-- 0041 — Bureau publishing behind its flags, and the metrics it reads back.
--
-- Forward-only, no DROP: `create or replace view` keeps v_publish_queue's columns.

-- ═════════════════════════════════════════════════════════════════════════════
-- The publish queue learns the Bureau's two differences (decision 0014)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 1. Disclosure: a Bureau publication carries a per-video decision (the bundle's
--    contains_synthetic_media — true only for a realistic money shot). `false` there is a
--    recorded decision, not an unset one, so it is not a blocker. Legacy rows keep the rule.
-- 2. Scheduling: a Bureau upload goes up private with publishAt = the slot, so a future
--    scheduled_for is the POINT of the upload, not a reason to wait.
-- 3. And it may not upload at all while channel_policy.youtube_api_audited is false — the
--    unaudited API caps uploads to private and the channel publishes by bundle instead. This
--    sits beside enforce_review_pass and enforce_channel_policy; it does not replace either.

create or replace view v_publish_queue as
 SELECT p.id AS publication_id,
    p.channel_id,
    p.render_id,
    p.title,
    p.status,
    p.scheduled_for,
    p.upload_attempts,
    p.upload_bytes_sent,
    p.upload_total_bytes,
    p.error_detail,
    p.altered_content_disclosed,
    rv.decision AS review_decision,
    r.status AS render_status,
        CASE
            WHEN rv.decision IS DISTINCT FROM 'pass'::text THEN 'review_not_passed'::text
            WHEN r.status IS DISTINCT FROM 'ready'::text THEN 'render_not_ready'::text
            WHEN p.episode_id IS NOT NULL AND NOT COALESCE((SELECT cp.youtube_api_audited FROM channel_policy cp WHERE cp.channel_id = p.channel_id), false) THEN 'youtube_api_unaudited'::text
            WHEN p.episode_id IS NULL AND p.altered_content_disclosed IS NOT TRUE THEN 'disclosure_not_set'::text
            WHEN p.episode_id IS NOT NULL AND (p.bundle ->> 'contains_synthetic_media') IS NULL THEN 'disclosure_not_set'::text
            WHEN NOT (EXISTS ( SELECT 1
               FROM integrations i
              WHERE i.slug = 'youtube'::text AND i.is_enabled AND i.last_verified_at IS NOT NULL)) THEN 'no_verified_publish_integration'::text
            WHEN NOT (EXISTS ( SELECT 1
               FROM v_api_quota q
              WHERE q.slug = 'youtube'::text AND q.units_remaining >= 1600)) THEN 'insufficient_quota'::text
            WHEN p.episode_id IS NULL AND p.scheduled_for IS NOT NULL AND p.scheduled_for > now() THEN 'scheduled_for_later'::text
            ELSE NULL::text
        END AS blocker
   FROM publications p
     JOIN renders r ON r.id = p.render_id
     LEFT JOIN reviews rv ON rv.id = p.review_id
  WHERE p.status <> 'live'::text AND p.platform = 'youtube'::text;

-- ═════════════════════════════════════════════════════════════════════════════
-- Metrics the Bureau pulls
-- ═════════════════════════════════════════════════════════════════════════════

alter table metrics_snapshots
  add column if not exists engaged_views_source text;

comment on column metrics_snapshots.engaged_views_source is
  'Which report produced engaged_views, because the Analytics API has named Shorts metrics '
  'more than once. Null when engaged_views is null.';

-- One snapshot per publication per age bucket already holds (unique since 0001), so the
-- metrics task upserts on it and the Studio CSV import fills viewed_vs_swiped_pct on the
-- same row rather than adding a second source row.

-- Character-name mentions per day, for the Metrics page trend and metrics_summary.
create view v_character_mentions as
select c.channel_id,
       (c.published_at at time zone 'Asia/Kolkata')::date as day,
       m.slug,
       count(*) as mentions
  from comments c
  cross join lateral unnest(c.character_mentions) as m(slug)
 where c.published_at is not null
 group by 1, 2, 3;

do $$
begin
  if to_regrole('anon') is not null then
    execute 'revoke all on public.v_character_mentions from anon, authenticated';
    execute 'revoke all on public.v_publish_queue from anon, authenticated';
  end if;
end $$;
