import { BIBLE } from './bible';

/**
 * A Bureau script is dialogue: one line per speaker turn, `Name: words`.
 *
 *   Pip: Where did the Moon go?
 *   Marlo: Filed under "Temporarily Unavailable". Tides stop by Friday.
 *
 * The speaker is matched against the cast by name or slug, case-insensitively and
 * ignoring a trailing full stop ("Mrs. Iyer", "iyer", "Mrs Iyer"). Every line must have a
 * known speaker: the voice stage speaks each line with that character's locked voice, and
 * a line with no speaker has no voice it could honestly use.
 */

export interface ScriptLine {
  idx: number;
  speaker: string;
  text: string;
  /** Character offsets of `text` within the spoken VO string (lines joined by a space). */
  voStart: number;
  voEnd: number;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

const SPEAKERS = new Map<string, string>();
for (const c of BIBLE.characters) {
  SPEAKERS.set(norm(c.id), c.id);
  SPEAKERS.set(norm(c.id.replace(/_/g, ' ')), c.id);
  SPEAKERS.set(norm(c.name), c.id);
  // "Director Ohm" → "Ohm"; "The Auditor" → "Auditor".
  const last = c.name.split(/\s+/).pop();
  if (last) SPEAKERS.set(norm(last), c.id);
}

export function speakerSlug(label: string): string | null {
  return SPEAKERS.get(norm(label)) ?? null;
}

export type ParseResult = { ok: true; lines: ScriptLine[]; voText: string } | { ok: false; problems: string[] };

export function parseScript(script: string): ParseResult {
  const problems: string[] = [];
  const lines: ScriptLine[] = [];
  let vo = '';
  for (const [n, raw] of script.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!m) {
      problems.push(`line ${n + 1}: no "Speaker:" prefix — "${line.slice(0, 40)}"`);
      continue;
    }
    const slug = speakerSlug(m[1]);
    if (!slug) {
      problems.push(`line ${n + 1}: "${m[1]}" is not in the cast`);
      continue;
    }
    const text = m[2].trim();
    if (vo) vo += ' ';
    const start = vo.length;
    vo += text;
    lines.push({ idx: lines.length, speaker: slug, text, voStart: start, voEnd: vo.length });
  }
  if (!lines.length && !problems.length) problems.push('the script has no lines');
  return problems.length ? { ok: false, problems } : { ok: true, lines, voText: vo };
}
