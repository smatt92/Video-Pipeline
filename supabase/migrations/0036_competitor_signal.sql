-- Migration 0036 — competitor signal, and a table that must never learn to hold a sentence
--
-- ─────────────────────────────────────────────────────────────
-- Addendum 04, §1, §2 and the safe half of §6. Queued since it was written; unblocked now
-- that stage 10 gave this codebase a quota mechanism that counts.
-- ─────────────────────────────────────────────────────────────
--
-- ── Why this outranks the scoring it sits beside ─────────────────────────────
--
-- `concepts.scores` rates an idea on velocity, saturation, IP risk and evergreen tail —
-- four reasonable guesses made before the fact. An outlier score measures something that
-- already happened: a video's views against its own channel's typical performance. 66k
-- views on a channel that usually gets 1k is not a video that succeeded because a large
-- channel published it; it is a video whose *idea* carried it, and that is the only signal
-- in this space grounded in an observed outcome rather than a prediction.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The channels we watch, and what we know about each
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `uploads_playlist_id` is not a convenience column. Addendum 04 is explicit about the
-- quota arithmetic and it is the difference between a daily poll that fits and one that
-- does not: reading a channel's uploads playlist costs **1 unit**; finding the same videos
-- through `search.list` costs **100**. Twenty channels daily is 20 units one way and 2,000
-- the other, against a 10,000/day allowance shared with uploads at 1,600 each.
--
-- Storing the playlist id means the cheap path is the only one available — a poller that
-- has to look the channel up each time is a poller somebody will one day rewrite to use
-- search because it is fewer lines.

create table tracked_channels (
  id                    uuid primary key default gen_random_uuid(),
  external_channel_id   text not null unique,
  title                 text not null,
  niche                 text not null,
  -- Resolved once at add time, then reused for ever. See above.
  uploads_playlist_id   text,

  -- ── The baseline, and why it is null far more often than it is a number ───
  --
  -- Null until the channel has enough videos for a median to mean anything. Addendum 04
  -- says ten; below that the "typical performance" of a channel is one or two videos and
  -- an outlier score against it is arithmetic on noise.
  --
  -- Absent is not zero, in the place where zero would be most damaging: a baseline of 0
  -- makes every outlier score infinite, which would put a brand-new channel's first video
  -- at the top of the ideas list for ever.
  baseline_median_views bigint check (baseline_median_views is null or baseline_median_views >= 0),
  baseline_video_count  integer not null default 0 check (baseline_video_count >= 0),
  baseline_computed_at  timestamptz,

  is_active             boolean not null default true,
  added_at              timestamptz not null default now(),
  last_polled_at        timestamptz,
  -- A poll that failed is a row, not a silence. Same reasoning as everywhere else here.
  last_error            text,
  poll_failures         integer not null default 0 check (poll_failures >= 0)
);

create index on tracked_channels (niche) where is_active;

comment on column tracked_channels.uploads_playlist_id is
  'The channel''s uploads playlist. Stored rather than looked up because reading it costs 1 '
  'quota unit and finding the same videos through search.list costs 100 — twenty channels '
  'daily is 20 units against 2,000. Keeping the cheap path the only available one is what '
  'stops somebody rewriting the poller to use search because it is fewer lines.';

comment on column tracked_channels.baseline_median_views is
  'Median views over the channel''s recent uploads, or NULL when there are fewer than ten '
  'to take a median of. Null rather than 0 in the one place where 0 is most dangerous: it '
  'is the divisor of every outlier score, so a zero baseline would make a new channel''s '
  'first video infinitely exceptional and pin it to the top of the ideas list.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The videos, and the score
-- ═════════════════════════════════════════════════════════════════════════════

create table competitor_videos (
  id                   uuid primary key default gen_random_uuid(),
  tracked_channel_id   uuid not null references tracked_channels(id) on delete cascade,
  external_video_id    text not null unique,
  title                text not null,
  published_at         timestamptz not null,
  views                bigint check (views is null or views >= 0),

  -- views ÷ the channel's baseline, at the moment it was computed. Null when the channel
  -- has no baseline — which is the common case and must not read as "scored zero".
  outlier_score        numeric check (outlier_score is null or outlier_score >= 0),
  -- The baseline this score was computed against, copied in. Without it a score is
  -- uninterpretable a month later: the channel's baseline moves, and 50× against a
  -- thousand and 50× against a hundred thousand are different findings.
  scored_against_views bigint,
  computed_at          timestamptz,

  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now()
);

