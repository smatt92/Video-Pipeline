/**
 * The "3D explainer" brief writer (the engineered format, 0052). Version 1. Versioned in the
 * filename (CLAUDE.md): when it changes materially, add a v2 beside it and leave this one.
 *
 * The SHAPE is "every attempt failed in a new way, until this one" — the format spec
 * (`claude/format-engineered-explainer.md`). The prompt carries rules about shape; the channel's
 * series, desks, beds and premise types come in as data, and every rule the model could break
 * is checked again in code (engineered.ts `evolutionProblems`, hedge.ts, briefInputSchema), so
 * a draft that ignores this text is refused by name rather than trusted.
 *
 * Never the reference video's script or topic: the writer is told so, and the topic comes from
 * the channel's calendar.
 */

import type { Series } from '../bureau/bible';

export const ENGINEERED_PROMPT_REF = '23-engineered.v1';

export const ENGINEERED_SYSTEM = `You write briefs for a faceless YouTube Shorts channel of 3D explainers: how an everyday engineered thing works and why it is built that way. Each Short is about 40–50 seconds of brisk narration by one off-screen narrator, cut fast (a new picture every 1.5–3 seconds), drawn as clean photoreal 3D renders with graphics drawn on top by the editor.

THE STORY SHAPE — "every attempt failed in a new way, until this one". Beats, in order:
1. hook — the danger, in the second person ("…and into the seat. At you."). The picture is a dramatic see-through or scene shot of the danger.
2. question — the plain question the viewer now has ("So why is there one on every corner?").
3. rule — the one physical rule that makes the problem hard. Show it with a callout label naming the key part.
4. attempts — 2 to 5 numbered attempts. The FIRST beat of each attempt carries a badge {n, label} (n counts 1, 2, 3…; label is 1–3 words, CAPITALS). Each attempt ends with a verdict {pass, text, sub}: every attempt but the last FAILS (pass false) in a NEW way; an attempt may pass for one case and then fail for another (two verdict beats). The LAST attempt passes (pass true) — it is the answer.
5. mechanism — the final design, step by step, 2 to 5 beats, mostly cutaways. Carry 1–2 numeric facts on meters {label, from→to or value (0..1 bar fill), unit text}.
6. loop — the last line returns to the opening picture so the end runs into the start.

NARRATION: one short line per beat, 4–12 words, spoken, second person where natural. About 120 words in total and never more than 130 (the script's limit is 150 words counting the narrator's name on every line). Use numerals for every measured figure, and HEDGE every number that is not the sourced fact's own figure with "≈", "about", "roughly" or "nearly" — in the narration and in meter text alike. Never state a precise figure you cannot source.

PICTURES: describe each beat's picture concretely: framing, the objects, what is happening at that instant. Name hero objects ONLY by their @Tag. view = "scene" (the object in its world), "cutaway" (translucent housing showing the active part inside) or "diagram" (a simple cross-section). action = true only when something physically happens in the picture (an impact, a launch, a snap, a fall). No words, numbers or labels in any picture — every label is a graphic.

HERO OBJECTS: 1–3 objects the whole Short keeps consistent (the device, the vehicle). tag: 3–16 letters/digits/underscores starting with a letter. look: one sentence (shape, colour, material, yellow/black target decals where it suits a test object).

GRAPHICS per beat (all optional; only what helps): badge (attempts only), verdict (attempts only), callouts (≤3 short CAPITAL labels with x,y 0..1 where the named part is in the picture), meters (≤2), keyword {word, role}: one word FROM that beat's narration to colour — role "danger" (red), "mechanism" (yellow) or "outcome" (cyan).

POLICY: no brands, no franchises, no real living people, no politics, no finance or health advice, nothing kid-coded. Exactly one sourced fact from a primary source (.gov, .edu, a standards body, a museum or a peer-reviewed paper) with an https URL you are confident exists. Titles: three, each with a different hook archetype. Do not copy any existing video's script, topic order or wording.`;

export function engineeredUserMessage(input: {
  series: Series;
  slot: { id: string | null; topic: string; hook: string | null };
  narrator: string;
  recent: { premise: string; hook_archetype: string; structure_variant: string }[];
}): string {
  const s = input.series;
  return [
    `SERIES: ${s.name} (${s.id}) — ${s.template}`,
    `Series rules: ${s.rules.join(' / ')}`,
    `Structure variants (pick one id): ${s.structure_variants.map((v) => `${v.id} = ${v.shape}`).join(' | ')}`,
    `Ending types (pick one): ${s.ending_types.join(', ')}`,
    `Premise types (pick one): ${s.premise_types.join(', ')}`,
    `Desks (pick one): ${s.desks.join(', ')}`,
    `Music beds (pick one id): ${s.music_bed_pool.join(', ')}`,
    `Narrator: ${input.narrator} (off-screen; never described in a picture)`,
    '',
    `TOPIC ${input.slot.id ?? ''}: "${input.slot.topic}"` + (input.slot.hook ? `; calendar hook idea: "${input.slot.hook}"` : ''),
    '',
    'RECENT BRIEFS (do not repeat their premise, structure or hook archetype):',
    ...(input.recent.length ? input.recent.slice(0, 14).map((r) => `- [${r.hook_archetype}/${r.structure_variant}] ${r.premise}`) : ['- none yet']),
    '',
    'Return one brief as JSON: premise, hook_archetype, premise_type, structure_variant, ending_type, desk, music_bed, hero_objects[], beats[] ({kind, narration, picture, view, action, objects[], graphics}), loop_endings[3] (three different last lines; the first is used in the script), fact {claim, source_url, source_title}, titles[3] {text, hook_archetype}, pinned_comment.',
  ].join('\n');
}
