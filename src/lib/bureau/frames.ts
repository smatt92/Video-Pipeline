import { STORAGE_REF_PREFIX, type Bible, type Character } from './bible';

/**
 * Locked reference frames — the one image per character that every character beat is
 * animated from (decision 0015).
 *
 * The flow mirrors `voice:audition` / `voice:lock` exactly, because the decision has the same
 * shape: money is spent producing candidates, a person chooses, and only the choice becomes
 * part of the bible.
 *
 *   pnpm frame:audition --character pip [--ref <file|url> …]   candidates → ./out/frames/
 *   pnpm frame:lock pip ./out/frames/pip/2.png                 upload + characters.json
 *
 * Audition writes NOTHING to storage or to `characters.json`. Lock is the only writer of a
 * `storage:` reference, and it leaves the commit to Sahil: a locked look is an editorial
 * decision with an author, the same as a locked voice.
 *
 * This module holds the parts that are not vendor-shaped — the prompt built from the bible,
 * and where a locked frame lives — so the scripts and any future screen agree on both.
 */

/** Storage key for a locked frame. Content-addressed, so re-locking the same file is a no-op. */
export function frameKey(characterId: string, sha256Hex: string, ext: 'png' | 'jpg'): string {
  return `characters/${characterId}/ref-${sha256Hex.slice(0, 16)}.${ext}`;
}

export function frameRef(key: string): string {
  return `${STORAGE_REF_PREFIX}${key}`;
}

/**
 * The text half of a frame request: the character's visual lock, the world's style rules
 * and the negative list, in that order of priority — so if the vendor's 1000-character limit
 * forces a cut, it is the trailing world rules that a caller drops, never the character.
 */
export function framePrompt(c: Character, world: Bible['world'], extra?: string): string {
  const v = c.visual_lock;
  const lock = [
    `${c.name}: ${v.silhouette}`,
    `line ${v.line}, weight ${v.line_weight}, head:body ${v.head_body_ratio}`,
    v.props.length ? `props: ${v.props.join(', ')}` : null,
    `single accent colour ${c.accent_hex}`,
  ]
    .filter(Boolean)
    .join('; ');
  const rules = world.style_rules.slice(0, 2).join(' ');
  const negative = `Avoid: ${world.negative_prompt}.`;
  return [extra?.trim() || 'Full-body reference frame, standing, three-quarter view, centred, 9:16.', lock + '.', rules, negative]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
