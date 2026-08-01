-- Migration 0012 — a VO take has to remember its request id, and how long it turned out
--
-- ** SECTION 1 IS A SPECIFICATION ERROR **, the same class as `shots.vo_char_start` in 0009
-- and `cost_ledger_has_subject` in 0006: a document that specifies a mechanism and a schema
-- that cannot carry it, on the same page.

-- ─────────────────────────────────────────────────────────────
-- 1. Stitching needs the request id back
--
-- Addendum 02 §2: *chunk long scripts to 200–500 words and stitch with
-- `previous_request_ids`/`next_request_ids`.* The `vo_takes` table specified in §1 of the
-- same addendum, and implemented faithfully in 0004, has nowhere to put a request id.
--
-- So the stitching is unimplementable as written. Chunk 2 has to send chunk 1's request id
-- to inherit its prosody; nothing recorded chunk 1's request id. Without it every chunk is
-- an independent generation, which is exactly the language-and-accent drift the chunking
-- exists to avoid — and the failure is not an error, it is a voice that changes halfway
-- through and sounds like two people.
--
-- Nullable because a take can predate the column, and because a single-chunk script never
-- stitches to anything.
-- ─────────────────────────────────────────────────────────────

alter table vo_takes
  add column request_id text;

comment on column vo_takes.request_id is
  'Returned by the synthesis call, sent as previous_request_ids on the next chunk so '
  'prosody carries across the seam. Without it each chunk is an independent generation '
  'and the voice drifts mid-script — which is not an error, just two people.';

create index on vo_takes (script_id, chunk_idx) where request_id is not null;

-- ─────────────────────────────────────────────────────────────
-- 2. How long the take actually is
--
-- Derived from the last word timing, stored because it is read constantly — every
-- subsequent chunk's `offset_s` is the running sum of the ones before it, and recomputing
-- that from a jsonb array on every read is both slow and a second place for the arithmetic
-- to be spelled differently.
--
-- This is the evolution kind, not the specification kind: 0004 stored the timings, which is
-- everything needed to *derive* the duration. Storing the derivation is a convenience that
-- only became obvious once something had to sum across chunks.
-- ─────────────────────────────────────────────────────────────

alter table vo_takes
  add column duration_s numeric check (duration_s is null or duration_s >= 0);

comment on column vo_takes.duration_s is
  'Length of this take, from the end of its last word timing. Stored rather than derived '
  'because offset_s of every later chunk is the running sum of these, and two spellings of '
  'that sum is one too many.';

-- The audio the take produced. 0004 wired asset_id but nothing guarantees a take that
-- claims timings also claims audio — and timings without audio is a timeline for a file
-- that does not exist.
alter table vo_takes
  add constraint vo_takes_timings_need_audio
  check (word_timings = '[]'::jsonb or asset_id is not null);

-- ─────────────────────────────────────────────────────────────
-- 3. The voice leg's own view of readiness
--
-- Whether a script's VO is complete, and whether the shot durations were derived from it
-- or are still the shotlist's estimates. Stage 5 must not generate video against an
-- authored duration when a real one is available — that is the whole point of the
-- audio-first inversion.
-- ─────────────────────────────────────────────────────────────

create view v_script_vo_status as
select
  sc.id                                                     as script_id,
  sc.vo_text,
  length(sc.vo_text)                                        as vo_chars,
  count(vt.id)                                              as takes,
  coalesce(sum(vt.duration_s), 0)                           as total_duration_s,
  coalesce(sum(vt.characters_billed), 0)                    as characters_billed,
  bool_and(vt.request_id is not null) filter (where vt.id is not null) as fully_stitched,
  (select count(*) from shots s where s.script_id = sc.id)  as shots,
  (select count(*) from shots s
     where s.script_id = sc.id and s.duration_source = 'derived_from_vo') as shots_timed
from scripts sc
left join vo_takes vt on vt.script_id = sc.id
group by sc.id, sc.vo_text;

comment on view v_script_vo_status is
  'Per script: how much VO exists and how many shots have had their durations derived from '
  'it rather than estimated. shots_timed < shots means video would be generated against a '
  'word-count guess while a real measurement was available.';

-- ─────────────────────────────────────────────────────────────
-- 4. A pronunciation rule is not a pronunciation dictionary
--
-- ** ANOTHER SPECIFICATION ERROR **, third of this class.
--
-- Addendum 02 §2 says both of these on one page: *max 3 dictionary locators per request*,
-- and *this belongs in settings as an editable table* — implemented in 0004 as
-- `pronunciations`, holding grapheme, kind, replacement and alphabet.
--
-- Those are rules. The API takes **locators**: a `pronunciation_dictionary_id` and a
-- `version_id` identifying a dictionary that has been uploaded to the vendor. There is no
-- path from a row of rules to a request, because the rules have to be uploaded *as a set*
-- first and the vendor's returned identifiers recorded. Nothing recorded them, so the
-- locators required by the same paragraph were unobtainable.
--
-- The rules table is right and stays. What was missing is the thing it uploads *to*.
-- ─────────────────────────────────────────────────────────────

create table pronunciation_dictionaries (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  language             text not null default 'en',
  -- Returned by the vendor on upload. Null until a sync has actually happened, which is
  -- the honest state for a dictionary that exists only locally.
  vendor_dictionary_id text,
  vendor_version_id    text,
  synced_at            timestamptz,
  -- Rules change locally; the uploaded copy does not until it is re-synced. This is what
  -- makes "the dictionary is out of date" answerable rather than guessed.
  rules_changed_at     timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  unique (name, language)
);

comment on table pronunciation_dictionaries is
  'A set of rules uploaded to the vendor as one dictionary. The API references dictionaries '
  'by locator, not by rule, so this is what makes the rules in `pronunciations` reachable '
  'from a synthesis request at all.';

comment on column pronunciation_dictionaries.vendor_version_id is
  'Uploading a changed dictionary mints a new version. Both halves of the locator are '
  'required by the API, and sending a stale version silently applies the old rules.';

alter table pronunciations
  add column dictionary_id uuid references pronunciation_dictionaries(id) on delete cascade;

comment on column pronunciations.dictionary_id is
  'Which uploaded set this rule belongs to. Null means the rule exists locally and is in '
  'no dictionary, so it is applied to nothing — visible rather than silently ignored.';

create index on pronunciations (dictionary_id) where dictionary_id is not null;

-- Only a synced dictionary can be sent, and only its most recent sync.
create view v_pronunciation_locators as
select
  d.id,
  d.name,
  d.language,
  d.vendor_dictionary_id,
  d.vendor_version_id,
  d.synced_at,
  (select count(*) from pronunciations p where p.dictionary_id = d.id) as rules,
  d.synced_at is null                                                  as never_synced,
  d.synced_at is not null and d.rules_changed_at > d.synced_at         as stale
from pronunciation_dictionaries d
where d.vendor_dictionary_id is not null and d.vendor_version_id is not null;

comment on view v_pronunciation_locators is
  'Dictionaries that can actually be sent with a request. `stale` means the local rules '
  'have changed since the upload, so the vendor would apply the previous set — which '
  'presents as a fix that did not take rather than as an error.';
