# Handover — Prompt O4: "Cartoon characters", the cast on screen from locked sheets (07-Oct-2026)

Decision: `docs/decisions/0024-cartoon-characters.md`. Register: `0008` §31. **No migration, no
bundle to paste.** Built on O2 (redraw, `21-still.v4`) and O1 (0049 tuning), both on `main`
before this landed (O2's handover read; O1's settings merged in a rebase).

## What landed

| # | Item | Where |
|---|---|---|
| 1 | **Library → Characters** (new tab + sidebar): each cast member's locked sheet, its last 4 candidates (presigned thumbnails), tag (`@Pip`), "object only" for Ohm, **Generate sheet** (optional note, price on the button) and **Lock** under each finished candidate. One-time sheet price shown | `app/(app)/library/characters/page.tsx`, `components/library/character-sheet-controls.tsx`, `nav.ts`, `library-header.tsx` |
| 2 | Generate: approver only, `authorship_log` `character_sheet_request` (note verbatim), one in flight per character → **`27-character-sheet`** (worker, concurrency 1, no retry, replayable) → `generateCharacterSheet`: prompt from the bible (**`22-character-sheet.v2`**, v1 kept), cap read, **ledger estimate before the call**, key `sheet:<channel>:<slug>:<request>`, bytes worker → bucket `characters/<slug>/sheet-<id>.png`, assets row. A generation with no shot, `request_payload.purpose='character_sheet'`; ledger rows carry the channel | `lib/bureau/character-sheets.ts`, `trigger/27-character-sheet.ts`, `effects.ts`, `ui-actions.ts` |
| 3 | Lock: approver only; writes `storage:<key>` into **`channel_characters.reference_frame`** (the `frame:lock` field), `authorship_log` `reference_frame_lock` (from → to, which sheet), bible version bump, cast re-sync. Placeholders never count | `channels/bible-admin.ts` `lockReferenceFrame` |
| 4 | Video type **`characters`** — "Cartoon characters", "The cast appears as consistent cartoon characters, a new picture every ~6 s". Routes and prices exactly as illustrated | `formats.ts` (`PICTURE_FORMATS`) |
| 5 | Who is in each picture, decided in code: speakers under the picture (longest first — from the timed takes, or by character offset before timing) then the shot's characters; each with a locked sheet → a tagged reference (≤ 3, speaker in front); others **left out and recorded** on the generation (`cast_excluded`), in `qc.plan.cast`, and on Cuts. Ohm is "only the object in its reference — never a body" | `lib/bureau/picture-cast.ts`, `stills.ts` (`castClause`, `composeCharacterStillPrompt`), `episode-steps.ts` (`pictureSpansFor` speakers, `generateStills`), `redraw.ts` |
| 6 | Prompt **`21-still.v5`** for pictures with the cast (v1–v4 kept; v4 still draws every picture with nobody in it). Tags, props, accent and "no other people besides @…" appended in code; `castNamesIn` refuses anyone not referenced | `prompts/21-still.v5.ts` |
| 7 | No locked sheet in the episode's cast → Approvals shows the type **disabled**: "no locked character sheets — Library → Characters"; the planner plans it as **illustrated** and records `requested: 'characters'` + the reason (Cuts says so). One predicate for both (`castAvailability`). With some sheets, the note names who will be left out | `format-estimates.ts`, `approval-card.tsx`, `episode-steps.ts` `planShots`, `cuts/page.tsx` |
| 8 | Sheet URL minted at submit (`refResolver`, presigned GET), never stored; a run that cannot mint one draws nobody; a sheet that cannot be read refuses the picture before money moves | `picture-cast.ts`, `trigger/20-episode.ts`, `trigger/25-redraw.ts` |
| 9 | **`verify:characters`** (new, in CI) + `test:bureau` checks; **Sheet probe** workflow (`worker` / `function` / `show` — show spends nothing) | `scripts/verify-characters.mjs`, `scripts/sheet-probe.mjs`, `.github/workflows/sheet-probe.yml` |

## Vendor facts verified (07-Oct)

| Fact | Source |
|---|---|
| text-to-image `referenceImages: [{uri, tag}]`, **up to 3**, optional for `gen4_image` | https://raw.githubusercontent.com/runwayml/sdk-node/main/src/resources/text-to-image.ts |
| tag 3–16 chars, starts with a letter, letters/digits/underscores; "used to reference the image in prompt text" | same |
| uri: HTTPS URL, upload URI, or data URI ≤ 5 MB | same |
| prompt names a reference as `@tag`; up to three per generation | https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References |

