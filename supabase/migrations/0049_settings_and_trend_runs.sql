-- 0049 — Settings for generation, assembly and publishing; and a record of every trend run.
--
-- Forward-only. Ten columns added to channel_policy and one new table. No row is rewritten:
-- every default below is exactly the constant the code used before this migration, so a
-- channel's next render is identical until somebody changes a value on /settings.
--
-- ── Why columns, not constants ───────────────────────────────────────────────
--
-- src/lib/settings/sections.ts: anything that would otherwise be a magic number lives in
-- Settings, changeable without a deploy. Each column is read through ONE function,
-- `readTuning` (src/lib/settings/tuning.ts), by every code path that used the constant — the
-- estimate, the stills step and the assembler for pictures; the voice stage for the gaps;
-- the assembler for loudness, text sizes and the hook. Until this file is pasted, that
-- function falls back to the same constants and every Settings screen says so.
--
-- ── Ranges ───────────────────────────────────────────────────────────────────
--
-- The CHECKs equal the Zod ranges in tuning.ts (TuningSchema). The database refusing what
-- the form also refuses is the point: a value written by SQL or by a future caller that
-- skips the schema cannot reach a render.

alter table channel_policy
  add column seconds_per_picture   numeric not null default 6     check (seconds_per_picture between 2 and 30),
  add column max_pictures_per_shot int     not null default 4     check (max_pictures_per_shot between 1 and 12),
  add column line_gap_s            numeric not null default 0.18  check (line_gap_s between 0 and 2),
  add column tail_s                numeric not null default 0.6   check (tail_s between 0 and 5),
  add column loudness_target_lufs  numeric not null default -14   check (loudness_target_lufs between -24 and -9),
  add column caption_scale         numeric not null default 0.032 check (caption_scale between 0.016 and 0.08),
  add column hook_scale            numeric not null default 0.05  check (hook_scale between 0.02 and 0.12),
  add column hook_s                numeric not null default 2     check (hook_s between 0 and 6),
  add column made_for_kids_default boolean not null default false,
  add column synthetic_disclosure  text    not null default 'auto' check (synthetic_disclosure in ('auto', 'always'));

comment on column channel_policy.seconds_per_picture is
  'Illustrated shots: narration seconds each generated picture covers (was SECONDS_PER_PICTURE). '
  'Read by the estimate, the stills step and the assembler through readTuning, so they agree.';
comment on column channel_policy.max_pictures_per_shot is
  'Illustrated shots: the most pictures one shot gets, however long it runs (was MAX_PICTURES_PER_SHOT).';
comment on column channel_policy.line_gap_s is 'Voice: silence between lines, seconds (was LINE_GAP_S).';
comment on column channel_policy.tail_s is 'Voice: hold after the last word, seconds (was TAIL_S).';
comment on column channel_policy.loudness_target_lufs is
  'Assembly: integrated loudness the VO is normalised to before the render (was LOUDNESS_TARGET).';
comment on column channel_policy.caption_scale is 'Assembly: caption font size as a fraction of frame height (was 0.032).';
comment on column channel_policy.hook_scale is 'Assembly: hook title font size as a fraction of frame height (was 0.05).';
comment on column channel_policy.hook_s is 'Assembly: seconds the hook title holds at the start (was 2).';
comment on column channel_policy.made_for_kids_default is
  'Publishing: the madeForKids value every bundle carries. false for a channel not made for children.';
comment on column channel_policy.synthetic_disclosure is
  'Publishing: auto = the altered/synthetic flag is set when any shot is realistic (the '
  'platform''s own definition); always = set on every bundle. There is no "never".';

-- ═════════════════════════════════════════════════════════════════════════════
-- trend_runs — what every source said on every run
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Hosted trend_signals held 50 rows, all from one source, and nothing said why the others
-- were silent: Reddit had started refusing unauthenticated reads, and an empty list from a
-- refusing source looks exactly like a quiet day. A run is now a row, and each source's
-- answer ({source, ok, count, detail}) is in it, so /trends can say "Reddit: refused 403"
-- instead of saying nothing.

create table trend_runs (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid references channels(id) on delete cascade,
  trigger     text not null check (trigger in ('schedule', 'now', 'harness')),
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  inserted    int not null check (inserted >= 0),
  updated     int not null check (updated >= 0),
  sources     jsonb not null check (jsonb_typeof(sources) = 'array')
);
create index on trend_runs (channel_id, finished_at desc);

comment on table trend_runs is
  'One row per stage-1 run per channel: each source''s ok/count/detail. Written by runTrends; '
  'read by /trends. Service role only.';

alter table trend_runs enable row level security;
