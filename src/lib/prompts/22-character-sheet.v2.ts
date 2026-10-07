/**
 * Character sheets — the ONE canonical cartoon image of a cast member that every picture of
 * them is drawn from ("Cartoon characters", 07-Oct-2026). Version 2. v1 is kept beside it: the
 * one real sheet made under v1 (Pip, 07-Oct) stays explainable from its `prompt_ref`.
 *
 * Why v2. v1 cut the channel's still style whenever the prompt ran over the vendor's 1000
 * characters — and with the Bureau's bible it ran over for EVERY on-screen character (1089–1101
 * characters), so every sheet would have been drawn without the cartoon look the pictures are
 * drawn in. The real Pip sheet was made that way; the harness had not asserted the style was
 * present. A sheet is the reference every later picture copies, so a sheet in the wrong style is
 * the outcome this feature exists to prevent. v2:
 *
 *   - says what the image is in fewer words, and drops duplicates from the negative list;
 *   - never puts the character's NAME in the prompt: the v1 Pip sheet came back with "Pip"
 *     lettered across the top (the prompt said "Character reference sheet of … Pip"), and on
 *     a cyan panel inside a white margin instead of the plain background — so v2 says "no
 *     name, no lettering, no panel, no border" and that the background fills the frame;
 *   - makes the STYLE mandatory: if it cannot fit, the prompt is refused ("shorten the note"),
 *     never sent without it;
 *   - cuts, in order, only the attitude line and then the extra negatives v2 adds beyond the
 *     bible's own list.
 *
 * Parts: what the image is · the character's lock · attitude (cut first) · Sahil's note · the
 * channel's still style (never cut) · the bible's negative list (+ extras, cut second).
 *
 * A character who is never seen (`on_screen: false` — Director Ohm) is drawn as his object only.
 */

import type { SheetCharacter, SheetWorld } from './22-character-sheet.v1';

export type { SheetCharacter, SheetWorld };
export const SHEET_PROMPT_REF = '22-character-sheet.v2';

const firstSentence = (s: string) => (s.match(/^[^.!?]*[.!?]/)?.[0] ?? s).trim();
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function parts(c: SheetCharacter, world: SheetWorld, note: string | undefined, opts: { attitude: boolean; extras: boolean }): string[] {
  const v = c.visual_lock;
  const props = v.props.length ? v.props.join(', ') : 'none';
  const head = c.on_screen
    ? `One original cartoon character (${c.role}), full body head to shoes, standing, front three-quarter view, centred, alone on a plain flat ${world.palette.paper} background filling the frame; no name, no lettering, no panel, no border.`
    : `An OBJECT, not a person: ${v.line}. The object alone, centred on a plain flat ${world.palette.paper} background filling the frame; no body, no arms, no hands, no face, no eyes, no person, no lettering.`;
  const lock = c.on_screen
    ? `Look: ${v.silhouette}; props: ${props}; head-to-body ratio ${v.head_body_ratio}; ${v.line_weight} outlines; single accent colour ${c.accent_hex}.`
    : `Details: ${props}; accent colour ${c.accent_hex}.`;
  const attitude = opts.attitude && c.on_screen ? `Attitude: ${firstSentence(c.personality)}` : null;
  const direction = note?.trim() ? `Direction: ${clean(note).slice(0, 200).replace(/([^.!?])$/, '$1.')}` : null;
  const style = world.still_style ? `Style: ${world.still_style}` : null;
  const base = world.negative_prompt.replace(/[.\s]+$/, '');
  const extras = ['labels', 'captions', 'a second character', 'background scenery', ...(c.on_screen ? [] : ['any person or face'])].filter((x) => !new RegExp(`\\b${x}\\b`, 'i').test(base));
  const negative = `Avoid: ${base}${opts.extras && extras.length ? `, ${extras.join(', ')}` : ''}.`;
  return [head, lock, attitude, direction, style, negative].filter((x): x is string => !!x).map(clean);
}

/** The prompt's parts at full length (for display and tests). */
export function sheetPromptParts(c: SheetCharacter, world: SheetWorld, note?: string): string[] {
  return parts(c, world, note, { attitude: true, extras: true });
}

/**
 * The sheet prompt within `max`, or a refusal. Cuts the attitude line, then the extra
 * negatives; never the character, the note, the style or the bible's negative list.
 */
export function sheetPrompt(c: SheetCharacter, world: SheetWorld, note: string | undefined, max: number): { ok: true; prompt: string } | { ok: false; reason: string } {
  for (const opts of [{ attitude: true, extras: true }, { attitude: false, extras: true }, { attitude: false, extras: false }]) {
    const p = parts(c, world, note, opts).join(' ');
    if (p.length <= max) return { ok: true, prompt: p };
  }
  const n = parts(c, world, note, { attitude: false, extras: false }).join(' ').length;
  return { ok: false, reason: `the sheet prompt is ${n} characters with the channel's style kept; the limit is ${max} — shorten the note${world.still_style && world.still_style.length > 400 ? ' or the picture style (Settings → Generation)' : ''}` };
}
