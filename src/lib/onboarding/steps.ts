/**
 * The first-run wizard — Addendum 03 §2.
 *
 * The premise: the app should be unusable until it is usable. Today a missing credential
 * surfaces in the middle of a pipeline run, which is the most expensive place to discover
 * it — money has already been spent by then. The gate moves that discovery to the front.
 *
 * Two properties matter more than the list itself:
 *
 *   Dependency order is enforced, not suggested. Storage verifies before the generation key is
 *   offered at all, because nothing can be stored until storage works and a generation key
 *   that "passes" beforehand has proven nothing.
 *
 *   Every step verifies with a real call. A format check on an API key tells you the key
 *   is shaped like a key.
 */

export interface OnboardingStep {
  readonly n: number;
  readonly slug: string;
  readonly title: string;
  readonly blurb: string;
  /** What the step actually calls. Never "we validated the format". */
  readonly verification: string;
  /** Step numbers that must pass first. */
  readonly blockedBy: readonly number[];
  readonly required: boolean;
  /** Not implementable before Gate 5. */
  readonly stubbed?: string;
}

export const STEPS: readonly OnboardingStep[] = [
  {
    n: 1,
    slug: 'profile',
    title: 'Profile',
    blurb: 'Name, timezone, currency, and the USD→INR rate every rupee figure derives from.',
    verification: 'Writes a profiles row. The FX rate becomes authoritative over the env default.',
    blockedBy: [],
    required: true,
  },
  {
    n: 2,
    slug: 'storage',
    title: 'Storage',
    blurb: 'The bucket everything generated is written to. First, because nothing can be stored until it works.',
    verification: 'Presigns a PUT, uploads a probe object, reads it back and compares bytes, deletes it, confirms a subsequent GET no longer finds it.',
    blockedBy: [],
    required: true,
  },
  {
    n: 3,
    slug: 'anthropic',
    title: 'Anthropic',
    blurb: 'Scripts, shotlists, prompt compilation, metadata.',
    verification: 'One cheap Messages call, and stores the model list.',
    blockedBy: [],
    required: true,
  },
  {
    n: 4,
    slug: 'video',
    title: 'Generation',
    blurb: 'Character video, money shots, reference frames, voice, dubs and sound effects — one API key, one credit pool (decision 0015). Needs storage working first: a clip that generates and cannot be written is a clip you paid for and lost.',
    verification: 'Reads the organisation with the key, which proves it and returns the API credit balance. API credits are a separate pool from app credits.',
    blockedBy: [2],
    required: true,
  },
  {
    n: 5,
    slug: 'audio',
    title: 'Voiceover',
    blurb: 'Voice, and the word timings that shot durations are derived from. Spoken on the generation key — if step 4 verified, this verifies with the same call.',
    verification: 'The same organisation read as step 4. Word timings come from forced alignment on the worker, not from the vendor (0013).',
    blockedBy: [2],
    required: true,
  },
  {
    // Numbered 11 because step numbers are stored in profiles.onboarding_completed_steps;
    // renumbering would silently re-mean every recorded completion. Listed here, after the
    // voice step, because that is where it belongs in the order a person walks it.
    n: 11,
    slug: 'embeddings',
    title: 'Embeddings',
    blurb: 'Script and title similarity for the variation check. A free-tier key is enough. Without it every brief is refused by name — a repetition check that did not run has not passed.',
    verification: 'Lists one model with the key.',
    blockedBy: [],
    required: true,
  },
  {
    n: 6,
    slug: 'rate-card',
    title: 'Rate card',
    blurb: 'What each call costs. The generation and embeddings rates ship seeded from published prices (0040, 0044); check them against your own account and supersede any that differ.',
    verification: 'Cannot proceed while any rate used by an enabled driver is unverified. Until then no rupee figure renders anywhere and submits refuse.',
    blockedBy: [4, 5, 11],
    required: true,
  },
  {
    n: 7,
    slug: 'host-voice',
    title: 'Host voice',
    blurb: 'The channel\'s default host voice. The Bureau\'s characters carry their own locked voices (pnpm voice:audition → voice:lock, decision 0013).',
    verification: 'Set on Settings → Voice. Optional.',
    blockedBy: [5],
    required: false,
  },
  {
    n: 8,
    slug: 'channel',
    title: 'First channel',
    blurb: 'The channel everything is made for. Concepts cannot exist without one. On a Bureau workspace it already exists — migration 0037 seeds it — so this step shows it and lets you correct the handle.',
    verification: 'Uses the active channel if there is one and creates nothing; only a workspace with no active channel gets a new row.',
    blockedBy: [1],
    required: true,
  },
  {
    n: 9,
    slug: 'optional',
    title: 'Optional connections',
    blurb: 'MCP servers, YouTube, Instagram.',
    verification: 'Deferred. YouTube and Instagram are needed for Phase 3 publishing and nothing before it.',
    blockedBy: [],
    required: false,
  },
  {
    n: 10,
    slug: 'first-video',
    title: 'Guided first video',
    blurb: 'One real 15-second video, end to end: concept → VO → two shots → rough cut → review → download.',
    verification: 'Every integration proves it works together, and you finish holding an artifact rather than a checklist.',
    blockedBy: [1, 2, 3, 4, 5, 11, 6, 8],
    required: false,
    stubbed:
      'Stubbed until Gate 5. It needs the pipeline leg, the drivers and the rough-cut assembler, none of which exist yet — and it spends real credits, so it cannot be faked.',
  },
];

export const REQUIRED_STEPS = STEPS.filter((s) => s.required).map((s) => s.n);

export function stepBySlug(slug: string): OnboardingStep | undefined {
  return STEPS.find((s) => s.slug === slug);
}

export function isUnlocked(step: OnboardingStep, completed: readonly number[]): boolean {
  return step.blockedBy.every((n) => completed.includes(n));
}

/**
 * The step before and after this one, in walk order.
 *
 * By position in `STEPS`, never by arithmetic on `n`. Step 11 is listed sixth, so
 * `STEPS[step.n]` — what the footer used to do — sent step 11's "next" nowhere and every
 * later step's "next" back to itself.
 */
export function stepNeighbours(step: OnboardingStep): { prev: OnboardingStep | null; next: OnboardingStep | null } {
  const i = STEPS.findIndex((s) => s.n === step.n);
  return { prev: i > 0 ? STEPS[i - 1] : null, next: i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : null };
}

/**
 * Where `/setup` sends you: the slug of the first step still to do, in walk order.
 *
 * A slug, because the wizard is addressed by slug — `/setup/1` was a 404 for as long as the
 * index redirected there. First an outstanding required step (not done, not deferred), then
 * any step not done that has something to run, then the first step. Always a slug that
 * `stepBySlug` resolves; `test:entry` checks that for every combination of completed steps.
 */
export function firstIncompleteSlug(completed: readonly number[], deferred: readonly number[] = []): string {
  const open = (s: OnboardingStep) => !completed.includes(s.n);
  const required = STEPS.find((s) => s.required && open(s) && !deferred.includes(s.n));
  if (required) return required.slug;
  const any = STEPS.find((s) => open(s) && !s.stubbed && !deferred.includes(s.n));
  return (any ?? STEPS[0]).slug;
}
