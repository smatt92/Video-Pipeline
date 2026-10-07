# Kiln — Studio Redesign (Claude Design canvas)

Source: https://claude.ai/artifact/1D36uutL8KGg1DZm6JWpyk (version 1791344573-adbe, 07 Oct 2026).
Copied verbatim from the canvas's `project/` folder. `kiln.css` is the token + component sheet every
artboard links; the `.dc.html` files are the artboards (Design Component pages — markup inside
`<x-dc>`, sample data in each file's `renderVals()`). These are the design reference, not app code.

## Artboard → route map

| Artboard (desktop / mobile) | Route in Kiln | Notes |
|---|---|---|
| Main (tokens), Components, Palette | `src/styles/tokens.css`, shared components, ⌘K palette | `kiln.css` `:root` is the new token set |
| Rail, TabBar | `src/components/shell/sidebar.tsx`, mobile tab bar | channel switcher at top, kill switch + user at foot |
| AllChannels / -m | `/` with "All channels" selected | combined home, per-channel caps never pooled |
| More-m | mobile "More" sheet + channel switcher | |
| Home / -m | `/` (channel home) | next slot countdown, needs-you, spend, stages |
| Approvals / -m | `/bureau/approvals` | punchline picker A/B/C, approve disabled until picked |
| Board / -m | `/bureau/board` | stage columns, blocker sentence + one action |
| Cuts / -m | `/bureau/cuts` | 9:16 player, shot scrub, LUFS, approve / send back |
| Ready / -m | `/bureau/ready` | YouTube + Instagram bundles |
| Calendar / -m | `/bureau/calendar` | |
| Generation / -m | `/bureau/monitor` | |
| Metrics / -m | `/bureau/metrics` | |
| Costs / -m | `/costs` | |
| Authorship / -m | `/bureau/authorship` | |
| Integrations / -m | `/settings` (integrations) | |
| Voices / -m | `/library/voices` | Prompts and Music reuse this layout |
