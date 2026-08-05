/**
 * `scripts.hook_pattern` — the key "score hooks, not videos" groups on.
 *
 * ── Why a pattern and not the hook ───────────────────────────────────────────
 *
 * ARCHITECTURE §0.1 calls the accumulated hook-performance data the moat. `scripts.hook`
 * is free text and every one is unique, so grouping retention by it puts one video in
 * each group and produces "score videos" with the word hook written on it. What repeats
 * across videos — and what a person can actually act on next time — is the *shape*.
 *
 * ── Deterministic, not a model call ──────────────────────────────────────────
 *
 * Three reasons, in the order they mattered.
 *
 *   Every classification must be reproducible. A rollup whose buckets were drawn by a
 *   sampled model is a rollup whose history changes when you re-run it, and the whole
 *   value here is comparing this month's hooks against last year's.
 *
 *   It runs on scripts that already exist. A backfill over the archive is a loop over
 *   rows, not a spend, and the loop closes on day one instead of on the first script
 *   drafted after this shipped.
 *
 *   It costs nothing, and stage 3 is already a billed call. Adding a second one to
 *   classify seven buckets would be the most expensive cheap decision in the pipeline.
 *
 * The cost is real and worth stating: surface features misread sarcasm, and a hook that
 * asks a question in order to contradict something lands in `question`. That is accepted
 * because the alternative — an unreproducible bucket — makes the comparison meaningless
 * rather than noisy, and because `hook_pattern_version` means a better classifier can
 * reclassify the archive and the two versions stay distinguishable.
 *
 * ── Null is a real answer ────────────────────────────────────────────────────
 *
 * Returns null when nothing matches, and the column stays null. There is deliberately no
 * `other` bucket: it would collect everything the taxonomy failed on and then be averaged
 * as though it described a shape, which is the "absent is not zero" rule in the one place
 * where the zero would look like a finding.
 */

/**
 * Bumped when the rules below change what an existing hook classifies as.
 *
 * Stored per row, as `concepts.rubric_version` is, because a rollup that mixes two
 * versions is comparing groups that were drawn differently — and that is invisible in the
 * output, which is what makes the column necessary rather than tidy.
 */
export const HOOK_PATTERN_VERSION = 'hookpattern-v1';

/** The closed vocabulary. Must match the CHECK on `scripts.hook_pattern` (migration 0034). */
export const HOOK_PATTERNS = [
  'question',
  'contradiction',
  'number_claim',
  'warning',
  'story_open',
  'direct_address',
  'demonstration',
] as const;

export type HookPattern = (typeof HOOK_PATTERNS)[number];

/**
 * Ordered, and the order is the specification.
 *
 * A hook can satisfy several tests — "Why do 90% of these fail?" is a question and a
 * number claim — so first match wins and the sequence encodes which reading is the more
 * useful one to group by. Number first: a figure is the thing a viewer remembers and the
 * thing a writer can deliberately reuse, whereas the question mark is punctuation.
 *
 * Written as a list rather than a chain of ifs so the precedence is visible at a glance
 * and reordering is one line, because reordering is the change most likely to be needed.
 */
const RULES: ReadonlyArray<{ pattern: HookPattern; test: RegExp; why: string }> = [
  {
    pattern: 'number_claim',
    // A digit carrying a quantity. Excludes a bare year, which is a date rather than a
    // claim, and excludes a digit inside a word.
    test: /(?<![\w])(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:%|percent|x|×|times|out of|in \d)|(?<![\w])(?:\d+(?:\.\d+)?)\s*(?:crore|lakh|million|billion|k\b)/i,
    why: 'a figure carries the promise',
  },
  {
    pattern: 'contradiction',
    // `but` and `actually` are anchored to the start, and the anchor is the finding rather
    // than a nicety. Mid-sentence they are filler: the first draft read "How long should a
    // hook actually be" as a contradiction — a plain question, misfiled by a word doing no
    // work in it. The rest carry their meaning wherever they appear.
    test: /^\s*(?:but|actually)\b|\b(?:isn'?t|aren'?t|doesn'?t|not what|wrong|myth|nobody tells you|everyone (?:thinks|says|believes))\b/i,
    why: 'states the received view, then denies it',
  },
  {
    pattern: 'warning',
    test: /\b(?:stop|never|avoid|before you|don'?t|mistake|costing you|losing|ruin(?:s|ing)?|danger|careful)\b/i,
    why: 'a cost of not watching',
  },
  {
    pattern: 'demonstration',
    test: /\b(?:watch (?:this|what)|here'?s what|look at|this is what|I (?:made|built|tried|tested)|we (?:made|built|tried|tested))\b/i,
    why: 'shows the outcome first, explains after',
  },
  {
    pattern: 'story_open',
    test: /\b(?:last (?:week|month|year|night)|yesterday|when I|the day (?:I|we)|I was|we were|so I|it started)\b/i,
    why: 'mid-scene, the resolution withheld',
  },
  {
    pattern: 'question',
    // The mark, or an interrogative opening without one — spoken hooks often drop it.
    test: /\?|^\s*(?:why|how|what|when|where|who|which|can|should|would|could|do|does|did|is|are|have|has)\b/i,
    why: 'opens by asking; the viewer answers in their head',
  },
  {
    pattern: 'direct_address',
    test: /\b(?:you|your|you'?re|you'?ve|yours)\b/i,
    why: 'names the viewer or their situation',
  },
];

/**
 * Classify a hook, or return null.
 *
 * Null is returned for an empty hook and for one nothing matches. Both are "unclassified"
 * and the caller must not substitute a bucket — see the module note.
 */
export function classifyHook(hook: string): HookPattern | null {
  const text = hook.trim();
  if (text.length === 0) return null;

  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.pattern;
  }
  return null;
}

/** Why a pattern means what it means, for a screen that has to explain a bucket. */
export function describeHookPattern(pattern: HookPattern): string {
  return RULES.find((r) => r.pattern === pattern)?.why ?? pattern;
}