create index on competitor_videos (tracked_channel_id, published_at desc);
create index on competitor_videos (outlier_score desc nulls last) where outlier_score is not null;

comment on column competitor_videos.scored_against_views is
  'The baseline the score was computed against, snapshotted. A bare multiple is '
  'uninterpretable later — 50× a thousand and 50× a hundred thousand are different '
  'findings — and the channel''s baseline moves under it.';

comment on column competitor_videos.views is
  'Null means the view count could not be read, which is not zero views. Every consumer '
  'that averages or ranks must exclude nulls rather than coalesce them.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. pacing_template — structure only, and the guard is the point
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Addendum 04 §6 rejects feeding competitors' transcripts to the script writer, and the
-- reason is not squeamishness: YouTube's inauthentic-content policy names readings of
-- material you did not create as an explicit violation, and this project's own script
-- provenance record would be the evidence against it in an appeal.
--
-- The safe version keeps most of the value — extract how many beats, how long the hook
-- runs, where the first tension release falls, the ratio of claim to example. Numbers and
-- shapes, no text.
--
--   **Structure is not copyrightable. Sentences are. That distinction is the whole thing.**
--
-- So every column here is numeric or a closed enum, and there is deliberately no `notes`,
-- no `summary`, no `raw`, no jsonb. The failure this prevents is not somebody maliciously
-- pasting a transcript. It is somebody adding `source_excerpt text` in eight months for a
-- perfectly good debugging reason, and the line being crossed by a column comment nobody
-- reads.
--
-- `check:pacing-columns` fails the build if a text, varchar, char, json or jsonb column is
-- ever added to this table. That is a guard for a state no write path produces, which this
-- codebase normally treats as a defect — and this is the documented exception, because the
-- point is not that the state is reachable today but that **none ever should be**. The
-- guard is the specification.

create table pacing_template (
  id                      uuid primary key default gen_random_uuid(),
  -- Which video it was measured from, by reference. The id is a foreign key rather than a
  -- copied string precisely so that nothing here needs to carry anything about content.
  competitor_video_id     uuid not null references competitor_videos(id) on delete cascade,

  beats                   integer not null check (beats > 0),
  hook_seconds            numeric not null check (hook_seconds > 0),
  first_release_seconds   numeric check (first_release_seconds is null or first_release_seconds >= 0),
  claim_to_example_ratio  numeric check (claim_to_example_ratio is null or claim_to_example_ratio >= 0),
  shot_changes            integer check (shot_changes is null or shot_changes >= 0),
  mean_shot_seconds       numeric check (mean_shot_seconds is null or mean_shot_seconds > 0),
  total_seconds           numeric not null check (total_seconds > 0),

  -- Closed vocabularies, not free text. An enum is a shape; a string is a sentence waiting
  -- to happen.
  cta_position            text check (cta_position in ('none', 'early', 'mid', 'end')),
  arc                     text check (arc in ('problem_solution', 'list', 'story', 'demonstration', 'contrarian')),

  measured_at             timestamptz not null default now(),
  -- Which extractor produced it, as concepts.rubric_version does. A version string is a
  -- version string; it is not a place to put prose, and check:pacing-columns does not care
  -- what the column is for — it is text, so it is the exception that has to be named.
  extractor_version       text not null
);

create index on pacing_template (competitor_video_id);

comment on table pacing_template is
  'Structure extracted from a high-performing video: counts, durations and ratios, never '
  'words. Addendum 04 §6 — structure is not copyrightable and sentences are, and a text '
  'column would cross that line silently. check:pacing-columns fails the build if one is '
  'added. That guard protects a state no write path produces, deliberately: the point is '
  'not that it is reachable but that none ever should be.';

