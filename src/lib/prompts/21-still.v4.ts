/**
 * Scene stills — the rewrite from a shot description to a picture with nobody in it.
 * Version 4. Versioned in the filename (CLAUDE.md): a material change is a v2 beside this,
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
 * v2 (07-Oct-2026): S003's cut was sent back — "the visuals seem not related to this topic …
 * render cartoonish images of the topic". v1 kept "the diagram or the physical idea", and an
 * abstract diagram is exactly what a viewer could not place. v2 asks for the concrete,
 * recognisable subject — the Moon, the sea, a hammer and a feather — as one clear focal
 * subject, so the topic reads at a glance on a phone. The cartoon look itself is the bible's
 * `still_style`, appended in code as before.
 *
 * v3 (07-Oct-2026): an illustrated shot gets a picture every ~6 s of narration (formats.ts),
 * so one shot can carry up to four pictures. Each is drawn from the NARRATION spoken under it,
 * which is what makes the picture match what the viewer is hearing at that moment; the shot
 * description stays as context. Two pictures of one shot must not be the same image, so the
 * message says which of N this is.
 *
 * v4 (07-Oct-2026): "Redraw this picture" on Cuts. The approver can redraw one picture of an
 * awaiting cut with a one-line note ("show the Moon bigger", "no arrows"). The note reaches
 * the rewrite as an APPROVER DIRECTION, below the mandatory rules: a direction can change what
 * is drawn, never bring a person, a name or text into it — and `castNamesIn` still checks the
 * result. Without a direction the message is exactly v3's.
 *
 * The model's output is checked deterministically afterwards (`castNamesIn`): a scene that
 * still names a cast member is refused, whatever the model says it did.
 */

export const STILL_PROMPT_REF = '21-still.v4';

export const STILL_SYSTEM = `You turn one shot description from an animated office sitcom into a description of a STILL IMAGE that contains no people.

Rules, all mandatory:
- Remove every named character and every person, body part, face, silhouette, figure, mascot or creature. Nobody is in the picture.
- Remove every action a person performs (holding, pointing, saying, looking, walking). Keep the OBJECTS those actions involve, placed in the scene.
- When NARRATION is given, the picture shows what that narration is about, at that moment. The shot description is context.
- Show the REAL-WORLD SUBJECT of the shot and the episode as concrete, recognisable things a viewer identifies at a glance on a phone (the Moon, the ocean, the Earth, a hammer and a feather on the lunar surface) — not abstract diagrams, arrows, graphs or grids.
- One clear focal subject, large in the frame, with at most two or three supporting objects. Objects may be drawn expressively but never with faces, eyes or mouths.
- No words, letters, numbers, labels, signs or captions in the picture.
- Describe what is visible, plainly, as a list of things and where they are. 12 to 45 words. No style words (the style is added separately), no camera words.
- Never mention any name from the CAST list, in any form.
- When an APPROVER DIRECTION is given, it is a note on the previous picture from the person approving the cut: follow it for what to show and how, unless it conflicts with a rule above — the rules always win (no people, no names, no text, no style words).

Return JSON: {"scene": "<the description>"}.`;

export function stillUserMessage(input: { description: string; cast: string[]; premise: string; narration?: string; part?: { index: number; of: number }; direction?: string }): string {
  return [
    `CAST (never name, never depict): ${input.cast.join(', ')}`,
    `EPISODE PREMISE (context only): ${input.premise}`,
    '',
    `SHOT DESCRIPTION: ${input.description}`,
    ...(input.narration ? [`NARRATION UNDER THIS PICTURE: ${input.narration}`] : []),
    ...(input.part && input.part.of > 1 ? [`This is picture ${input.part.index + 1} of ${input.part.of} for this shot; make it a different image from the others — a different object, angle or moment.`] : []),
    ...(input.direction?.trim() ? [`APPROVER DIRECTION FOR THIS REDRAW (follow it; the rules above still win): ${input.direction.trim().replace(/\s+/g, ' ').slice(0, 200)}`] : []),
  ].join('\n');
}

/** Appended to every still, after the bible's own negative prompt. Not negotiable by the model. */
export const STILL_NEGATIVE = 'no people, no characters, no faces, no figures, no text';
