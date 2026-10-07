# Handover — Prompt O5: YouTube partial failures, trend relevance, /trends redesign, voice overflow (07-Oct-2026)

Feature commit `7e25c69` on `main` (on top of O4's handover `8b3ab37`; waited for the O3 and O4
handovers — both on `origin/main` at 15:00 UTC, ≈ 25 min after start). Register: `0008` §33.
Migration **0051** — bundle **`docs/bureau/hosted-migrations-9-0051.sql`**. Code works before it is
pasted (every new column/table is probed; see "Before the paste").

## What landed

| | Item | Where |
|---|---|---|
| A | Each YouTube category and query is its own attempt; a failure is recorded by part (`{part, kind: no_chart\|error, detail}`) on the source result **and** on `trend_runs.sources[].failures`; the rest land. Only quota / key invalid / API disabled stop the source. All parts failing → `failed`. Status pill from one function `sourceStatus` (ok / partial / not configured / failed) | `drivers/trends-youtube.ts`, `trends/sources.ts`, `run.ts`, `runs.ts` |
| A | Config comment: no chart for 27 in IN, search it as a query | `bureau/bible.ts` (`category_ids`), `channels/_template/README.md`, /trends card |
| B | **0051**: `trend_signals.relevance` (+`relevance_scored_at`, CHECK −1..1, NULL = not scored), `trend_term_embeddings` (one embedding per term text), `channel_niche_vectors` (normalised mean of premise + series "name: template" + ≤60 calendar topics; rebuilt only when the sha256 of those texts changes), `trend_runs.relevance` (what the pass said), `channel_policy.relevance_threshold` (default **0.65**) and `voice_overflow` (default false) | `supabase/migrations/0051_…sql` |
| B | Scoring after the rows land (`scoreSignals`), embed only unseen terms, batches of 100 (reads 25 per `in()` for URL length). Refusal / no embedder / no niche → NULL + reason on the run | `trends/relevance.ts`, `run.ts`, `trigger/01-trends.ts` |
| B | Stage 2 reads **this channel's** signals (it read every channel's newest 25 before): ≥ threshold by relevance, then never-scored newest, never the below-threshold ones; 14-day window. trends_recent (connector) lists relevant first and returns `relevance` + `relevance_note` | `signalsForConcepts` in `relevance.ts`, `concepts/run.ts`, `trends/recent.ts` |
| B/D | Settings → Generation: **Voice** (overflow On/Off, honest text, price from rows) and **Trends relevance** (threshold). Approver only, Zod + CHECK, `authorship_log` before/after. Own reader `readChannelFlags`, apart from `readTuning`, so an unpasted 0051 never resets the 0049 values | `settings/channel-flags.ts`, `admin.ts` `updateChannelFlags`, `actions.ts`, `tuning-forms.tsx` (`target="flags"`), `settings/generation/page.tsx` |
| C | /trends redesigned: header (channel · last run · next collection · Run now); five source cards (pill + one sentence, per-part failures, signals last run, last capture, collapsed configuration; Reddit "Not configured — Reddit requires approval (Responsible Builder Policy); off by choice."); **For this channel** cards (term, source chip, relevance bar from threshold→1, volume/velocity with units, days seen); **Everything else (n)** collapsed with source filter + search — table at desktop (fixed columns, right-aligned, nowrap), stacked rows on a phone. Absent = "—" with the reason. Next collection from `trends/schedule.ts`, which the Trigger cron now imports | `app/(app)/trends/page.tsx`, `components/trends/signal-list.tsx`, `run-now.tsx`, `trends/schedule.ts`, `trends/read.ts` |
| D | Second model `eleven_multilingual_v2` in `drivers/voice-route.ts` (`OVERFLOW_TTS_MODEL`, `withModel`, `ttsRateKey`). **`voiceKey` includes `@model` when not the default** — v3 takes are never reused under v2 and vice versa; every existing take keeps its key. `synthLine` passes the route's model (it was the literal `'eleven_v3'`) | `voice-route.ts`, `voice-synth.ts` |
| D | `voiceWithOverflow` (lib, testable): main limited + on → whole episode on v2 (every speaker re-routed); v2 limited too → `wait`; off → `wait` exactly as before. The task's wait loop asks it again each try (main first). Re-speak priced before speaking at the v2 rate (existing respeak ledger logic, idempotency key now carries the model). `voice_detail.model`, `overflow`, `overflow_reason`, `respoken_lines`; Cuts note "Voiced on the second model — main model's daily limit" | `bureau/voice-overflow.ts`, `voice.ts`, `episode-steps.ts` `voiceStep`, `trigger/20-episode.ts`, `bureau/cuts/page.tsx` |

## The bundle to paste

`docs/bureau/hosted-migrations-9-0051.sql` — one transaction, version-guarded. Hosted is at 0050,
so it is the only one outstanding. Proved locally on a DB at 0050: applies; a second paste refuses
("Already applied: 0051"). Includes `notify pgrst, 'reload schema'`.

**Before the paste** (worker 20261007.18 is already running this code): relevance is not scored
(the run records "channel_niche_vectors could not be read"), trend_runs rows land without the
relevance note, /trends says "Relevance is not scored on this database yet: migration 0051…",
Settings shows both new controls disabled with that sentence, overflow is off, concepts fall back
to their old read (newest 25), trends_recent ranks by velocity. Nothing errors.

