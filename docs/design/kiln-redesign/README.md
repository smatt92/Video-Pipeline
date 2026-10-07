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

## Update — brand v2 and onboarding (canvas version 1791346901-1716, 07 Oct 2026)

`BrandChanges` is the change log; read it first. Brand v2 is additive: same surfaces, states, cast, fonts
and components; new logo (solid arch mark + lowercase "kıln" wordmark with teal square tittle), teal ramp
`--ac-100…900`, paper set for email/PDF, motion tokens (`--e-out`, `--e-io`, `--e-fire`; 120/200/320/600 ms),
witness-cone run progress (replaces the 4-segment bar on cards; flat bar stays in tables), the kiln 3D object
(app level only — never with the Bureau building on one screen), and a voice & tone guide.

| Artboard | Where it lands |
|---|---|
| BrandSheet, BrandLogo, BrandColor, BrandType, BrandMotion, BrandObject, BrandVoice | tokens, `src/app/icon.*`, favicon, PWA manifest, splash/login, copy rules |
| BrandApplied, BrandAppliedMobile | rail header, sign-in splash, firing tile, blocker, bundle card, email + PDF bundle cover, push copy |
| OnbSpine | onboarding progress spine (what blocks the first video, one sentence each; resume) |
| Onb-Start, Onb-Studio, Onb-Models, Onb-Runway, Onb-Rates, Onb-Connections | `/setup/*` studio-level steps (env found/missing, Save and test, last-4 only) |
| Onb-ChBasics, Onb-ChCast, Onb-ChSchedule, Onb-ChCaps | the per-channel flow, also reached from "+ Add channel" |
| Onb-Finish | first-episode walkthrough |
| Onb-States | empty/error states for every step |
