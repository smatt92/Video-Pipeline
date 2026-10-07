/**
 * Character sheets — version 3 (07-Oct-2026). v1 and v2 are kept beside it: every sheet made
 * stays explainable from its `prompt_ref`.
 *
 * Why v3. v2 took the character's NAME out of the prompt (the v1 Pip sheet came back with "Pip"
 * lettered across it) — and with it the only thing that said who the character is. The bible
 * describes a silhouette, props and a line weight, never a person: so the vendor guessed, and
 * the first v2 sheet of Mrs. Iyer was a man in a white coat. v3 opens with the character's
 * FIGURE — `visual_lock.figure`, "an Indian woman in her fifties", "a living pencil with a
 * small face" — and REFUSES an on-screen character without one, naming where to set it
 * (Library → Characters). A sheet is the reference every later picture copies, so a guessed
 * gender is not a draft to fix later: it is the character, for every picture after the lock.
 *
 * Everything else is v2: no name, style never cut, attitude then extra negatives cut first.
 */

import type { SheetCharacter, SheetWorld } from './22-character-sheet.v1';

export type { SheetCharacter, SheetWorld };
export const SHEET_PROMPT_REF = '22-character-sheet.v3';

const firstSentence = (s: string) => (s.match(/^[^.!?]*[.!?]/)?.[0] ?? s).trim();
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function parts(c: SheetCharacter, world: SheetWorld, note: string | undefined, opts: { attitude: boolean; extras: boolean }): string[] {
  const v = c.visual_lock;
  const props = v.props.length ? v.props.join(', ') : 'none';
  const head = c.on_screen
    ? `One original cartoon character: ${v.figure} (${c.role}); full body head to shoes, standing, front three-quarter view, centred, alone on a plain flat ${world.palette.paper} background filling the frame; no name, no lettering, no panel, no border.`
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
  if (c.on_screen && !c.visual_lock.figure?.trim()) return { ok: false, reason: `${c.name} has no figure — say who they are (e.g. "an Indian woman in her fifties") under their name on Library → Characters, then generate` };
  for (const opts of [{ attitude: true, extras: true }, { attitude: false, extras: true }, { attitude: false, extras: false }]) {
    const p = parts(c, world, note, opts).join(' ');
    if (p.length <= max) return { ok: true, prompt: p };
  }
  const n = parts(c, world, note, { attitude: false, extras: false }).join(' ').length;
  return { ok: false, reason: `the sheet prompt is ${n} characters with the channel's style kept; the limit is ${max} — shorten the note${world.still_style && world.still_style.length > 400 ? ' or the picture style (Settings → Generation)' : ''}` };
}
