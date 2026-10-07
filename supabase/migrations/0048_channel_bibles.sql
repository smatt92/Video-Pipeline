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
