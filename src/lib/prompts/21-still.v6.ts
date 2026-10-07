/**
 * Pictures for the "3D explainer" (engineered format, 0052). Version 6. v1–v5 are kept beside
 * it: every picture stays explainable from `generations.request_payload.prompt_ref`, and v4/v5
 * remain the prompts for every other format.
 *
 * What is different. The other formats draw cartoons with nobody in them (v4) or the cast from
 * their sheets (v5). Here the picture is a clean photoreal 3D render of an engineered object,
 * the same object in every picture — so the episode's HERO OBJECTS are passed as tagged
 * references (their per-episode sheets, object-sheets.ts) and named only by tag, exactly as v5
 * names characters. The model writes the scene; code appends the object clause, the look for
 * the beat's view (scene / cutaway / diagram — from the format or the channel, never from this
 * file) and the negative clause, so a rewrite can never drop a tag or the "no text" rule.
 * Every label the viewer reads is a graphic we draw (graphics.ts), never the model's.
 */

export const STILL_ENGINEERED_PROMPT_REF = '21-still.v6';

export const STILL_ENGINEERED_SYSTEM = `You turn one beat of a 3D-explainer Short into a description of a single STILL 3D RENDER.

Rules, all mandatory:
- The OBJECTS list gives each hero object's TAG (like @Airbag). Refer to an object ONLY by its tag, exactly as written, and include every listed tag. Never describe what a tagged object looks like — that comes from its reference image.
- VIEW "scene": the object in its world, at the instant the narration describes. VIEW "cutaway": the object's housing see-through, the one part that is acting right now singled out. VIEW "diagram": a simple cross-section of the part the narration explains.
- When ACTION is true, freeze the most dramatic instant of the motion (mid-impact, mid-launch, mid-fall).
- No people, no faces, no hands. A crash-test dummy only if the beat needs a body in a seat.
- No words, letters, numbers, labels, signs, arrows or captions in the picture.
- Describe what is visible, plainly: framing (wide, close, low angle), where the objects are, what is happening. 15 to 55 words. No style words (the style is added for you).
- Never mention any name from the CAST list.
- When an APPROVER DIRECTION is given, follow it unless it conflicts with a rule above — the rules always win.

Return JSON: {"scene": "<the description>"}.`;

export function stillEngineeredUserMessage(input: {
  picture: string;
  narration?: string;
  view: 'scene' | 'cutaway' | 'diagram';
  action: boolean;
  objects: { tag: string; name: string }[];
  cast: string[];
  premise: string;
  direction?: string;
}): string {
  return [
    `CAST (never name): ${input.cast.join(', ') || '(none)'}`,
    `OBJECTS IN THIS PICTURE:`,
    ...(input.objects.length ? input.objects.map((o) => `- @${o.tag} (${o.name})`) : ['- (none — show the scene without a hero object)']),
    `VIEW: ${input.view}`,
    `ACTION: ${input.action}`,
    `EPISODE PREMISE (context only): ${input.premise}`,
    '',
    `BEAT PICTURE: ${input.picture}`,
    ...(input.narration ? [`NARRATION UNDER THIS PICTURE: ${input.narration}`] : []),
    ...(input.direction?.trim() ? [`APPROVER DIRECTION FOR THIS REDRAW (follow it; the rules above still win): ${input.direction.trim().replace(/\s+/g, ' ').slice(0, 200)}`] : []),
  ].join('\n');
}

/** The object clause code appends: every tag, said to be exactly the object in its reference. */
export function engineeredObjectClause(objects: readonly { tag: string; name: string }[]): string {
  if (!objects.length) return '';
  return `${objects.map((o) => `@${o.tag} is exactly the ${o.name} in its reference image`).join('; ')}, same shape, colours and decals.`;
}
