# Handover — Prompt N: scene stills for every shot, and the channel bible in the database (07-Oct-2026)

Decisions: `docs/decisions/0021-scene-stills.md`, `docs/decisions/0022-channel-bible-in-database.md`.
Register: `0008` §25–§27. **Migrations 0047 + 0048 + the Bureau import — one paste** (below),
after 0046.

## What landed

| # | Item | Where |
|---|---|---|
| A1 | Route `still`: every shot that is not a money shot (character beats included) plans as a still when `stillsAvailability` says yes; overlay otherwise, reason in `episodes.qc.plan.stills`. Rewrite by the fast tier under `prompts/21-still.v1.ts`, then `castNamesIn` refuses any cast name; style + lead accent + bible negative + "no people, no characters, no faces, no figures, no text" appended by code | `src/lib/bureau/stills.ts`, `estimate.ts` (`withStills`), `episode-steps.ts` (`planShots`) |
| A2 | `gen4_image` 720:1280 via `drivers/still-image.ts`; generation + ledger estimate before the call, measured reconcile, bounded wait (no callback exists — reason in the driver header), bytes worker → bucket, `assets` row | `generateStillForShot`, `generateStills` step, `20-episode.ts` (after voice, before the video queue) |
| A3 | Remotion `still` shot: full-bleed cover, deterministic Ken Burns from the shot's camera, chalk grid, accent rule; captions on top; composite-first flow untouched | `bureau-video.tsx`, `ken-burns.ts` |
| A4 | Briefs and the episode estimate price stills (₹4.40 at ₹88); caps gate; stills count toward the drawn share; a failed still → overlay with `{from:'still', to:'overlay', reason}` in `qc.plan.swaps` (Cuts lists it); `episodeClips` gains `stillsPlanned`, `stills` | `estimate.ts`, `briefs.ts`, `overlay-only.ts` |
| A5 | `test:bureau` (stills block) + `verify:episode` §8 | see 0021 "Verified" |
| B1 | `channel_bibles`, `channel_characters` (RLS on, service role only) | `0048_channel_bibles.sql` |
| B2 | `getBible(db, channelId)` everywhere (replaces `bibleForChannel`); DB first, folder fallback logged; screens via `requireChannel` without touching their pages | `src/lib/bureau/bible.ts`, `channels/active.ts`, `channels/list.ts`, `trends/*` |
| B3 | `pnpm bible:import --db` / `--sql`; the SQL is inside the paste bundle; proven field by field | `scripts/bible-import.mjs`, `db-bundle.mjs --append` |
| B4 | Approver actions + server actions; overrides folded; `voice:lock` writes the DB; `frame:lock` writes both | `src/lib/channels/bible-admin.ts`, `actions.ts`, `library/voices.ts` |
| B5 | "+ Add channel" calls `createChannel` (template bible, accent field); folder copy removed | `channels/new/page.tsx`, `add-channel-form.tsx` (only these two UI files) |
| B6 | `verify:channel-bible` (CI) | see 0022 "Verified" |

## (a) The migration bundle to paste

Order matters: **`docs/bureau/hosted-migrations-5-0046.sql` first** (Prompt L's — the hosted
project is at 0045; the import folds `channel_voice_overrides`, which 0046 creates). Then:

**`docs/bureau/hosted-migrations-6-0047-0048.sql`** — Supabase → SQL Editor → paste → Run →
"Success. No rows returned". One transaction: 0047 (the `still` route, `stills_enabled`), 0048
(the two tables), then the Bureau import generated from `channels/bureau-of-reality/` by
`bible-import.mjs --sql` (8 characters, 8 series; nothing hand-copied). A guard raises — and
rolls everything back — if no channel has slug `bureau-of-reality` or the cast did not land. A
second paste is refused by the version guard. Verified locally on a database at 0046 (with an
override row, which it folded) and refused a second time.

Until it is pasted: every shot plans as an overlay ("scene stills need migration 0047"), and
every channel reads its folder bible (one log line per process). Nothing breaks either side.

To regenerate: `node scripts/bible-import.mjs --sql /tmp/i.sql && node scripts/db-bundle.mjs
--from 0047 --to 0048 --append /tmp/i.sql --out docs/bureau/hosted-migrations-6-0047-0048.sql`.

## (b) The real still — S001 shot 2

One still, ₹4.47 all in (₹4.40 image — the vendor reported 5 credits, matching the rate — plus
₹0.07 for the rewrite). Run by the **Still probe** workflow (run `37581560626`) through
`generateStillForShot` against the hosted DB, the real vendor and the bucket; stored at
`stills/e6cf4479-913c-45ec-829b-8878263df5c6/02-0.png` (1.15 MB). Downscaled copy in the repo:
`docs/bureau/still-s001-shot2-270x480.jpg`.

What it looked like: navy blueprint paper, fine grid, white chalk linework; a central Earth
with force arrows and a pull arrow from above, two smaller Earths at the top joined by a cyan
arc. **No people, faces or figures.** It reads as the Bureau's world and as a diagram about
Earth and a pull. What it missed: the globes are textured, not flat chalk; the cyan is on two
elements, not one; the two tidal **bulges are not drawn** (the Earth is round); a couple of tiny
letter-like glyphs near arrow tips; and the rewrite described motion a still cannot show. Prompt
v2 candidates are in 0008 §26 — not changed, because one sample is not a basis for tuning.

## (c) Per-Short estimate, S001-like

S001 has 7 shots and 507 spoken characters; ₹88 per USD (hosted `profiles`).

