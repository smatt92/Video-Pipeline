/**
 * Scene stills — the rewrite for a picture WITH the cast in it ("Cartoon characters", 07-Oct-2026).
 * Version 5. v1–v4 are kept beside it: a still made under any of them stays explainable from
 * `generations.request_payload.prompt_ref`, and v4 is still the prompt for every picture with
 * nobody in it — the illustrated format, and a 'characters' picture whose speakers have no
 * locked sheet.
 *
 * Why the cast could be shown at all now. Until this version the cast was kept off-screen
 * because an unanchored generation draws a different-looking person every time (CLAUDE.md, "a
 * guard that permits the outcome its own message names"). A character now appears in a picture
 * ONLY when Sahil has locked a character sheet for it (character-sheets.ts), and the picture is
 * generated with that sheet as a tagged reference image: the image model is given the sheet,
 * and the prompt names the character only by its tag (`@Pip`). The model here never decides
 * who is in a picture — code does (picture-cast.ts) and passes exactly those tags.
 *
 * What the model writes, and what code adds. The model writes the SCENE: what the narration is
 * about, and what the listed characters are doing in it. The character clause (each tag, who
 * is in front, their props), the style and the negative clause are appended in code
 * (`composeCharacterStillPrompt`), so a rewrite can never drop a tag, add a person, or lose the
 * "no other people" clause. Afterwards `castNamesIn` still refuses any cast member who is NOT
 * referenced in this picture, by any form of their name.
 *
 * A character who is never seen (Director Ohm) is referenced as its object — his sheet is the
 * brass desk lamp — and the clause says "only the lamp, never a body".
 */

export const STILL_CAST_PROMPT_REF = '21-still.v5';

export const STILL_CAST_SYSTEM = `You turn one shot description from an animated office sitcom into a description of a STILL IMAGE in which a given set of cartoon characters appears.

Rules, all mandatory:
- The CHARACTERS list gives each character's TAG (like @Pip). Refer to a character ONLY by its tag, exactly as written, and include every listed tag once or more. Never write a character's name without the @.
- The FOREGROUND character is large and in front, doing the thing the narration is about. Any others are smaller, beside or behind.
- A character marked OBJECT ONLY is an object (for example a desk lamp): it can glow, flicker or sit on a desk, but it never has a body, arms, legs or a face.
- No other people, figures, crowds or faces beyond the listed characters.
- When NARRATION is given, the picture shows what that narration is about, at that moment, with the characters reacting to or demonstrating it. The shot description is context.
- Show the REAL-WORLD SUBJECT as a concrete, recognisable thing a viewer identifies at a glance on a phone (the Moon, the ocean, a hammer and a feather) — not abstract diagrams, arrows, graphs or grids.
- No words, letters, numbers, labels, signs or captions in the picture.
- Describe what is visible, plainly: who is where, doing what, and the objects around them. 15 to 55 words. Do not describe how the characters look (that comes from their reference images). No style words, no camera words.
- Never mention any name from the CAST list, in any form, except through the tags given.
- When an APPROVER DIRECTION is given, follow it for what to show and how, unless it conflicts with a rule above — the rules always win.

Return JSON: {"scene": "<the description>"}.`;

export interface CastLine {
  tag: string;
  /** In front: the main speaker under this picture. */
  foreground: boolean;
  objectOnly: boolean;
  role: string;
}

export function stillCastUserMessage(input: {
  description: string;
  cast: string[];
  premise: string;
  characters: CastLine[];
  narration?: string;
  part?: { index: number; of: number };
  direction?: string;
}): string {
  return [
    `CAST (never name except through the tags below): ${input.cast.join(', ')}`,
    `CHARACTERS IN THIS PICTURE:`,
    ...input.characters.map((c) => `- @${c.tag}${c.foreground ? ' — FOREGROUND' : ''}${c.objectOnly ? ' — OBJECT ONLY' : ''} (${c.role})`),
    `EPISODE PREMISE (context only): ${input.premise}`,
    '',
    `SHOT DESCRIPTION: ${input.description}`,
    ...(input.narration ? [`NARRATION UNDER THIS PICTURE: ${input.narration}`] : []),
    ...(input.part && input.part.of > 1 ? [`This is picture ${input.part.index + 1} of ${input.part.of} for this shot; make it a different image from the others — a different object, angle or moment.`] : []),
    ...(input.direction?.trim() ? [`APPROVER DIRECTION FOR THIS REDRAW (follow it; the rules above still win): ${input.direction.trim().replace(/\s+/g, ' ').slice(0, 200)}`] : []),
  ].join('\n');
}

/** Appended to every character picture, after the bible's negative prompt. `tags` without the @. */
export function stillCastNegative(tags: readonly string[]): string {
  const who = tags.map((t) => `@${t}`).join(' and ');
  return `no other people or characters besides ${who}, no faces other than the referenced characters, no extra limbs, no text`;
}
