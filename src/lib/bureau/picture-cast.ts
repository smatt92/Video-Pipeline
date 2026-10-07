import { STILL_MAX_REFERENCES, STILL_TAG } from '../drivers/still-image';
import { isUsableReference, STORAGE_REF_PREFIX, type Bible, type Character, type ChannelBible } from './bible';
import { formatOf, VisualFormatSchema, type FormatSource, type VisualFormat } from './formats';

/**
 * Who is in a picture, for the 'characters' format (07-Oct-2026, decision 0024).
 *
 * The one predicate every caller shares — the stills step, the redraw, the planner's
 * availability check and Approvals — because two stages guarding the same thing drift into
 * the same wrong shape independently (CLAUDE.md). A character is drawn in a picture ONLY when
 * its locked sheet is passed to the image model as a tagged reference; there is no branch that
 * names a character in a prompt without its sheet, which is the outcome the format exists to
 * prevent (a different-looking person every shot).
 *
 *   wanted     the speakers under the picture (longest first), then the shot's own characters
 *   drawn      each wanted character that has a locked sheet, up to the vendor's limit of
 *              references per image; the first is the foreground
 *   excluded   every other wanted character, with the reason — recorded on the generation and
 *              on the episode, never silent
 */

export const NO_SHEETS_REASON = 'no locked character sheets — Library → Characters';

/** The character's locked sheet: the first usable reference frame, or null. A placeholder never counts. */
export function lockedSheet(c: Pick<Character, 'reference_frame_ids'>): string | null {
  return c.reference_frame_ids.find(isUsableReference) ?? null;
}

/** A character the bible says is never seen (Director Ohm) is drawn only as its object. */
export function isObjectOnly(c: Pick<Character, 'on_screen'>): boolean {
  return !c.on_screen;
}

/**
 * The tag a character's reference is named by in a prompt (`@Pip`): the name's distinctive
 * words, letters only, joined by underscores — "Mrs. Iyer" → "Iyer", "Complaint Box" →
 * "Complaint_Box", "Director Ohm" → "Ohm". Always matches the vendor's tag shape; a name that
 * cannot make one falls back to the slug.
 */
const TITLE_WORDS = new Set(['mr', 'mrs', 'ms', 'dr', 'miss', 'the', 'director']);
export function sheetTag(c: Pick<Character, 'id' | 'name'>): string {
  const words = c.name.split(/[^A-Za-z]+/).filter((w) => w && !TITLE_WORDS.has(w.toLowerCase()));
  const fromName = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('_').slice(0, 16);
  if (STILL_TAG.test(fromName)) return fromName;
  const fromSlug = c.id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  const padded = (fromSlug[0]?.toUpperCase() ?? 'C') + fromSlug.slice(1);
  const t = (padded.length < 3 ? `${padded}_ch` : padded).slice(0, 16);
  return STILL_TAG.test(t) ? t : `Cast_${Math.abs([...c.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)) % 100000}`;
}

export interface PictureRef {
  slug: string;
  name: string;
  tag: string;
  /** `storage:<key>` or https — resolved to a short-lived URL only at submit. */
  ref: string;
  foreground: boolean;
  objectOnly: boolean;
  role: string;
  props: string[];
  silhouette: string;
  /** What the character is (`visual_lock.figure`) — said beside the tag so a reference is not the only cue to who they are. */
  figure: string | null;
  accent: string;
}

export interface PictureCast {
  refs: PictureRef[];
  excluded: { slug: string; reason: string }[];
}

/** Speakers first (longest-speaking first), then the shot's characters; unique, order kept. */
export function wantedFor(speakers: readonly string[] | undefined, shotCharacters: readonly string[] | null | undefined): string[] {
  return [...new Set([...(speakers ?? []), ...(shotCharacters ?? [])])];
}