## YouTube 404 — root cause

Hosted `trend_runs` (select only): 14:25 and 14:31 UTC, `youtube ok:false count:25 "HTTP 404
notFound — Requested entity was not found."`; every stored YouTube row is `mostPopular, category
28`. So **28 answered (the 25 phone unboxings), 27 (Education) answered 404 in IN, and the first
error ended the loop** — both queries ("how does it work science", "physics explained") were never
asked. Google's videos.list doc lists `videoChartNotFound` (400, "The requested video chart is not
supported or is not available") — not this 404 — and publishes no per-region list of categories
with charts (developers.google.cn mirror read; the .com page needed a permission nobody could
answer). Both shapes are now "no_chart". 27 is kept in the config and said on /trends each run;
Sahil may drop it — the queries now run and are the better science signal.

## Relevance threshold: 0.65, and why

The niche vector is a centroid, so a term is compared with the channel's centre, not its best
topic; with this embedding model unrelated short texts typically sit ~0.5–0.6 against such a
centre and on-topic ones above ~0.65–0.7. **Not measured on our data** (no Gemini key reachable
here). /trends prints every score and the window's range under "For this channel", so after the
first scored run set it from the real spread in Settings → Generation.

## Decisions to know

| Decision | Why |
|---|---|
| Relevance embeddings **do** write a ledger estimate (stage `01-relevance`, via `ledgeredEmbedder`) | The prompt said "no cost row, as documented"; decision 0015 documents the opposite for every embedding (free key priced at the paid rate, `rate_card`), and the trends run reuses that one embedder. Fractions of a paisa per run. Missing FX rate or unverified Gemini key → not scored, said |
| No "Draft a concept" button | No path exists from a term: `requestConcepts` (stage 2, takes a seed) has no caller in the app; Bureau briefs come from calendar slots. Relevant signals reach drafting by being read first (stage 2, trends_recent) — the section says so |
| Below-threshold signals are dropped from stage 2, NULL ones kept after the relevant ones | Measured off-niche is the point of the score; unknown is not irrelevant |
| Overflow retries start from the main model | Its limit is a rolling 24 h; whichever pass completes has every line on one model (reuse is keyed by model) |

## Screens

`docs/design/kiln-redesign/screens/trends-1440.webp`, `trends-390.webp` (Everything else open),
`settings_generation-1440.webp` (new). Taken from local `next dev` against local Postgres via
PostgREST 12.2.3 + a stub auth endpoint, seeded by `screens/seed.sql` (now with a trend run —
YouTube partial, Reddit not configured — and 18 signals with relevance). `scrollWidth` = viewport
at both widths (no sideways scroll). Looked at before pushing.

## Verified

- `pnpm check` exit 0 (before commit). Local Postgres 16 + pgvector, fresh DB per run:
  `verify:trends` (§8b, §16, §11/§12 made tie-robust), `verify:concepts` (§9), `verify:settings`
  (§11), `verify:episode` (§7c), plus voice, bureau, channel-bible, characters, outlier, channels,
  limits, costs, studio, library, review — all exit 0. `check:drift/catalog/enums/duplicates` 0.
- **CI run 205 on `7e25c69`: success**, step list read — every step green incl. Stage 1, Settings,
  Concepts, Bureau episode end to end, Build, display scaling, tour.
- **Worker deploy run 28: success** — "Successfully deployed version 20261007.18 … 22 detected
  tasks" (deployed `main` at `b3ce67a`, which contains `7e25c69` plus other sessions' commits).

## What is unverified

| Item | Closes with |
|---|---|
| Real embeddings + the real score spread; threshold fit | Paste bundle 9 → Run now on /trends → read "For this channel" + range; adjust threshold |
| The second TTS model on the real vendor; its separate 50/day limit (Sahil's statement) | First real overflow, with the toggle on |
| A real overflowed episode end to end; the Cuts note in a browser | Same |
| Redesigned /trends and Settings signed in on Vercel | Open /trends and /settings/generation |
| A real YouTube run now asking the queries after 27's 404 | Next scheduled run (00:40 UTC) or Run now — the YouTube card should read "partial", category 27 named |
| Over-statement left as is: a main-model pass that must re-buy a voice change and is then refused by the limit writes its re-speak estimate before the refusal (existing behaviour; deduped on retry) | — |

## Note on the commit

`7e25c69`'s message ends with a `Claude-Session:` line, added from a session default before the
prompt's "no AI attribution" rule was applied. It is on `main` and was not rewritten (no force push
on a shared branch); later commits carry none.

## What Sahil does

1. Supabase → SQL Editor → paste `docs/bureau/hosted-migrations-9-0051.sql` → Run → "Success. No rows returned".
2. /trends → **Run now**. YouTube should be **partial** (category 27 named) with the queries' videos landed; "For this channel" fills once Gemini scores (needs the Gemini integration verified and a USD→INR rate).
3. Settings → Generation → **Trends relevance**: set the threshold from the range printed under the cards.
4. Settings → Generation → **Voice**: turn **Voice overflow** on if you want episodes not to wait.
