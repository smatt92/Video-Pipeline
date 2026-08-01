-- Migration 0004 — audio-first timing
--
-- Source: docs/addenda/02-audio-lane-settings-ia-design.md §1.
--
-- This migration encodes a reordering of the DAG, not just new columns. Stage 6 (voice)
-- now runs *ahead* of stage 5 (generate): the VO is synthesised first, its word timings
-- define the beat boundaries, and those boundaries set `shots.duration_s`. Video is then
-- generated to fit real speech instead of speech being stretched to fit video.
--
-- The reason is economic. VO costs roughly a hundredth of video generation, so a bad
-- duration estimate should be paid for by regenerating the cheap artifact, not the
-- expensive one. Let the cheap artifact define the timeline the expensive one satisfies.

-- ─────────────────────────────────────────────────────────────
-- 1. Shot durations become derived
-- ─────────────────────────────────────────────────────────────

alter table shots
  add column duration_source text not null default 'authored'
    check (duration_source in ('authored', 'derived_from_vo'));

comment on column shots.duration_source is
  'authored = a human or the script model picked this number. derived_from_vo = it was '
  'computed from word timings and reflects real speech. When a shot looks mistimed, this '
  'column tells you whether the estimate was the problem or the delivery was.';

-- ─────────────────────────────────────────────────────────────
-- 2. VO takes and word timings
--
-- One row per synthesis call. Long scripts are chunked (200–500 words) because language
-- and accent drift on long single generations is a documented, repeatable failure, so a
-- script's VO is several rows ordered by chunk_idx with a cumulative offset_s.
-- ─────────────────────────────────────────────────────────────

create table vo_takes (
  id                uuid primary key default gen_random_uuid(),
  script_id         uuid not null references scripts(id) on delete cascade,
  chunk_idx         int not null default 0,
  driver            text not null,
  model             text not null,
  voice_id          text not null,
  language          text not null default 'en',
  text_in           text not null,
  asset_id          uuid references assets(id),
  -- derived from normalized_alignment, not the raw alignment
  word_timings      jsonb not null default '[]',   -- [{w, start, end}]
  offset_s          numeric not null default 0,    -- cumulative offset when chunked
  characters_billed int,
  cost_inr          numeric,
  seed              bigint,
  created_at        timestamptz not null default now(),
  unique (script_id, chunk_idx, language)
);

create index on vo_takes (script_id, language, chunk_idx);

comment on table vo_takes is
  'One synthesis call. A script''s full VO in one language is every row for that script '
  'ordered by chunk_idx, each shifted by its offset_s.';

comment on column vo_takes.word_timings is
  'Word-level timings derived from the vendor''s NORMALIZED alignment — what was actually '
  'spoken ("$5" → "five dollars"), not what was typed. Burned-in captions read from this, '
  'so using the raw alignment would caption text the viewer never hears.';

comment on column vo_takes.offset_s is
  'Seconds to add to every timing in this chunk to place it on the script timeline. '
  'Chunk 0 is 0; each later chunk carries the summed duration of everything before it.';

comment on column vo_takes.language is
  'Language variants are generated natively with the cloned host voice, not dubbed — '
  'dubbing returns no word timings, and without timings there are no derived durations '
  'and no free captions.';

-- ─────────────────────────────────────────────────────────────
-- 3. Audio generations need a home in the cost ledger too
--
-- `generations.kind` already allows 'audio', and cost_ledger already keys on
-- generation_id. Nothing new is required for VO to be costed — which is the point of the
-- shared result-and-cost shape. This is a note, not a change.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- 4. Audio driver integration slot and rates
--
-- Concurrency is the throttle unit for the audio vendor, not requests-per-minute, and the
-- ceiling is a hard per-tier number (Free 2, Starter 3, Creator 5, Pro 10, Scale 15,
-- Business 15). It lives in the integration record so the Trigger task reads its limit
-- from the database. A hardcoded concurrency produces a permanent failure rate that looks
-- like a flaky vendor.
-- ─────────────────────────────────────────────────────────────

insert into integrations (slug, kind, is_enabled, config)
values (
  'elevenlabs',
  'audio',
  false,
  jsonb_build_object(
    'tier', null,               -- set from settings; drives max_concurrency
    'max_concurrency', null,    -- null = unknown, and unknown must not be guessed
    'chunk_words', 350,
    'normalization', 'auto'
  )
)
on conflict (slug) do nothing;

-- Unverified, like every other seeded rate. Per-1000-characters is the vendor's billing
-- unit; `unit` is 'character' and quantity is the character count.
insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from)
values
  ('elevenlabs', 'eleven_multilingual_v2', '/v1/text-to-speech/with-timestamps', 'character', 0.0, 'USD', false, 'placeholder — read actual billing off the account', '1970-01-01T00:00:00Z'),
  ('elevenlabs', 'eleven_v3',              '/v1/text-to-speech/with-timestamps', 'character', 0.0, 'USD', false, 'placeholder — read actual billing off the account', '1970-01-01T00:00:00Z'),
  ('elevenlabs', 'eleven_flash_v2_5',      '/v1/text-to-speech/with-timestamps', 'character', 0.0, 'USD', false, 'placeholder — read actual billing off the account', '1970-01-01T00:00:00Z')
on conflict (driver, model, coalesce(endpoint, ''), effective_from) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 5. Pronunciation dictionary
--
-- Not in the addendum's SQL, but §2 requires "an editable table, because you will add
-- entries weekly", and the settings page needs somewhere to write. Phoneme tags only
-- apply on some models; others silently ignore them, which is why `kind` distinguishes
-- an alias substitution from a phoneme rule rather than assuming one works everywhere.
-- ─────────────────────────────────────────────────────────────

create table pronunciations (
  id            uuid primary key default gen_random_uuid(),
  grapheme      text not null,                 -- the written form, e.g. 'GTA'
  kind          text not null check (kind in ('alias', 'phoneme')),
  replacement   text not null,                 -- alias text, or the phoneme string
  alphabet      text check (alphabet in ('cmu', 'ipa')),
  language      text not null default 'en',
  notes         text,
  created_at    timestamptz not null default now(),
  unique (grapheme, language, kind)
);

comment on table pronunciations is
  'Indian place names, brand names and gaming acronyms are mispronounced by default. '
  'CMU is more predictable than IPA. Vendors cap the number of dictionary locators per '
  'request (3), so this table is a source to compile from, not a list to send wholesale.';

comment on column pronunciations.kind is
  'phoneme rules are honoured only by some models and silently ignored by the rest; '
  'alias substitution works everywhere. Prefer alias unless the model is known to support '
  'phonemes, because a silently ignored rule is worse than an ugly one that works.';