/** Who is drawn in one picture and who is left out, and why. Pure. */
export function pictureCast(cast: Bible['characters'], wanted: readonly string[], max = STILL_MAX_REFERENCES): PictureCast {
  const refs: PictureRef[] = [];
  const excluded: { slug: string; reason: string }[] = [];
  for (const slug of wanted) {
    const c = cast.find((x) => x.id === slug);
    if (!c) {
      excluded.push({ slug, reason: 'not in the channel cast' });
      continue;
    }
    const ref = lockedSheet(c);
    if (!ref) {
      excluded.push({ slug, reason: `${c.name} has no locked character sheet — left out of the picture rather than drawn as a stranger (Library → Characters)` });
      continue;
    }
    if (refs.length >= max) {
      excluded.push({ slug, reason: `the image model takes at most ${max} character references per picture` });
      continue;
    }
    refs.push({ slug, name: c.name, tag: sheetTag(c), ref, foreground: refs.length === 0, objectOnly: isObjectOnly(c), role: c.role, props: c.visual_lock.props, silhouette: c.visual_lock.silhouette, figure: c.visual_lock.figure ?? null, accent: c.accent_hex });
  }
  return { refs, excluded };
}

/** The cast an episode puts on screen: the lead, every speaker of the script, every shot's characters. */
export function episodeCastSlugs(input: { lead: string; speakers: readonly string[]; shotCharacters: readonly (readonly string[] | null | undefined)[] }): string[] {
  return [...new Set([input.lead, ...input.speakers, ...input.shotCharacters.flatMap((x) => x ?? [])])];
}

export type CastAvailability = { available: true; locked: string[]; unlocked: string[] } | { available: false; reason: string };

/**
 * Can this episode be made in the 'characters' format? Only when at least one of its cast has
 * a locked sheet. With none, every picture would have nobody in it, which is the illustrated
 * format under another name — so the planner plans it as illustrated and says why, and
 * Approvals offers the format disabled with the same reason.
 */
export function castAvailability(cb: Pick<ChannelBible, 'bible'>, slugs: readonly string[]): CastAvailability {
  const inCast = slugs.map((s) => cb.bible.characters.find((c) => c.id === s)).filter((c): c is Character => !!c);
  const locked = inCast.filter((c) => lockedSheet(c)).map((c) => c.id);
  if (!locked.length) return { available: false, reason: NO_SHEETS_REASON };
  return { available: true, locked, unlocked: inCast.filter((c) => !lockedSheet(c)).map((c) => c.id) };
}

export interface PlannedFormat {
  format: VisualFormat;
  source: FormatSource;
  /** Set when the approver asked for a format the planner could not make, e.g. 'characters'. */
  requested?: VisualFormat;
  fallback_reason?: string;
}

/**
 * The format an episode was PLANNED in — what `planShots` wrote to `qc.plan.format` — else the
 * one it would be planned in now. The stills step and the redraw read this, so a 'characters'
 * request that fell back to illustrated at planning is not drawn with characters later.
 */
export function plannedFormat(qc: unknown, fallback: { approvedEdits?: unknown; seriesFormat?: unknown }): PlannedFormat {
  const plan = qc && typeof qc === 'object' ? (qc as { plan?: { format?: { format?: unknown; source?: FormatSource; requested?: unknown; fallback_reason?: string } } }).plan : undefined;
  const f = VisualFormatSchema.safeParse(plan?.format?.format);
  if (f.success) {
    const req = VisualFormatSchema.safeParse(plan?.format?.requested);
    return { format: f.data, source: plan?.format?.source ?? 'default', ...(req.success ? { requested: req.data, fallback_reason: plan?.format?.fallback_reason } : {}) };
  }
  return formatOf(fallback);
}

/**
 * `StillDeps.resolveRef` for a worker: one of our sheets becomes a short-lived presigned GET
 * (minted at submit, never stored); an https reference passes through. Anything else refuses.
 */
export function refResolver(presign: (key: string) => Promise<string>): (ref: string) => Promise<string> {
  return async (ref) => {
    if (ref.startsWith(STORAGE_REF_PREFIX) && ref.length > STORAGE_REF_PREFIX.length) return presign(ref.slice(STORAGE_REF_PREFIX.length));
    if (/^https:\/\//.test(ref)) return ref;
    throw new Error(`"${ref}" is not a reference the image model can be given`);
  };
}
