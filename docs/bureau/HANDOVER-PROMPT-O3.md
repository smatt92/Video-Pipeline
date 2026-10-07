# Handover — Prompt O3: Wikipedia and Hacker News as trend sources (07-Oct-2026)

Commit `be8c56f` on `main` (on top of O1 `e366668` and `d3f122f`). Register: `0008` §32.
**No migration** — `trend_signals.source` has no CHECK (0036); `trend_runs` (0049, O1) records them when pasted.

Waited for O1: its handover appeared on `origin/main` at ~13:59 UTC (≈1 h after start). Built on O1's
structure: `TrendSource` union, driver-per-source + mapper in `sources.ts`, `trend_runs` per-source result,
`verify:trends` stubs.

## What landed

| Piece | Where | What |
|---|---|---|
| Wikipedia driver | `src/lib/drivers/trends-wikipedia.ts` | `GET wikimedia.org/api/rest_v1/metrics/pageviews/top/{lang}.wikipedia/all-access/YYYY/MM/DD` for **yesterday UTC** (today is never published); second call for the day before → `velocity = views(d) − views(d−1)`, **null** if the article wasn't in that day's top 1000 or that call failed (said in `detail`). Non-articles out by namespace (`Main_Page`, `-`, `Special:`, `Wikipedia:`, `File:`, `Portal:`… any language; `Dune:_Part_Two` kept; cost: `Re:Zero`-style titles dropped). Top 50 per language. UA `kiln/0.1 (https://video-pipeline-seven.vercel.app/about; sahil.matt@gmail.com)` (also `Api-User-Agent`). 404/403/500/shape/timeout (8 s) each named. |
| HN driver | `src/lib/drivers/trends-hn.ts` | `topstories.json` → first N (default 30) `item/{id}.json`, concurrency 6, 8 s each. Keeps `type:'story'`, not dead/deleted, with title. `volume = score`, `velocity = score / max(1 h, age)` (same floor as Reddit). raw: `url`, `hn_url`, `by`, `descendants`, `rank`. Fails only if the id list fails or every item fails; partial item failures → ok + detail. |
| Mapping | `src/lib/trends/sources.ts` | `TrendSource` += `'wikipedia' \| 'hn'`; `fetchWikipedia`, `fetchHn`; free/keyless documented beside Reddit/YouTube. Region null for both (a language isn't a country; it's in `raw.lang`). |
| Run | `run.ts`, `01-trends.ts`, `run-now.ts` | `wikipedia` / `hn` in the payload; **absent → on** (defaults), **null → off** ("not configured: … turn Wikipedia off (wikipedia: null)"). Run now accepts a channel whose only source is Wikipedia/HN and carries the blocks exactly. Deps `wikipediaBaseUrl` / `hnBaseUrl` for stubs. |
| Config | `bible.ts` `TrendsConfigSchema` | `wikipedia: {languages: ["en", …] (1–5), top_n?: 1–200} \| null`, `hn: {top_n: 1–100} \| null`, both optional. Bureau of Reality's trends.json / DB row has neither → **both on by default**. O1 built no per-source toggle UI (config is the trend-sources JSON), so none added; `_template/README.md` documents the fields. |
| Screens | `/trends`, `read.ts`, `runs.ts`, `recent.ts` | Channel panel lists Wikipedia + Hacker News (on/off/defaults); Latest run labels them and shows an ok-with-note detail; source health panel lists both; `trends_recent` links Wikipedia article / HN story (or discussion). |
| Harness | `verify:trends` §15 (+ §6 refusal/accept updated, §13 source list) | Seeded feeds → exact rows (3 of 8 Wikipedia pages; views, change incl. null and negative; URL, rank; 2 of 5 HN items; 600 in 3 h = 200/h; 10-min-old story floors to 30/h). Requests: yesterday + day before, UA asserted. Day-before 404 → velocity all null + note. Config languages/top_n honoured. Wikipedia 500 → named on result **and** `trend_runs`, HN lands 3; HN 500 → named, Wikipedia lands 3. null → off by name. 0 `cost_ledger` rows. |

## Verified

- `pnpm check` exit 0 (before commit and after rebase onto `d3f122f`).
- Local Postgres 16, fresh DB each: `verify:trends`, `verify:bureau`, `verify:concepts`, `verify:outlier`, `verify:channel-bible` all exit 0 (channel-bible first failed on missing `espeak-ng` in this container — same on the base commit; green after installing it).
- **CI run 200 on `be8c56f`: success** — step list read; "Stage 1 — trend intake…" step green, Build and every later step green.

## NOT done — the deploy and the real run

- **Worker deploy was refused in this session**: dispatching `trigger-deploy.yml` was denied by the session's permission layer (production deploy). Not worked around. So the deployed worker is still `d3f122f` (run 25) and **does not contain the Wikipedia/HN code**.
- Therefore **no real run**, and no hosted rows. Hosted `trend_signals` (Supabase MCP, select only, 14:3x UTC): `google_trends` 15 (latest 14:25 — O1's RSS works for real), `youtube` 50, `wikipedia` 0, `hn` 0.
- WebFetch of the Wikimedia endpoint needed a permission nobody was there to answer, so the endpoint/shape is from Wikimedia's docs, not a captured response. The Zod parse is strict; a difference shows by name on /trends.

## What Sahil must do

| # | Step |
|---|---|
| 1 | Actions → **Deploy worker (Trigger.dev)** → Run workflow on `main`, `dry_run_only` = false. Check it says "Successfully deployed version …" |
| 2 | /trends → **Run now** for Bureau of Reality (no spend). Latest run should list Wikipedia ≈50 and Hacker News ≈25–30 (if 0049 is pasted; otherwise the rows are the evidence) |
| 3 | Confirm: `select source, count(*) from trend_signals where captured_at > now() - interval '1 hour' group by 1;` → `wikipedia` and `hn` rows. Or the scheduled run (00:40/06:40/12:40/18:40 UTC) does it on its own once deployed |
| 4 | Optional: drop Reddit for this channel by emptying `subreddits` (it refuses without an approved app anyway) |

## Unverified

Real Wikimedia + HN responses (closes with step 2–3); namespace heuristic on non-English wikis against real data; Vercel production showing the new /trends lines (same `next build` as CI).
