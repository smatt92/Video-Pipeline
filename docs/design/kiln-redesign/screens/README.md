# Screens — the live app against the canvas

Every route and every setup page at 1440 × 900 and 390 × 844, full page, taken by
Playwright against a local Postgres seeded with `seed.sql` in this folder (two channels,
briefs, episodes, a publication, ledger rows, notifications, authorship). File names are the
route with `/` → `_`, then the width: `setup_cast-390.webp` is `/setup/cast` on a phone.

Every number on these screens comes from that seed through the same queries production
runs; where the seed has no row, the screen shows "—" and the reason, as it would live.

Where a screen differs from its artboard on purpose, the reason is in
`docs/bureau/HANDOVER-PROMPT-M.md` § (b).