| | |
|---|---|
| Voice — 507 chars × 1 credit/50 × $0.01 × ₹88 | ₹8.92 |
| Stills — 7 × $0.05 × ₹88 | ₹30.80 |
| Still rewrites — 7 Haiku calls (measured on the real one: 525 in / 53 out = ₹0.07) | ≈ ₹0.5 |
| **Per Short** | **≈ ₹40**, against the ₹150 cap (was ≈ ₹9 all-overlay) |

A money shot, if a brief plans one and its recipe is ever activated, adds 4–8 s × $0.10 × ₹88 ×
1.5 planned = ₹53–106; the cap fitter swaps it first.

## (d) Action signatures for Prompt M

All in `src/lib/channels/actions.ts` (`'use server'`), signed-in approver only, each returning
`AdminResult<T>` = `({ ok: true; message: string } & T) | { ok: false; refused: string }` —
never throws to the client. Lib versions (same names without `Action`, taking `(db, actor, …)`)
are in `src/lib/channels/bible-admin.ts`; schemas are exported there for forms.

```ts
// Basics — creates channel row, channel_policy, publish targets, bible + cast from the template
// (or from a folder bible: template: 'bureau-of-reality'); sets the active-channel cookie.
createChannelAction(input: {
  name: string; slug: string; handle?: string; niche?: string; accent_hex?: string;
  youtube_channel_id?: string; instagram_account_id?: string; instagram_handle?: string;
  targets: ('youtube' | 'instagram')[]; template?: string;
}): Promise<AdminResult<{ channelId: string; slug: string; cast: number; targets: string[]; warnings: string[] }>>

// Cast — add or edit one character (CharacterInputSchema = the bible's CharacterSchema minus
// voice and reference frames, plus sort?/active?). Voice is lockVoiceAction; frames, frame:lock.
upsertCharacterAction(channelId: string, input: CharacterInput): Promise<AdminResult<{ slug: string; created: boolean }>>

// Cast — lock a voice; presetId must be one of TTS_PRESET_IDS (drivers/voice-route.ts).
lockVoiceAction(channelId: string, characterSlug: string, presetId: string): Promise<AdminResult<{ slug: string; presetId: string }>>

// Schedule — add or replace one series document (SeriesSchema; id ∈ bureau_series enum).
updateSeriesAction(channelId: string, series: unknown): Promise<AdminResult<{ seriesId: string }>>

// Caps — content policy (PolicySchema) and/or caps; only what is passed changes.
updatePolicyAction(channelId: string, input: { policy?: unknown; caps?: {
  per_short_cap_inr?: number; daily_cap_inr?: number; daily_longform_cap_inr?: number;
  monthly_cap_inr?: number; stills_enabled?: boolean } }): Promise<AdminResult>

// Trend sources — TrendsConfigSchema: { subreddits: string[]; youtube: { region_code, category_ids, queries } | null }
updateTrendSourcesAction(channelId: string, trends: unknown): Promise<AdminResult>

// Existing, unchanged: addChannelAction(prev, FormData) (the current form; now calls createChannel),
// setPublishTargetAction(prev, FormData), setActiveChannelAction(channelId).
```

Reading for the flow: `await getBible(serverClient(), channelId)` (`src/lib/bureau/bible.ts`) —
`.source` is `'db'` or `'file'`. For M, also:

- Show **Regenerate** on Cuts only for video routes (`isVideoRoute` in `estimate.ts`); a still
  refuses re-roll by name today.
- `library/voices/page.tsx` still says "no bible folder … pnpm channel:new" when a channel has
  no bible; with 0048 that branch only shows for a channel with neither. Reword it in the
  redesign.
- `episodeClips()` now returns `stillsPlanned` and `stills`; "overlay-only" means no clip AND
  no still.

## Found on the way

1. **`check:duplicates` caught `stills.ts` twice** (core and driver) — the driver became
   `still-image.ts`. Same concept boundary as voice-route vs voice.ts.
2. **The Bureau's first style rule says "stick figures"**: appending the bible's style rules to
   a still prompt would have asked for people in every image. Stills use `world.still_style`
   (added to the Bureau bible) or a palette-built sentence; `test:bureau` asserts no
   "stick figure" reaches a still prompt.
3. **The overlay-share rule would have undone the decision**: counted literally, an all-still
   Short is 0% overlay and `fitToCap` swaps stills back to overlays. Stills count as drawn.
4. **0046 is not pasted on the hosted project** (it is at 0045 — read with the Supabase MCP,
   read-only). So Voices/Music screens still say "needs 0046" there, and the 0047–48 bundle
   must follow it.
5. `CharacterSchema.reference_frame_ids` was `min(1)`; a cast member made in the app has no
   frame, so it is now any length (syncCast already copied only usable ones).

## CI and deploy

- CI run **177** on `c1d69c8` (the code commit): **success**, every step read in the step list —
  guards, typecheck, lint, Bureau rules (the new stills block), migrations 0001–0048, enums,
  drift, catalogue, duplicates (which caught `stills.ts` ×2 locally first), every DB harness
  including the new **Channel bible in the database** step, Build, render, **episode end to end**
  (with §8 stills), public pages, scaling, tour.
- Worker: **Deploy worker (Trigger.dev)** run 17 on `c1d69c8`: success, every step; "Successfully
  deployed version 20261007.7 … 18 detected tasks".
- Locally before push: `pnpm check` exit 0; every DB harness, `verify:render`, `verify:public`,
  `verify:scaling` exit 0 against a local Postgres 16 + pgvector cluster.
- Another session pushed to `main` concurrently (caption layer as VP9 WebM; a merge); rebased
  cleanly, no conflicts.
