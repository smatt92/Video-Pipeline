/**
 * Hero-object reference sheets (the engineered format, 0052). Version 1.
 *
 * The object counterpart of `22-character-sheet.v3`: one image of the object alone, which every
 * picture of the episode is then given as a tagged reference so the object stays the same
 * object for twenty shots. Written from the brief's `hero_objects` entry (name + look) and the
 * format's scene look — never from free text alone, so a sheet cannot drift into another style.
 * The name is said as what the object IS ("a roadside crash cushion"), never lettered.
 */

export const OBJECT_SHEET_PROMPT_REF = '22-object-sheet.v1';

export function objectSheetPrompt(
  o: { name: string; look: string },
  look: { scene: string; negative: string },
  note: string | undefined,
  max: number,
): { ok: true; prompt: string } | { ok: false; reason: string } {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const head = `A single ${clean(o.name)}: ${clean(o.look).replace(/[.\s]+$/, '')}. The object alone, whole and centred, three-quarter view from slightly above, on a plain light-grey studio floor that fills the frame; nothing else in the picture.`;
  const direction = note?.trim() ? `Direction: ${clean(note).slice(0, 200).replace(/([^.!?])$/, '$1.')}` : null;
  const negative = `Avoid: ${look.negative.replace(/[.\s]+$/, '')}, people, hands, background scenery, a second object.`;
  const prompt = [head, direction, `Style: ${clean(look.scene)}`, negative].filter(Boolean).join(' ');
  if (prompt.length > max) return { ok: false, reason: `the object sheet prompt is ${prompt.length} characters; the limit is ${max} — shorten the object's look or the note` };
  return { ok: true, prompt };
}
