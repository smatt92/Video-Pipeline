# Channel bible template

Copied by `pnpm channel:new <slug>` into `channels/<slug>/`, which also rewrites `"channel"` in
`characters.json` to the slug and regenerates `src/lib/channels/registry.generated.ts`.

Edit every `REPLACE` before the channel drafts anything. Series ids must be values of the
`bureau_series` enum (incident, desk_tour, pip, archive, myth, deep, complaint, long_form) —
a new id is a migration. `trends.json` names the subreddits and YouTube Data API category ids /
queries that stage 1 reads for this channel; empty lists mean that source is skipped for it.

Since decision 0022 a channel's bible lives in the database. **+ Add channel** in the app
copies THIS template into `channel_bibles` / `channel_characters` — no folder, commit or
deploy. A folder under `channels/` is now only an import source (`pnpm bible:import`) and the
fallback for a channel with no database bible.
