# Addendum 04 — Competitor-signal ideation

> **Status: QUEUED. Do not implement until after Gate 5.**
>
> Spec churn is currently the largest risk to this build — three addenda landed mid-task
> during Phase 1, one of them mid-turn. This one waits. Nothing in this document has been
> implemented, and no schema in `supabase/migrations/` reflects it.

**Source:** a sponsored YouTube tutorial on building a faceless AI channel. Read
critically — Higgsfield sponsors it and the research tool demoed is the creator's own
product, so revenue figures are estimates presented as findings. The method is still worth
mining.

---

## 1. Take: outlier score as the primary idea signal

The single best idea in the source, and it beats what Kiln currently plans.

Current concept scoring rates ideas on velocity, saturation, IP risk, evergreen tail — all
reasonable, all guesses made before the fact.

Outlier score measures something already proven: a video's views divided by its channel's
typical performance. A video with 66k views on a 1k-subscriber channel is outperforming
its own channel by ~50×. That is not a video that succeeded because a big channel
published it — it is a video whose *idea* carried it. That is the signal you want, and it
is the only one in this space grounded in observed outcomes rather than prediction.

Computable without the paid tool, from the YouTube Data API:

```
outlier_score = video_views / median(views of that channel's last 20 videos)
```

Filter to videos published in the last 90 days, exclude the channel's top and bottom
outliers when computing the median, and require a minimum of 10 videos so the baseline
means something. Track 15–20 channels per niche.

**Schema (not yet written):** `tracked_channels` (external channel id, niche, added_at,
baseline_median_views, baseline_computed_at) and `competitor_videos` (channel, video id,
title, views, published_at, outlier_score, computed_at).

**Quota:** `search.list` is 100 units; `videos.list` is 1 unit per call for up to 50 ids.
Pull channel uploads via the uploads playlist (1 unit), **not** search. A daily refresh
across 20 channels lands comfortably inside the 10,000/day default.

## 2. Take: combination ideation

Rather than "write me ideas about psychology", take two independently proven topics and
merge them: avoidant attachment × high IQ, empaths × dark psychology.

Better than it looks for two reasons. It is grounded in two observed successes rather than
one guess. And — more importantly for Kiln — it is *structurally anti-template*: every
combination produces a different argumentative shape, which is exactly what the
`structure_hash` uniqueness check wants to see. The concept prompt should generate
combinations from the top-N outliers, not freeform ideas.

## 3. Take: a recurring character as channel IP

The source's sharpest strategic point: as generation gets easier the generator stops being
a differentiator, and a recognisable character is one of the few things that compounds.

Kiln already models this — `characters` table, `shots.character_id`, Soul refs. This
validates the design and **raises its priority from nice-to-have to Phase 1c.**

Practical: one character, image reference attached to every single shot, explicitly named
in every prompt. Consistency across hundreds of videos is the whole point, so the
reference lives in settings and is applied automatically rather than per-shot.

## 4. Take: shot-change cadence as a retention setting

The source uses a scene change every 5 seconds minimum, calling it critical for retention.
Whether the exact number is right, it is a real production heuristic and belongs in
settings — `max_shot_duration_s` per format, defaulting to ~5s for Shorts and 7–8s for
long-form.

**Note the tension with Addendum 02 §1:** shot durations are derived from voiceover beat
boundaries. So this is a **ceiling, not a target** — if a VO beat runs 14 seconds, split it
across two shots rather than holding one clip for 14 seconds.

## 5. Take, with modification: competitor channels as a trend source

Tracking 15–20 channels in a niche is a better trend source for this use case than Google
Trends, because it measures what works *on the platform* rather than what people search
for generally. It does not replace the other sources; it outranks them.

## 6. Reject: the "training data" step

The source feeds transcripts of existing high-performing videos into the script writer as
context. **Do not do this.**

YouTube's inauthentic content policy names, as an explicit violation, readings of material
you did not create. Feeding a competitor's transcript to a model and generating a script
from it produces something derived from their work, and you will not be able to prove
otherwise in an appeal — your own script provenance record would be the evidence against
you.

