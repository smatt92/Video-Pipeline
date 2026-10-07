/**
 * Character sheets — the ONE canonical cartoon image of a cast member that every picture of
 * them is drawn from ("Cartoon characters", 07-Oct-2026). Version 1, built in code from the
 * bible: no model rewrites it, because the whole point of a sheet is that it says exactly what
 * the bible says.
 *
 * The parts, in order. If the image prompt limit forces a cut, the attitude line goes first and
 * the style second — never the character, the note or the negative list:
 *
 *   1. what the image is: one character, full body, front three-quarter, plain background
 *   2. the character's lock: silhouette, props, head:body ratio, line weight, accent colour
 *   3. a line of personality, so the pose has an attitude    (dropped first if over the limit)
 *   4. Sahil's optional note ("make the lanyard longer")
 *   5. the channel's still style (the same cartoon look the pictures are drawn in)  (then this)
 *   6. the negative list
 *
 * A character who is never seen (`on_screen: false` — Director Ohm) is drawn as his object
 * only: the bible's visual lock for him says "lamp only; never a body", and a sheet of a person
 * would become the reference every later picture copies.
 */

export const SHEET_PROMPT_REF = '22-character-sheet.v1';

export interface SheetCharacter {
  name: string;
  role: string;
  on_screen: boolean;
  personality: string;
  accent_hex: string;
  visual_lock: { figure?: string; line: string; props: string[]; head_body_ratio: string; line_weight: string; silhouette: string };
}

export interface SheetWorld {
  palette: { paper: string };
  still_style?: string;
  negative_prompt: string;
}

const firstSentence = (s: string) => (s.match(/^[^.!?]*[.!?]/)?.[0] ?? s).trim();
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The sheet prompt, or the parts in priority order (for a caller that must cut to a limit). */
export function sheetPromptParts(c: SheetCharacter, world: SheetWorld, note?: string): string[] {
  const v = c.visual_lock;
  const props = v.props.length ? v.props.join(', ') : 'none';
  const head = c.on_screen
    ? `Character reference sheet of one original cartoon character, ${c.name} (${c.role}): full body from head to shoes, standing, front three-quarter view, centred, alone on a plain flat ${world.palette.paper} background with nothing else in the frame.`
    : `Reference image of an OBJECT, not a person — the only visible presence of ${c.name} (${c.role}): ${v.line}. Only the object, centred, alone on a plain flat ${world.palette.paper} background; no body, no arms, no hands, no face, no eyes, no person.`;
  const lock = c.on_screen
    ? `Look: ${v.silhouette}; props: ${props}; head-to-body ratio ${v.head_body_ratio}; ${v.line_weight} outlines; ${c.accent_hex} is the character's single accent colour.`
    : `Details: ${props}; ${c.accent_hex} as its accent colour.`;
  const attitude = c.on_screen ? `Attitude in the pose: ${firstSentence(c.personality)}` : null;
  const direction = note?.trim() ? `Direction: ${clean(note).slice(0, 200)}` : null;
  const style = world.still_style ? `Style: ${world.still_style}` : null;
  const negative = `Avoid: ${world.negative_prompt}, text, labels, captions, a second character, background scenery${c.on_screen ? '' : ', any person or face'}.`;
  return [head, lock, attitude, direction, style, negative].filter((x): x is string => !!x).map(clean);
}

/** The full prompt, dropping the attitude line and then the style only if it must, to fit `max`. */
export function sheetPrompt(c: SheetCharacter, world: SheetWorld, note: string | undefined, max: number): { ok: true; prompt: string } | { ok: false; reason: string } {
  const parts = sheetPromptParts(c, world, note);
  const join = (ps: string[]) => ps.join(' ');
  if (join(parts).length <= max) return { ok: true, prompt: join(parts) };
  const noAttitude = parts.filter((p) => !p.startsWith('Attitude'));
  if (join(noAttitude).length <= max) return { ok: true, prompt: join(noAttitude) };
  const lean = noAttitude.filter((p) => !p.startsWith('Style:'));
  if (join(lean).length <= max) return { ok: true, prompt: join(lean) };
  return { ok: false, reason: `the sheet prompt is ${join(lean).length} characters even without the style; the limit is ${max} — shorten the note` };
}
