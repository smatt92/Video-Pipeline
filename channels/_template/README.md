# Channel bible template

Copied by `pnpm channel:new <slug>` into `channels/<slug>/`, which also rewrites `"channel"` in
`characters.json` to the slug and regenerates `src/lib/channels/registry.generated.ts`.

Edit every `REPLACE` before the channel drafts anything. Series ids must be values of the
`bureau_series` enum (incident, desk_tour, pip, archive, myth, deep, complaint, long_form, and
since 0052 evolution, inside) — a new id is a migration. A series may default to any video
type (`visual_format`), including `engineered` (the 3D explainer) with its `motion` (key/full).
Slot ids are global across channels (`S001…`, `B01…`): pick ids no other channel uses. `trends.json` names the subreddits and YouTube Data API category ids /
queries that stage 1 reads for this channel; empty lists mean that source is skipped for it.
Not every YouTube category has a most-popular chart in every region (Education, 27, has none
in IN — the API answers 404), and Google publishes no list; a category without one is recorded
on /trends as "no most-popular chart" each run while the others still land. Search it as a
query instead.
Google Trends, Wikipedia and Hacker News need no key and are read unless turned off:
`"google_trends": null`, `"wikipedia": null`, `"hn": null`. To tune them instead:
`"google_trends": {"geo": ["IN"]}`, `"wikipedia": {"languages": ["en", "de"], "top_n": 50}`,
`"hn": {"top_n": 30}`.

Since decision 0022 a channel's bible lives in the database. **+ Add channel** in the app
copies THIS template into `channel_bibles` / `channel_characters` — no folder, commit or
deploy. A folder under `channels/` is now only an import source (`pnpm bible:import`) and the
fallback for a channel with no database bible.
