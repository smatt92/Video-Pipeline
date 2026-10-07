# 0024 — "Cartoon characters": the cast on screen, drawn only from sheets Sahil locked

**Date:** 2026-10-07
**Status:** accepted — built and proven against a stub image vendor (`verify:characters`, CI);
one real sheet for Pip generated through the production path, not locked (0008 §31)
**Builds on:** 0015 (one image vendor), 0021 (scene stills), 0022 (bible in the database), the
video-type templates (`formats.ts`) and O2's redraw (`21-still.v4`).

## Why the cast was off-screen, and what changes

Every still prompt so far ended "no people, no characters, no faces, no figures": an unanchored
generation draws a different-looking person every shot (CLAUDE.md, "a guard that permits the
outcome its own message names"). Sahil asked (07-Oct 18:31 IST) for a fourth video type in which
Pip, Marlo, Mrs. Iyer and the rest appear as consistent cartoon characters. Consistency is the
whole feature, so the design has one rule: **a character is drawn in a picture only when its
locked sheet is passed to the image model as a tagged reference.** There is no branch that names
a character in a prompt without its sheet.

## Vendor facts, verified 07-Oct-2026

| Fact | Source |
|---|---|
| Text-to-image takes `referenceImages: [{ uri, tag }]`, **one to three** for `gen4_image_turbo` (required) and **up to three, optional** for `gen4_image` | SDK typings, `TextToImageCreateParams` — https://raw.githubusercontent.com/runwayml/sdk-node/main/src/resources/text-to-image.ts |
| A tag "is used to reference the image in prompt text. Must be 3-16 characters, start with a letter, and use only letters, digits, and underscores" | same |
| A `uri` is "a HTTPS URL, Runway upload URI, or base64 data URI (e.g. `data:image/png;base64,...`, up to 5MB)" | same |
| The prompt names a reference with `@` + its tag; "up to three active References for a single generation"; full-body consistency comes from describing the whole figure ("shoes or pants") | https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References |
| `promptText` ≤ 1000 UTF-16 code units | SDK typings (as before, `PROMPT_MAX`) |

The API reference page (`docs.dev.runwayml.com/api/`) returned only its navigation to the
fetcher, so the typings are the primary source; they matched what `video-runway.ts` already
enforced (≤ 3 references, the tag regex). Nothing believed in the brief was false. Not used: the
Gemini image models' `subject: 'human' | 'object'` reference hint (a different model and price).

## Decision

1. **Character sheets.** One canonical cartoon image per cast member, built in code from the
   bible (`prompts/22-character-sheet.v2.ts`: full body, front three-quarter, plain background;
   silhouette, props, head:body ratio, line weight, accent; a line of personality; the channel's
   still style; the negative list; Sahil's optional note). **The style is never cut**: v1 cut it
   to fit the 1000-character limit, and with the Bureau's bible every on-screen character ran
   over (1089–1101), so the one real sheet (Pip, v1) was drawn without the cartoon style. v2
   says the same in fewer words, cuts only the attitude line and its own extra negatives, and
   refuses ("shorten the note") rather than send a sheet prompt without the style. One `gen4_image` 720:1280 image,
   priced by the same verified rate row as a picture (USD 0.05 → ₹4.40 at ₹88). A character the
   bible says is never seen (`on_screen: false` — Director Ohm) gets an **object** sheet: the
   brass lamp, "no body, no arms, no hands, no face".
2. **Generate and lock are separate**, exactly like `frame:audition` / `frame:lock`. Library →
   Characters → "Generate sheet" (approver, `authorship_log` `character_sheet_request`) starts
   `27-character-sheet` on the worker; the sheet is a candidate. "Lock" writes the candidate's
   storage key into `channel_characters.reference_frame` — the field `pnpm frame:lock` writes —
   with `authorship_log` `reference_frame_lock` (what it replaced, which sheet) and a cast
   re-sync. A `PLACEHOLDER_*` reference is never a sheet. **Consequence:** a locked sheet is
   also the character's reference frame for a cinematic character beat — one locked look per
   character, not two.
3. **Video type `characters`** ("Cartoon characters"). Routes exactly as illustrated (every
   shot a picture, one per ~6 s), so it prices identically through the same estimator. The
   difference is the picture prompt (`21-still.v5`, v1–v4 kept): who is in each picture is
   decided by code (`picture-cast.ts`) — the speakers under that picture (longest first, from
   the timed takes; by character offset before timing) then the shot's characters. Each with a
   locked sheet is passed as a reference with its tag; the first is foregrounded; at most three.
   A character without one is **left out and recorded** (on the generation and in
   `qc.plan.cast`, shown on Cuts). The tags, props, accent and "no other people besides @…"
   are appended in code; `castNamesIn` still refuses any cast member not referenced in that
   picture. A picture with nobody referenced is drawn under v4, no people.
4. **No sheet anywhere → no characters format.** With none of the episode's cast locked,
   Approvals offers the type **disabled** with "no locked character sheets — Library →
   Characters", and the planner plans it as illustrated, recording `requested: 'characters'`
   and the reason. One predicate (`castAvailability`) serves both.
5. **Money.** Sheets: rule 5 (estimate before the call, measured reconcile), rule 6 (key
   `sheet:<channel>:<slug>:<request>`), the channel's caps, a `generations` row with no shot
   (`request_payload.purpose = 'character_sheet'`) and ledger rows carrying the channel — no
   migration. Pictures: unchanged, ₹4.40 each.
6. **The sheet URL** is minted at submit (`refResolver`: `storage:<key>` → presigned GET) and
   never stored. A run that cannot mint one draws nobody rather than the character without its
   sheet; a sheet that cannot be read refuses the picture before money moves.

## What is not decided here

Season gating (the Auditor "never appears before Season 2" is a `never_do` line, not a
mechanism — if his sheet is locked he can be drawn in Season 1); a sheet per pose or angle; using
more than one sheet per character.
