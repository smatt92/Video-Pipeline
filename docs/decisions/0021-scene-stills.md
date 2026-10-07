# 0021 — Scene stills: one generated picture per shot, nobody in it

Status: accepted · 2026-10-07 · extends 0015 (same vendor, same credit pool) · migration 0047

## Why

S001 rendered as abstract chalk templates. `overlay-scene.ts` draws eight seeded shapes
(orbit, graph, diagram…) that know nothing about the shot — "Earth with two tidal bulges",
"the Moon is missing from its hook" — so a viewer cannot relate the picture to the story.
Sahil chose (07-Oct-2026): **a generated still for every shot, with slow camera motion, and
NO generated characters** — the cast stays off-screen; no people, figures, faces or mascots in
any still.

## What

| | |
|---|---|
| Route | New `shots.render_route = 'still'`. At plan time every shot that is not a money shot becomes a still (`withStills`, shared by `planShots` and the brief estimate). Character and acted beats too — recorded as a plan swap, "the cast stays off-screen". |
| When unavailable | `stillsAvailability(db, channel)` — a probe of the rows, never a constant: 0047 not pasted (the `channel_policy.stills_enabled` column is the probe), the channel's switch off, the image integration unverified, or the rate unpriced. Unavailable → overlays exactly as before, with the reason in `episodes.qc.plan.stills`. |
| Prompt | The shot description is rewritten by the **fast tier** (`still_prompt`, Haiku) under `prompts/21-still.v1.ts`: remove every cast member and every action a person performs, keep the objects, place and idea. Then **code** checks it (`castNamesIn`: name, distinctive name word, slug; whole words, case-insensitive) and refuses a rewrite that still names the cast. Code — not the model — appends the bible's still style (`world.still_style`, or one built from the palette), the lead's accent, the bible's negative prompt and `no people, no characters, no faces, no figures, no text`. The Bureau's first style rule ("White chalk-line stick figures…") never reaches a still. |
| Image | `gen4_image` at `720:1280` through `drivers/still-image.ts` (the vendor-neutral face; core never names the vendor). 5 credits = USD 0.05, 0044's verified `image_720p` row. |
| Money | Per still: cap headroom read first; `generations` row (kind `image`) and a `cost_ledger` estimate (1 × the rate, stage `05-still`, key `still:<shot>:<attempt>`) **before** the call (rules 5, 6); a `measured` reconcile only when the terminal task reports its charge. |
| Wait | The vendor has no callback for any task (0013, 0015). A still takes seconds, so the episode step waits with the voice stage's bounded backoff (`waitForTask`: 5 s doubling to 20 s, 3-minute cap) rather than parking on the minute-cadence dispatcher. Recorded exception to rule 4, same reason as 0013. |
| Storage | Vendor URL → worker → bucket (`stills/<script>/<idx>-<attempt>.<ext>`, type sniffed from bytes), an `assets` row (kind `image`). Never through Vercel. |
| Failure | Refused rewrite, no cap room, vendor refusal, timeout, download failure → the shot becomes its overlay (`fallBackToOverlay`), and `{from: 'still', to: 'overlay', reason}` is appended to `episodes.qc.plan.swaps` — what Cuts already lists. The assembler does the same for a still shot with no stored image. |
| Render | `BureauShot { type: 'still', url, camera, accent, seed }`: `<Img>` full-bleed `cover`, a deterministic Ken Burns move from the shot's camera field (`ken-burns.ts`: pan, dolly-in, orbit, static; smoothstep; never shows an edge — asserted), the chalk grid at 35%, one short accent rule in the lead's colour. Captions and hook unchanged on top. The composite-first flow in `20-episode` is unchanged: stills are made before assembly. |
| Estimate | A still prices as one image (`planned = inr`, no re-roll allowance — nothing re-rolls a still). ≈ ₹4.40 at ₹88. The per-Short cap (₹150) and the daily/monthly caps still gate: `fitToCap` swaps stills to overlays last (video first, it costs more). |

## Trade-offs and decisions inside the decision

- **Stills count toward the overlay-share rule.** `overlay_min_share` keeps generated *motion*
  a minority of the runtime. A still is a picture with our camera move. Counting stills as
  generated would swap every still on an all-still Short back to an overlay — the exact cut
  this decision was made to stop. The rule now reads "drawn share (overlay or still)".
- **No still re-roll yet.** `shot_regenerate` on a still refuses by name. A re-run makes a
  still for any shot whose still is missing. The Cuts page still shows the Regenerate button
  for any non-overlay route; Prompt M should show it only for video routes.
- **Long-form scenes stay overlays.** Long-form is 16:9; a 9:16 still would be pillarboxed.
- **Character beats with stills unavailable** keep their old path (locked frame + active
  recipe, neither of which exists). Under this decision neither should be added.
- **Every still is the same model and ratio.** No recipe row in `prompts`: the template is the
  versioned prompt file and the composition is code. If a second still recipe is ever wanted,
  it belongs in the library.

## Verified

`test:bureau` (cast-name check, composition order, routing on/off, drawn share, cap swaps,
price parity with 0044, Ken Burns coverage) and `verify:episode` §8 (stub vendor: brief priced
on stills, every shot a still, the character beat's swap, the estimate row present at each
call — LOAD-BEARING, a cast-name rewrite never reaching the vendor, a refused still and a failed
still falling back with their swaps, measured reconciles, replay pays nothing, a 270×480
composite whose decoded frame is the still's colour). The one real still: 0008 §26.
