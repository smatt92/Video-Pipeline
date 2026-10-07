# 0022 — The channel bible lives in the database

Status: accepted · 2026-10-07 · supersedes 0019's "a bible is files in the repo" · migration 0048

## Why

"+ Add channel" required a `channels/<slug>/` folder, a commit and a worker deploy. A cast
member, a voice or a trend source was the same: an edit on a laptop, then two deploys. Vercel
cannot commit, so nothing about a channel's content could be changed from the app.

## What

**Tables (0048).** `channel_bibles` (channel_id PK, `world`, `publishing`, `series` — an object
keyed by series id —, `policy`, `trend_sources`, `version`, `updated_at`, `updated_by`) and
`channel_characters` (one row per cast member: slug, name, role, desk, accent, `voice`
`{provider, preset_id, direct_voice_id?}`, voice brief, visual lock, catchphrase, speech rules,
never-do, `reference_frame`, sort, active). RLS on, no policies — service role only, like 0046.
Vendor-neutral column and key names (rule 1); `drivers/voice-route.ts` maps the stored voice to
and from the bible's fields. `publishing` is a column of its own because the bible has it.

**One loader.** `getBible(db, channelId)` replaces `bibleForChannel` everywhere a caller holds a
channel id (brief creation and generation, script polish and parsing, voice, policy lint via the
MCP surface, variation, metrics, Instagram draft, long-form, trends). Database first, through
the same Zod schemas a folder passes; the folder only when the channel has no database bible,
with one log line per process. A database bible that fails its schema **throws by field** — it
never falls back silently to a folder that may say something else. Screens: `requireChannel`
reads it into a per-request map so the existing `bibleOrNull(channel)` callers see the database
bible without a change to `src/app`.

**Writes — approver only, Zod-validated, read back, versioned, logged.** `bible-admin.ts`:
`createChannel` (from the template, or a folder as template), `upsertCharacter`, `lockVoice`
(validated against `TTS_PRESET_IDS`), `setCharacterVoice` (the Voices screen), `updateSeries`,
`updatePolicy` (content policy and/or caps + the stills switch), `updateTrendSources`. Each
refuses any non-approver scope, re-reads the whole bible through `getBible` after writing,
bumps `version`, re-syncs the runtime mirror (`characters`) where the cast changed, and writes
one `authorship_log` row. `actions.ts` wraps them as server actions for the signed-in approver.

**Import.** `bibleRows` is the one row builder. `pnpm bible:import --db` uses it through
`importFolderBible` (insert-if-absent; never overwrites an app edit); `--sql` renders the same
rows as SQL for the hosted paste, appended inside the migration bundle's transaction
(`db-bundle.mjs --append`), with a guard that raises — rolling the paste back — if the slug
matches no channel or the cast did not land.

**Voice overrides (0046) fold into the cast.** One place for a voice: the import moves each
usable override into `channel_characters.voice` and deletes its row; an override the router
would refuse stays where the Voices screen shows its problem. `lockVoice` deletes a stale
override for that character. `pnpm voice:lock` now writes the database through `lockVoice`.
`pnpm frame:lock` writes both the folder and, with `DATABASE_URL`, the database row.

## Two tables for a cast — why not merged

`channel_characters` is what a person authors. `characters` (0037) is what the pipeline runs on:
the routed voice key, the usable reference frame, the driver — derived by `syncCast` from
whichever bible is in force. Folding authoring into the mirror would make every derived column
editable and every authored column overwritable by a sync. CLAUDE.md's "two modules for one
concept" is about two implementations of the same thing; these are a source and its
projection, and the projection is rebuilt from the source on every write.

## What stays in files

`channels/<slug>/` remains the import source and the fallback; `_template` is the template
`createChannel` copies. `check:channels` and the static registry stay. Prompts
(`20-bureau.v1.ts`), the `bureau_series` enum and workspace-wide integrations are still
single-workspace (0019).

## Verified

`verify:channel-bible` (CI): the Bureau imported equals its folder field by field (LOAD-BEARING,
both through the local import and through the SQL generated for the paste, each twice); an
override folded, an unusable one left; a slug with no channel raises; a second channel made
entirely through the actions with no folder, every refusal by name, every write logged; its
brief validated against the database cast, approved, scripted and voiced in the presets
`lockVoice` wrote. `verify:channels` §1 now adds its second channel through `createChannel`.