comment on column pacing_template.extractor_version is
  'The one text column, and it is on the guard''s explicit exemption list. A version string '
  'names the code that measured, not the video that was measured. Any OTHER text column is '
  'a build failure.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. What reads this — the leaders, and the silence
-- ═════════════════════════════════════════════════════════════════════════════

create view v_outlier_leaders as
select
  cv.id                       as competitor_video_id,
  tc.id                       as tracked_channel_id,
  tc.title                    as channel_title,
  tc.niche,
  cv.title,
  cv.external_video_id,
  cv.published_at,
  cv.views,
  cv.outlier_score,
  cv.scored_against_views,
  cv.computed_at,
  now() - cv.published_at     as age
from competitor_videos cv
join tracked_channels tc on tc.id = cv.tracked_channel_id
where cv.outlier_score is not null
  -- Addendum 04: recent only. An outlier from three years ago describes an audience that
  -- has moved on, and it would sit at the top of the list for ever because nothing ages it
  -- out of a plain ORDER BY.
  and cv.published_at > now() - interval '90 days'
  and tc.is_active
order by cv.outlier_score desc;

comment on view v_outlier_leaders is
  'Recent videos that beat their own channel, best first — the ideas list. Scored rows '
  'only and 90 days only: an unscored video is not a weak one, and a three-year-old '
  'outlier describes an audience that has moved on but would otherwise sit at the top for '
  'ever.';

-- The instrument that reads the silence. `v_outlier_leaders` cannot show a channel that
-- has never been polled or has no baseline — such a channel contributes no rows at all,
-- so the leaderboard reads as complete while describing a fraction of what is tracked.
-- Same shape as v_hook_unclassified, for the same reason.
create view v_tracked_channel_health as
select
  tc.id                         as tracked_channel_id,
  tc.title,
  tc.niche,
  tc.is_active,
  tc.last_polled_at,
  tc.poll_failures,
  tc.last_error,
  tc.baseline_median_views,
  tc.baseline_video_count,
  tc.baseline_computed_at,
  (select count(*) from competitor_videos v where v.tracked_channel_id = tc.id)
                                as videos_known,
  (select count(*) from competitor_videos v
    where v.tracked_channel_id = tc.id and v.outlier_score is not null)
                                as videos_scored,
  -- The first reason this channel contributes nothing, earliest cause first. Null means it
  -- is contributing normally.
  case
    when tc.uploads_playlist_id is null            then 'no_uploads_playlist'
    when tc.last_polled_at is null                 then 'never_polled'
    when tc.baseline_video_count < 10              then 'too_few_videos_for_a_baseline'
    when tc.baseline_median_views is null          then 'no_baseline'
    when tc.baseline_median_views = 0              then 'baseline_is_zero'
    when not exists (
      select 1 from competitor_videos v
       where v.tracked_channel_id = tc.id
         and v.outlier_score is not null
         and v.published_at > now() - interval '90 days')
                                                   then 'nothing_recent_scored'
    else null
  end                           as blocker
from tracked_channels tc;

comment on view v_tracked_channel_health is
  'Why a tracked channel contributes nothing to the ideas list. Necessary because a '
  'channel with no baseline is absent from v_outlier_leaders entirely rather than '
  'under-represented in it — the leaderboard reads as complete however many are missing. '
  'baseline_is_zero is listed separately from no_baseline because they need opposite '
  'responses: one is a channel nobody watches, the other is a measurement not yet taken.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. `source = 'outlier'` on trend_signals
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Free, as Addendum 04 notes: the column has no CHECK, so nothing needs altering. Recorded
-- here anyway rather than left as folklore, because a value with no constraint and no
-- migration mentioning it is a value nobody can find the definition of.
--
-- Addendum 04 §5: competitor channels do not replace the other trend sources, they outrank
-- them — they measure what works on the platform rather than what people search for.

comment on column trend_signals.source is
  'Where the signal came from. No CHECK, deliberately: sources are added by writing them. '
  'Known values are the feed sources plus ''outlier'' (migration 0036), which is a video '
  'that beat its own channel — an observed outcome rather than a search volume, and '
  'therefore ranked above the others when concepts are generated.';

notify pgrst, 'reload schema';
