# Bureau of Reality — the cast

`characters.json` is the source of truth; this page is the human-readable version. The
pipeline reads the JSON (`src/lib/bureau/bible.ts`) and mirrors it into the `characters`
table (`syncCast`), so a change here without a change there does nothing.

**World.** White chalk-line stick figures, one accent colour each, on deep navy blueprint
paper (`#0B1F3A`) with faint grid lines (`#1C3A63`). Mechanisms appear as blueprint
overlays rendered by Kiln. Adult office satire — memos, budgets, compliance, burnout.
**Never kid-coded**: no nursery palettes, no squeaky voices, no classroom framing, no toys.

| Character | Role | Accent | Visual lock | Voice brief | Catchphrase (≤1×/week) |
|---|---|---|---|---|---|
| Pip | New intern, audience surrogate | cyan `#22D3EE` | cyan scarf line, oversized lanyard | bright, fast, curious young adult | "I read the manual. Most of it." |
| Marlo | 400-year Gravity Desk veteran | amber `#F59E0B` | floating coffee mug that orbits him | deadpan baritone | "File it under 'falling'." |
| Mrs. Iyer | Head of Time & Calendars | magenta `#E0409C` | reading glasses on a chain, steel filter-coffee tumbler | crisp Indian-English, dry wit | "That is not what the calendar says." |
| Nib | Archivist | graphite `#9CA3AF` | pencil-shaped body, eraser hat, case file | whispery, conspiratorial | "Case reopened." |
| Kaz | Myth Desk liaison | lantern `#FDBA4D` | lantern head, glow changes by culture | warm storyteller | "Every culture had a word for this." |
| Director Ohm | Never-seen boss | brass `#C9A227` | a humming brass desk lamp only | filtered memo voice | "This will be noted." |
| Complaint Box | Reads real viewer comments | wood `#B7793F` | talking wooden suggestion box | gravelly, weary, fond | "Another one in the slot." |
| The Auditor | Season 2 antagonist (from 06-Jan) | red `#EF4444` | clipboard | clipped, corporate | "And who signed off on gravity?" |

## Fields

| Field | Meaning |
|---|---|
| `id` | Stable slug; `characters.slug` in the database. Never rename — briefs and shots reference it. |
| `speech_rules` | Read by the brief generator and the script polish prompt verbatim. |
| `catchphrase.max_per_week` | Enforced by `variation_check` across the last 7 days of briefs. |
| `visual_lock` | Prompt material for character beats. Image-to-video always starts from a locked reference frame. |
| `reference_frame_ids` | **Placeholders** until the cast is locked. Written only by `pnpm frame:lock <character> <file>` as `storage:characters/<id>/ref-<sha>.png` (decision 0015): uploaded to our bucket and read back first; you commit. `syncCast` copies a `storage:` or `https` reference to `characters.external_ref_id`; Gen-4 Turbo animates from it. A placeholder is never copied, so the character's beats stay overlays until it is locked. |
| `voice` | `{ "provider": "runway", "preset_id": null }` — one locked **Runway preset** per character (plan v2.2: voice, dubs and SFX run on the Runway API). `preset_id` stays `null` until `pnpm voice:audition` has rendered the candidates and `pnpm voice:lock <character> <preset>` writes Sahil's pick. The voice stage refuses a line for a character with no locked voice rather than substituting one. Schema: `src/lib/drivers/voice-route.ts`. |
| `elevenlabs_voice_id` | Optional upgrade path. Set `voice.provider` to `"elevenlabs"` and fill this to move one character off presets onto a designed voice at the direct vendor; nothing else changes. |
| `never_do` | Hard constraints, passed to every prompt that writes for the character. |

## Recurring rules

- Director Ohm is never seen. The Auditor never appears before Season 2.
- Complaint Box credits a viewer by handle only if the comment is public.
- Kaz labels interpretations ("is said to mean"); never devotional; deities are never characters.
- Nib separates the record, the legend and the best current explanation; no true crime.
