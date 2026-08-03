import { z } from 'zod';

/**
 * What stage 9 may come back with, and the check the platform actually applies.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Title shape, and why it is measured rather than asked for
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The prompt tells the model not to reuse the construction of a recent title. That is the
 * intervention. This is the check on it, and the check is not allowed to trust the
 * intervention — the same arrangement as `structure_hash` for scripts, for the same reason:
 * the failure is invisible in any single item and obvious across twelve.
 *
 * The shape is a *skeleton*: content words removed, function words and punctuation kept, in
 * order. "Why cities are hotter than the countryside" and "Why potholes are worse than the
 * budget" both reduce to `why _ are _ than the _`, which is the thing a policy reviewer
 * notices scrolling a channel page. Two videos may share a topic; they may not share a
 * skeleton.
 */

export const MetadataSchema = z.object({
  title: z.string().min(10).max(70),
  description: z.string().min(40).max(1200),
  tags: z.array(z.string().min(2).max(40)).min(5).max(12),
});

export type Metadata = z.infer<typeof MetadataSchema>;

/**
 * Function words kept in the skeleton. Everything else becomes a blank.
 *
 * Deliberately small. A longer list makes more titles collapse to the same skeleton, which
 * sounds stricter and is the opposite: `_ _ _ _` matches everything, so every title
 * collides and the check stops discriminating. These are the words that carry a
 * construction rather than a subject.
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'being', 'been',
  'why', 'how', 'what', 'when', 'where', 'who', 'which',
  'and', 'or', 'but', 'so', 'because', 'if', 'than', 'then', 'that', 'this', 'these', 'those',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'from', 'by', 'about', 'into', 'over', 'under',
  'not', 'no', 'never', 'always', 'actually', 'really', 'just', 'still',
  'your', 'our', 'their', 'its', 'my', 'you', 'we', 'they', 'it',
  'more', 'most', 'less', 'least', 'every', 'all', 'some', 'any',
]);

/**
 * A title reduced to its construction.
 *
 * Numerals collapse to `#` rather than to a blank, because "5 things" and "7 things" are the
 * same shape and that is precisely the listicle pattern worth catching.
 */
export function titleShape(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) ? '#' : FUNCTION_WORDS.has(w) ? w : '_'))
    // Runs of blanks collapse: a two-word subject and a one-word subject are the same slot.
    .reduce<string[]>((acc, w) => {
      if (w === '_' && acc[acc.length - 1] === '_') return acc;
      acc.push(w);
      return acc;
    }, [])
    .join(' ');
}

export interface UniquenessVerdict {
  readonly unique: boolean;
  readonly shape: string;
  /** The recent titles sharing this shape. Empty when unique. */
  readonly collidesWith: string[];
}

/**
 * Does this title reuse a shape already on the channel?
 *
 * Returns a verdict rather than throwing. Whether a collision blocks publication is a
 * decision for the caller and ultimately for a human — the platform rule is about a
 * *pattern*, and one repeat is a coincidence while four is a template. Deciding that here
 * would bury the judgement in a pure function.
 */
export function checkUniqueness(
  title: string,
  recentTitles: readonly string[],
): UniquenessVerdict {
  const shape = titleShape(title);

  // A skeleton with no blanks at all is all function words — a degenerate title that would
  // collide with anything similarly degenerate. Treated as unique here because the real
  // problem with it is the title, which the schema's length rules already refuse.
  const collidesWith = shape.includes('_')
    ? recentTitles.filter((t) => titleShape(t) === shape)
    : [];

  return { unique: collidesWith.length === 0, shape, collidesWith };
}