Nothing in the brief was false. The API reference page returned only navigation to the fetcher.

## Pip's real sheet (the one real spend)

Generation `822abc6e…`, `characters/pip/sheet-822abc6e.png` (506 KB). Ledger: estimate ₹4.40
(rate_card) + measured reconcile 5 credits = ₹4.40, stage `05-sheet`. **Not locked**
(`reference_frame` still the placeholder). Run via the probe's `--via function` — the worker path
refused before spending because `TRIGGER_SECRET_KEY` has no readable value in Vercel production
(Sensitive); the lib function and rows are the same ones the task uses.

**What it looks like** (copy: `docs/bureau/sheet-pip-v1-108x192.jpg`): a clean thin-line cartoon
of a young intern, front-on, white top and trousers, white sneakers, an ID card on a cyan lanyard
(chest length — not past the knees), and a long **cyan scarf wrapped over the head like a
headscarf**, trailing to the knees. No forward lean. On a **cyan panel inside a white margin**,
not navy, with **"Pip" lettered across the top**.

Reading it back found two prompt defects, both fixed in **v2** before anything was locked:

| Defect (v1) | Cause | v2 |
|---|---|---|
| Not in the channel's bold cartoon style | v1 cut the style line to fit 1000 chars; with this bible **every** on-screen character ran over (1089–1101) | Style never cut; refuses ("shorten the note") instead. Asserted for all 8 |
| "Pip" lettered; panel + margin | the name and "reference sheet" in the prompt; background only as a hex | No name in the prompt; "no lettering, no panel, no border", background fills the frame. Asserted |

**Don't lock this one** — generate a fresh v2 sheet. The headscarf comes from the bible's prop
"cyan scarf line"; a note like "scarf loosely around the neck, lanyard down to the knees,
leaning forward" will steer it.

## Sahil's steps

1. **Library → Characters**. For each character you want on screen: **Generate sheet** (₹4.40),
   optional note; wait ~1 min, refresh; look; generate again with a note if it's off.
2. **Lock** the one you like. It becomes the reference for every picture of that character
   (and for a cinematic character beat — one look per character). Locking needs the database
   bible (0048 pasted + imported) — the screen says if not.
3. **Approvals → Video type → Cartoon characters** (disabled until at least one of that brief's
   cast is locked; the note names anyone who will be left out).
4. On Cuts, each picture says who was drawn and who was left out and why; Redraw keeps the cast.

## Per-episode cost (₹88/USD, the stored FX)

| | |
|---|---|
| Each picture | ₹4.40 (+ ≈ ₹0.07 rewrite) — **identical to Illustrated** (same routing, same estimator) |
| A 30–40 s Short (≈ 6–7 pictures) | ≈ ₹27–31 in pictures, + voice as before |
| **One-time** per character sheet | ₹4.40 per attempt; 8 characters, one try each ≈ ₹35 |

## What is unverified

A real picture with a reference (the vendor honouring `@Tag` and keeping the look); a v2 sheet
for real; the Characters screen, Generate and Lock in a browser; `27-character-sheet` on the
worker (deployed, never triggered — the probe could not read the Trigger key); a characters
episode end to end; three references in one picture staying distinct; the Auditor's
"not before Season 2" (a `never_do` line, not enforced — don't lock his sheet before S2).

## CI and deploy

- CI **197** on `2841b23` (feature): success, every step read — including **Cartoon characters —
  sheets, the lock, the cast in each picture**, Build, the end-to-end episode and redraw.
- Worker deploy **24** on `2841b23`: success, "version 20261007.14 deployed with 22 detected
  tasks" (+ `27-character-sheet`).
- The two v2 fixes: CI **201** on `6e2f7f9` and CI **202** on `0e6a957` — success, every step
  read; worker deploys **26** and **27** on those commits — success. The worker runs v2.
- Sheet probe runs: **1** (worker) refused before spending — no Trigger key readable;
  **2** (function) made Pip's sheet; **3** (show) printed it, no spend.
- Locally before each push: `pnpm check` exit 0; `verify:characters`, `verify:episode`,
  `verify:settings`, `verify:channel-bible`, `verify:channels`, `verify:bureau`,
  `verify:library`, `verify:studio` exit 0 on local Postgres 16 + pgvector; `pnpm build` exit 0
  with CI's env. A mutation dropping `references` from the submit fails 3 checks.
