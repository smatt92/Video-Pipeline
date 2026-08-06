/**
 * Outlier score — a video's views against its own channel's typical performance.
 *
 * ── Why this outranks the scoring beside it ──────────────────────────────────
 *
 * `concepts.scores` rates an idea on velocity, saturation, IP risk and evergreen tail: four
 * reasonable guesses made before the fact. This measures something that already happened.
 * 66k views on a channel that usually gets 1k is not a video that succeeded because a large
 * channel published it — it is a video whose *idea* carried it, which is the only signal in
 * this space grounded in an observed outcome. Addendum 04 §1.
 *
 * ── Pure, and separated from the fetch on purpose ────────────────────────────
 *
 * Nothing here touches the network or the database. The arithmetic is where this can be
 * quietly wrong — a median that includes the video being scored, a baseline of zero
 * producing an infinite score, a trimmed mean that trims from a list too short to trim —
 * and none of those need an API to provoke. `verify:outlier` drives these functions
 * directly and asserts their return values, so the assertions are about what the code did
 * rather than about a row a fixture wrote.
 */

/** Addendum 04: below this a "typical performance" is one or two videos and noise. */
export const MIN_VIDEOS_FOR_BASELINE = 10;

/** Addendum 04: the baseline is over the channel's recent uploads. */
export const BASELINE_SAMPLE = 20;

export type Baseline =
  | { ok: true; medianViews: number; sampleSize: number; trimmed: number }
  /** Never a number. The reasons are distinct because they need different responses. */
  | { ok: false; reason: 'too_few_videos' | 'no_readable_views' | 'baseline_is_zero'; sampleSize: number };

/**
 * The channel's typical performance, or a stated reason there isn't one.
 *
 * ── Three decisions, each of which changes the answer ────────────────────────
 *
 * **Median, not mean.** One video that got picked up is exactly what this is trying to
 * detect, and a mean lets that one video raise the baseline it is being measured against —
 * the outlier partly cancels itself out.
 *
 * **Videos with unreadable view counts are excluded, not zeroed.** A null view count means
 * the API did not return one; counting it as 0 drags the median down and inflates every
 * score on the channel. `sampleSize` reports how many actually contributed, so a caller
 * can tell a ten-video baseline from a ten-video channel where four reads failed.
 *
 * **The top and bottom are trimmed** (Addendum 04), but only when there is enough left
 * afterwards to still meet the minimum. Trimming a list of exactly ten leaves eight, which
 * is below the threshold the trim exists to make meaningful — so the trim is skipped rather
 * than the baseline refused, and `trimmed` says which happened.
 */
export function computeBaseline(viewCounts: readonly (number | null)[]): Baseline {
  const readable = viewCounts
    .filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0)
    .slice(0, BASELINE_SAMPLE);

  if (viewCounts.length > 0 && readable.length === 0) {
    return { ok: false, reason: 'no_readable_views', sampleSize: 0 };
  }
  if (readable.length < MIN_VIDEOS_FOR_BASELINE) {
    return { ok: false, reason: 'too_few_videos', sampleSize: readable.length };
  }

  const sorted = [...readable].sort((a, b) => a - b);

  // Trim only when what remains still clears the bar. Otherwise the trim would produce
  // exactly the too-small sample it exists to guard against.
  const canTrim = sorted.length - 2 >= MIN_VIDEOS_FOR_BASELINE;
  const sample = canTrim ? sorted.slice(1, -1) : sorted;

  const mid = Math.floor(sample.length / 2);
  const medianViews =
    sample.length % 2 === 0 ? (sample[mid - 1] + sample[mid]) / 2 : sample[mid];

  // Zero is a real reading and a fatal divisor. Reported as its own reason rather than
  // returned as a baseline, because every score computed against it would be infinite and
  // a brand-new channel's first video would pin itself to the top of the ideas list.
  if (medianViews === 0) {
    return { ok: false, reason: 'baseline_is_zero', sampleSize: sample.length };
  }

  return {
    ok: true,
    medianViews,
    sampleSize: sample.length,
    trimmed: canTrim ? 2 : 0,
  };
}

/**
 * views ÷ baseline, or null.
 *
 * Null when either side is unknown — never 0, and never Infinity. A score of 0 says "this
 * video was watched by nobody", which is a finding; the absence of a score says nothing,
 * which is the truth when there is no baseline to divide by.
 */
export function outlierScore(views: number | null, baselineMedianViews: number | null): number | null {
  if (views === null || baselineMedianViews === null) return null;
  if (!Number.isFinite(views) || !Number.isFinite(baselineMedianViews)) return null;
  if (baselineMedianViews <= 0) return null;
  if (views < 0) return null;
  return Math.round((views / baselineMedianViews) * 1000) / 1000;
}

/** Addendum 04: recent only. An outlier from three years ago describes an audience that moved on. */
export const RECENT_DAYS = 90;

export function isRecent(publishedAt: string, now: Date = new Date()): boolean {
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= RECENT_DAYS * 24 * 60 * 60 * 1000;
}

export interface Combination {
  a: string;
  b: string;
}

/**
 * Pair the top outliers, for the concept prompt.
 *
 * ── Why combinations rather than freeform ideas ──────────────────────────────
 *
 * Addendum 04 §2, and the second reason is the one that matters here. A combination is
 * grounded in two observed successes rather than one guess — but more importantly it is
 * *structurally* anti-template: two unrelated proven topics forced together produce a
 * different argumentative shape each time, which is exactly what `structure_hash` is
 * measuring. Freeform ideas from one model with one prompt converge on one shape, and that
 * shape is what a policy reviewer recognises.
 *
 * Adjacent pairs are deliberately NOT used. Ranking by outlier score puts similar topics
 * next to each other — two videos about the same trend both beat their channels in the same
 * week — so pairing neighbours produces the near-duplicate combinations this exists to
 * avoid. Pairing across the list (first with last, second with second-last) maximises the
 * distance between the two halves of every pair.
 */
export function combinations(titles: readonly string[], limit = 10): Combination[] {
  const out: Combination[] = [];
  let lo = 0;
  let hi = titles.length - 1;
  while (lo < hi && out.length < limit) {
    out.push({ a: titles[lo], b: titles[hi] });
    lo += 1;
    hi -= 1;
  }
  return out;
}
