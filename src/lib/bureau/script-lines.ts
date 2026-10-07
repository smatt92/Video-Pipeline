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

/**
 * Split one physical line into the speaker turns it actually contains.
 *
 * The writer model sometimes puts an interrupted exchange on one line —
 * `Pip: Marlo: File it under— Pip: Missing?` — and before this the whole thing was spoken by
 * the first speaker, cast names included (S001's last line, 2026-10-06). A cast label
 * followed by a colon inside the text starts a new turn; a label that is not in the cast
 * ("Note:", "Desk Four:") is left as words, because only a known speaker has a voice.
 */
export function splitTurns(speaker: string, text: string): { speaker: string; text: string }[] {
  const re = /(^|\s)([A-Z][\w.]*(?: [A-Z][\w.]*)?):\s+/g;
  const cuts: { at: number; end: number; slug: string }[] = [];
  for (const m of text.matchAll(re)) {
    const slug = speakerSlug(m[2]);
    if (slug) cuts.push({ at: m.index + m[1].length, end: m.index + m[0].length, slug });
  }
  if (!cuts.length) return [{ speaker, text }];
  const out: { speaker: string; text: string }[] = [];
  let current = speaker;
  let from = 0;
  for (const c of cuts) {
    const seg = text.slice(from, c.at).trim();
    if (seg) out.push({ speaker: current, text: seg });
    current = c.slug;
    from = c.end;
  }
  const tail = text.slice(from).trim();
  if (tail) out.push({ speaker: current, text: tail });
  return out;
}

/**
 * What a punchline actually SAYS, turn by turn.
 *
 * Briefs write punchlines as an exchange with stage directions —
 * `Pip: So I can't break gravity. / Marlo: Not alone. Meet your supervisor. / Ohm's lamp flickers on.`
 * (S003, 07-Oct) — and the script check compared that whole string, names, slashes and
 * stage direction included, against the spoken VO, so a script that said every word refused
 * as "the approved punchline is not in the script". Segments are split on " / "; a segment
 * labelled with a cast name is a spoken turn; an unlabelled segment in a labelled punchline
 * is a direction and is not spoken, as is any text before the first label. A punchline with no
 * labels at all is one line for `lead`.
 */
export function punchlineTurns(punchline: string, lead: string): { speaker: string; text: string }[] {
  const segs = punchline.split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
  const turns: { speaker: string; text: string }[] = [];
  // Text before the first cast label in a segment ("Pip lets go of the lanyard… Marlo: The mug
  // has seniority.") is direction too: only labelled text is spoken once any label exists.
  const UNSPOKEN = '\u0000direction';
  for (const seg of segs) turns.push(...splitTurns(UNSPOKEN, seg).filter((t) => t.speaker !== UNSPOKEN));
  return turns.length ? turns : [{ speaker: lead, text: punchline.trim() }];
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
    for (const turn of splitTurns(slug, m[2].trim())) {
      if (vo) vo += ' ';
      const start = vo.length;
      vo += turn.text;
      lines.push({ idx: lines.length, speaker: turn.speaker, text: turn.text, voStart: start, voEnd: vo.length });
    }
  }
  if (!lines.length && !problems.length) problems.push('the script has no lines');
  return problems.length ? { ok: false, problems } : { ok: true, lines, voText: vo };
}
