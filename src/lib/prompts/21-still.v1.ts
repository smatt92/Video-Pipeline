/**
 * Scene stills — the rewrite from a shot description to a picture with nobody in it.
 * Version 1. Versioned in the filename (CLAUDE.md): a material change is a v2 beside this,
 * so a still made under v1 stays explainable from `generations.request_payload.prompt_ref`.
 *
 * The cast stays off-screen (Sahil, 07-Oct-2026, decision 0021). A shot description is
 * written for a sitcom — "Pip holds a feather duster beside a coat rack whose Moon hook is
 * empty" — and a still of that is a stranger holding a duster. So the model removes every
 * cast member and every action a person performs, and keeps the objects, the place and the
 * idea: "a coat rack with an empty crescent-moon-shaped hook beside a feather duster, office
 * desk". The style and the negative clause are NOT the model's to write: they are appended
 * in code from the channel's bible (`composeStillPrompt`), so a rewrite can never drop them.
 *
 * The model's output is checked deterministically afterwards (`castNamesIn`): a scene that
 * still names a cast member is refused, whatever the model says it did.
 */

export const STILL_PROMPT_REF = '21-still.v1';

export const STILL_SYSTEM = `You turn one shot description from an animated office sitcom into a description of a STILL IMAGE that contains no people.

Rules, all mandatory:
- Remove every named character and every person, body part, face, silhouette, figure, mascot or creature. Nobody is in the picture.
- Remove every action a person performs (holding, pointing, saying, looking, walking). Keep the OBJECTS those actions involve, placed in the scene.
- Keep the place, the objects, the diagram or the physical idea the shot is about — the thing the viewer must understand.
- No words, letters, numbers, labels, signs or captions in the picture.
- Describe what is visible, plainly, as a list of things and where they are. 12 to 45 words. No style words (the style is added separately), no camera words.
- Never mention any name from the CAST list, in any form.

Return JSON: {"scene": "<the description>"}.`;

export function stillUserMessage(input: { description: string; cast: string[]; premise: string }): string {
  return [
    `CAST (never name, never depict): ${input.cast.join(', ')}`,
    `EPISODE PREMISE (context only): ${input.premise}`,
    '',
    `SHOT DESCRIPTION: ${input.description}`,
  ].join('\n');
}

/** Appended to every still, after the bible's own negative prompt. Not negotiable by the model. */
export const STILL_NEGATIVE = 'no people, no characters, no faces, no figures, no text';