**The safe version, which keeps most of the value:** analyse structure, never content.
Extract from a high performer how many beats, how long the hook runs, where the first
tension release falls, the ratio of claim to example, pacing. Store that as a
`pacing_template` — numbers and shapes, no text. Feed those numbers to the script writer
alongside your own original angle.

Structure is not copyrightable. Sentences are. The distinction is the whole thing.

## 7. Reject: "recreating" a channel

The source frames the workflow as picking a channel and recreating it. That framing is the
exact risk — templated content with minor substitutions is the named violation. Use
competitor data to find which *ideas* resonate, then make something structurally different
about them.

The `structure_hash` check should probably extend to compare against tracked competitor
videos, not only your own back catalogue.

## 8. Reject: Higgsfield voiceover

The source generates VO in Higgsfield. Kiln cannot: word-level timestamps are what make
captions and derived shot durations work, and only the ElevenLabs path returns them.
Staying with ElevenLabs is not a preference, it is a dependency.

## 9. Reject: the 20-minute framing

A whole channel spun up in twenty minutes, publishing on day one, is the pattern that gets
channels demonetised — and the source concedes this by pitching a follow-up video on
avoiding bans. Kiln's editorial gate exists precisely to make this impossible. Do not
soften it because a tutorial made it look fast.

## 10. Out of scope: affiliate monetisation

Finding a high-commission affiliate product and linking it in descriptions is a reasonable
business move and has nothing to do with this pipeline. If it happens, the disclosure
requirements are real (FTC and platform rules) and belong in the metadata template, not in
code.

## 11. One strategic note this raises

The source's niche (evergreen psychology) has a property GTA 6 does not: no expiry date. A
psychology video keeps earning in year two; a GTA 6 speculation video is worthless the day
the game ships, and worse than worthless if the speculation was wrong.

Already flagged in ARCHITECTURE.md §0.4. The source is weak evidence, being an
advertisement, but it points the same direction: prove the pipeline on a niche with a long
tail, then apply it to the high-variance trend play once the machine works.

The architecture is indifferent — niches are rows in `channels`. The decision is not.

---

## When to implement

**After Gate 5.** Sequence:

1. `tracked_channels` + `competitor_videos` + outlier computation (a Trigger cron task)
2. the concept-generation prompt rewrite
3. `pacing_template`

Roughly Phase 4 work, pulled forward because it improves stage 2 and stage 2 gates
everything downstream.

---

## Forward-references into what is already built

Recorded now so none of it has to be re-derived later.

| This addendum | Touches | Note |
|---|---|---|
| §1 `source='outlier'` | `trend_signals.source` | **No migration needed.** That column is free text with no CHECK constraint — the values in 0001 are a comment, not an enum. Adding a source is a write, not a schema change. |
| §1 new tables | migration 0006+ | `tracked_channels`, `competitor_videos`. Both need a rate-card entry only if the YouTube API starts costing money; quota is not currency. |
| §3 character refs | `characters`, `shots.character_id` | Already exists. But note decision 0004: the driver targets the vendor's v2 surface, which can **consume** a character ref and cannot **create** one. Minting the Soul ID stays a manual step. |
| §4 `max_shot_duration_s` | `shots.duration_source` (migration 0004) | A ceiling applied *after* VO-derived durations. A shot split to satisfy the ceiling is still `derived_from_vo` — the split is a consequence of the derivation, not a different source. |
| §6 `pacing_template` | `scripts`, `prompts` | Numbers only. If a text column ever appears on that table, the safe/unsafe line has been crossed. |
| §7 extended uniqueness | `scripts.structure_hash` | Currently compared against own back catalogue only. Extending to competitor hashes changes the check from "am I repeating myself" to "am I repeating anyone", which is the stronger claim in an appeal. |
| §8 | `AudioDriver` | Already the design. `WordTiming` exists precisely because this dependency is load-bearing. |
| §9 | `enforce_review_pass` | The DB trigger is the mechanism. CLAUDE.md rule 7 already forbids an application-level bypass. Still unproven that it fires — see decision 0008. |
