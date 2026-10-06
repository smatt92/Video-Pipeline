# 0013 — Voice, dubbing and sound effects on the Runway API; the Bureau episode run

Status: accepted · 2026-10-06 · supersedes 0012 row 6

## Decision

Sahil, 06-Oct-2026 (plan v2.2): one vendor and one credit pool for voice, dubs and Act-Two.
The Bureau's voice stage speaks every line through **Runway text-to-speech** (`eleven_v3`,
one locked **preset** per character), dubs through **Runway voice dubbing**
(`eleven_voice_dubbing`), and the optional button-gag sound effect through **Runway sound
effects** (`eleven_text_to_sound_v2`). No ElevenLabs subscription. The ElevenLabs-direct
driver (`src/lib/drivers/audio-tts.ts`) stays working behind the same routing predicate for
any character moved off presets (`voice.provider = "elevenlabs"` + `elevenlabs_voice_id`).

## What was verified, and against what

Read from the vendor's OpenAPI-generated SDK (`runwayml/sdk-node`, `src/resources/*.ts`,
main, fetched 2026-10-06). The API host itself is outside this environment's egress allowlist,
so **nothing below has been called** — every response is Zod-parsed and a drift fails loudly.

| Fact the prompt gave | What the SDK says | Consequence |
|---|---|---|
| TTS models eleven_multilingual_v2, eleven_v3, eleven_v4 | Also `seed_audio` (reference-audio voices). v2 takes `promptText` ≤ 1000 chars and a preset only; v3 adds `applyTextNormalization`, `languageCode`, `seed`, stability/style | Default `eleven_v3`. Normalisation passed **explicitly `off`** — its default `auto` rewrites numbers, and a "3.8 cm" read differently from the script breaks forced alignment |
| Preset voices only | `voice: { type: "runway-preset", presetId }`, 49 enumerated ids | `TTS_PRESET_IDS` in `voice-route.ts`; the schema rejects anything else |
| No word timestamps | Confirmed: the task output is an array of URLs | Forced alignment on the worker (below) |
| 1 credit / 50 chars; $0.01 / credit | Not in the SDK; from the plan | `rate_card` rows (0040), `is_verified` as a published price, `cost_source = rate_card` |
| No public dubbing rate | Confirmed; the submit response carries `estimatedCost.credits` ("the maximum credits this task may charge") | Dub cost = that vendor upper bound × $0.01, labelled **"rate unverified"** everywhere it shows |
| pt-BR | `targetLang` enum has `pt`, not `pt-BR` ("a regional code is read as its language") | `DUB_TARGET['pt-BR'] = 'pt'`; our `dub_jobs.language` keeps `pt-BR` |
| — | Dubbing options `disableVoiceCloning` (default false), `dropBackgroundAudio`, `numSpeakers` | All three passed explicitly (CLAUDE.md: an option whose default is the behaviour you avoid is passed, not omitted) |

### Webhooks (rule 4)

**Runway offers no task webhook.** None of the task-starting endpoints accepts a callback,
and the task resource has no callback field; the SDK's own `waitForTaskOutput` polls. So the
voice and dub paths poll `GET /v1/tasks/{id}` with backoff (2 s doubling to 20 s, Retry-After
honoured, `THROTTLED` waited on rather than failed) inside the Trigger task. This is the
recorded exception to rule 4 for this vendor. Video generation keeps its webhook for the
primary character-beat vendor and polls the others through the queue (0012 #14).

## Word timings: forced alignment

`src/lib/voice/align.ts`. Each line's audio is aligned against the known line: espeak-ng
speaks each word (so reference boundaries are known by construction), MFCCs of both,
dynamic time warping, reference boundaries carried through the path. CPU only, no model
download; the worker image gets `espeak-ng` through `aptGet` — **read before adding**: its
entire effect is an image layer running `apt-get install` on the named packages, in deploy
builds only.

Confidence is relative: the forward alignment cost must be ≤ 70% of the cost against the same
audio time-reversed (same sounds, wrong order). A reversed *word-order* reference was tried
first and failed on a five-word line. Calibrated in `test:align` and `verify:episode`
(espeak in a different voice, speed and pitch; mean word-start error 6 ms; the wrong
sentence refused at 0.93–0.95). **Not yet calibrated on Runway audio** — 0008 records it.

When alignment is not confident: the audio is kept (it was paid for), `vo_takes.word_timings`
is `[]` with an asset, **no shot is marked `derived_from_vo`**, the episode halts naming the
line, `enqueueGeneration` refuses ("duration is still an estimate"), and
`v_pipeline_blockers` says "voice was synthesised but forced alignment did not confirm every
word". `verify:episode` §4 asserts all four, at the consumer.

## The episode run — where it departs from the prompt's order

The prompt: shotlist → estimate → **generation → QC → voices** → assembly. Built: shotlist →
estimate → **voices → generation → QC** → assembly. CLAUDE.md wins: stage 6 runs before stage
5 because word timings set shot durations; a character beat generated before its line is
spoken is generated at a guessed length and paid for twice.

Other choices recorded here so nobody re-derives them:

1. **Overlays are Three.js scenes projected to SVG**, not a WebGL canvas. CLAUDE.md records
   headless Chromium failing to composite WebGL into captured frames; the chalk-line style is
   lines anyway. `src/remotion/bureau/overlay-scene.ts` builds the scene with Three's camera
   math; the composition draws polylines. Deterministic, Node-testable, identical on every
   machine.
2. **Three render layers** per episode (`renders.layer`): `composite` (approved cut, English
   captions + hook), `clean_master` (no text — the localisation base), `caption_layer`
   (ProRes 4444 with alpha, text only). Plus an SRT. All on the existing Remotion worker.
3. **Shots tile the VO track.** A shot runs from its first line's start to the next shot's
   first line's start, so pauses are owned and the sum of shot durations *is* the track
   length (asserted against ffprobe of the stored file).
4. **Shot → line binding** is deterministic from the approved brief's shot list, by
   estimated duration against line length; no second LLM call when the brief already has
   one. A Sonnet shotlist is used only when the brief has none (prompt in `20-bureau.v1`).
5. **Unpriced generated shots become overlays** with the reason recorded (`episodes.qc.plan.swaps`),
   as do character beats with no locked reference frame ("would generate a different-looking
   person"). The cap fitter then swaps the most expensive remaining generated shot until the
   priced total is under the per-Short cap.
6. **Loudness** is normalised to −14 LUFS on the VO before the render and **measured on the
   rendered composite** afterwards (the instrument closest to the thing).
7. **QC re-rolls** go through the same `insertReroll` as `shot_regenerate` — one cap, one
   implementation. A clip with no vision score is flagged "unscored", never passed.

## Trade-offs accepted

- Presets only: eight characters choose from 49 stock voices; a designed voice per character
  needs the direct vendor (the upgrade path stays wired).
- One more dependency on one vendor: voice, dubs, SFX and Act-Two share an account and its
  outages.
- Unpublished dubbing rate: the ledger carries the vendor's upper-bound estimate, labelled.
- Polling instead of webhooks for this vendor (above).
- An aligner calibrated on synthetic speech until the first real line is spoken.
