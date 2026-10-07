# 0025 — The "3D explainer" video type (engineered), and Built Like That

**Date:** 2026-10-07 (format spec: Project doc `claude/format-engineered-explainer.md`, 08-Oct)
**Status:** built and verified locally (`verify:engineered`, 97 checks); hosted needs bundle 10
**Migration:** 0052 · **Bundle:** `docs/bureau/hosted-migrations-10-0052.sql` (0052 + the channel)

## What it is

A fifth video type, `engineered` — "3D explainer": a clean photoreal 3D-render picture per beat,
fast cuts, the episode's hero objects drawn from per-episode reference sheets, clips animated
from the beat's own picture on the action beats, and a graphics layer we draw on top (stage
badge, verdict pill, callouts, meters, 2–4-word captions with a coloured keyword). The script
shape is "every attempt failed in a new way, until this one". It is a template: every channel's
Approvals offers it (formats.ts `VISUAL_FORMATS`), not only Built Like That.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | New render route **`picture_clip`**, not a reuse of `character_beat` | A character beat means "animate a character from its locked frame"; its rules (seconds cap, locked frame, `accepts_character_ref`) do not apply to animating our own picture. Two meanings under one word in one column is the collision CLAUDE.md asks to rename on sight |
| 2 | **Motion** (`key` / `full`) is a per-episode choice stored as `briefs.approved_edits.motion`, series default `motion`, else `key` — the voice-pace pattern | Sahil asked for "a combination of both"; `routesForFormat(…, motion)` is the one routing function, and **`fittedPlan`** (plan-price.ts) the one estimate → cap fit → re-estimate, called by both `planShots` and Approvals, so the price beside each motion IS the plan |
| 3 | A picture clip costs its picture **plus** the clip; the cap fitter's floor for it is its **picture**, not the overlay | The picture is made either way (it is the clip's first frame); dropping to the chalk overlay would throw away the format |
| 4 | The clip recipe is seeded **retired** by 0052 and **activated by the channel bundle** (one visible statement) | A migration never switches a spend path on, and a fresh DB keeps an empty active library (every harness). 0044 retired its recipes because `accepts_character_ref` was unobserved; a picture clip carries no character, and every clip still passes Cuts. `params.route = picture_clip` scopes it: the router never hands it a money shot, and the legacy lane's shot-kind compiler skips it |
| 5 | Hero-object sheets are **per episode**, locked **automatically** (first good one), Redraw on Cuts | The object is the topic of one episode; a lock step per episode would hold every run on a click. One shared money path with character sheets (`sheet-core.ts` `makeSheetImage`) — two copies of rule 5 would drift |
| 6 | Graphics live in **`shots.graphics`** (jsonb), never drawn by a model | "overlay" already names the chalk route and `overlay_spec`; a third meaning beside them is how a column gets misread |
| 7 | The engineered script is **not polished**, binds **shot i ↔ line i**, and the chosen loop ending **replaces** the last line | Each line carries its own graphics; a polish can merge lines or move a number out of its hedge; an appended punchline would shift every graphic off its words |
| 8 | Numbers **sourced or hedged** — `policy_lint` rule `unhedged_number` over the script AND every graphic a viewer reads; applied only to engineered briefs | A meter is a claim too. Scoped so no other format's lint changes outcome |
| 9 | The look is the **format's default** (`ENGINEERED_LOOK`), overridable per channel in the bible (`world.format_styles.engineered`); the channel's own `negative_prompt` is NOT appended to engineered pictures | The Bureau's negative forbids "photorealism, 3D plastic" — the opposite of this format |
| 10 | Every engineered picture counts as **realistic** for the synthetic-media disclosure | Photoreal CG of real objects; Settings → Publishing (auto) then sets it |
| 11 | Captions are chunked **within each beat** | Found by `verify:engineered` §7: chunking the whole track ran "aside. Then gravity drops" across a cut, colouring a keyword in the wrong beat |
| 12 | Built Like That's series ids `evolution`, `inside` are CHECK values (0052) | The template README: "a new id is a migration" |

## Facts read from the code that change the brief

- **Runway offers no webhooks** (0013; drivers/jobs.ts). Picture clips go through `21-gen-dispatch`,
  which polls once a minute — the recorded exception to rule 4 for this vendor. "Webhooks, not
  polling" cannot be honoured for these clips.
- **At the Bureau's ₹150 per-Short cap, "key" plans 2 clips, not 3–4** (14 beats, ₹88/USD):
  key ₹141.93 (2 clips), full ₹148.53 (3). With room (cap ≥ ₹210) key plans its 4 clips
  (₹207.93) and full 10 of 11 (₹366.33). Approvals says how many clips the cap took and why.
- **Slot ids are global** (`slots.id` is the primary key, `S001…`, `B01…`): a second channel's
  calendar must use ids the first has not. Built Like That's topics are B17–B36. A per-channel
  slot key is a schema change for another day.
- The brief's 150-word CHECK counts **"Narrator:" on every line**, so a 14-beat script has ~136
  words of narration; the writer is told ≤ 130 and `evolutionProblems` refuses more.

## Verified / not

See 0008 §34.
