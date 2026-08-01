/**
 * The first-run wizard — Addendum 03 §2.
 *
 * The premise: the app should be unusable until it is usable. Today a missing credential
 * surfaces in the middle of a pipeline run, which is the most expensive place to discover
 * it — money has already been spent by then. The gate moves that discovery to the front.
 *
 * Two properties matter more than the list itself:
 *
 *   Dependency order is enforced, not suggested. Storage verifies before the video driver is
 *   offered at all, because nothing can be stored until storage works and a video
 *   credential that "passes" beforehand has proven nothing.
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
    title: 'Video generation',
    blurb: 'The generator. Needs storage working first — a clip that generates and cannot be written is a clip you paid for and lost.',
    verification: 'Fetches the credit balance and its expiry date. Credits expire ~90 days from purchase and that clock starts now.',
    blockedBy: [2],
    required: true,
  },
  {
    n: 5,
    slug: 'audio',
    title: 'Voiceover',
    blurb: 'Voice, and the word timings that shot durations are derived from.',
    verification: 'Lists voices and reads the subscription tier, then stores that tier’s concurrency limit — this is what the queue reads later, never a hardcoded number.',
    blockedBy: [2],
    required: true,
  },
  {
    n: 6,
    slug: 'rate-card',
    title: 'Rate card',
    blurb: 'What each call costs. Pasted from your own account dashboards — no vendor publishes these.',
    verification: 'Cannot proceed while any rate used by an enabled driver is unverified. Until then no rupee figure renders anywhere and submits refuse.',
    blockedBy: [4, 5],
    required: true,
  },
  {
    n: 7,
    slug: 'host-voice',
    title: 'Host voice',
    blurb: 'A library voice to start, or begin a Professional Voice Clone.',
    verification: 'Synthesises one short line and plays it back. PVC is a multi-day external process — recorded as pending and you continue on a stock voice.',
    blockedBy: [5],
    required: false,
  },
  {
    n: 8,
    slug: 'channel',
    title: 'First channel',
    blurb: 'Name, platform, niche. One channel minimum — concepts cannot exist without one.',
    verification: 'Writes a channels row.',
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
    blockedBy: [1, 2, 3, 4, 5, 6, 8],
    required: false,
    stubbed:
      'Stubbed until Gate 5. It needs the pipeline leg, the drivers and the rough-cut assembler, none of which exist yet — and it spends real credits, so it cannot be faked.',
  },
];

export const REQUIRED_STEPS = STEPS.filter((s) => s.required).map((s) => s.n);

export function stepBySlug(slug: string): OnboardingStep | undefined {
  return STEPS.find((s) => s.slug === slug);
}

/**
 * Fixture progress. In 1c this reads `profiles.onboarding_step`.
 *
 * Deliberately zero: nothing has been verified, and showing a half-complete wizard would
 * misrepresent which vendor calls have actually happened.
 */
export const CURRENT_STEP = 0;

export function isUnlocked(step: OnboardingStep, completed: readonly number[]): boolean {
  return step.blockedBy.every((n) => completed.includes(n));
}
