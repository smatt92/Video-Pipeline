/**
 * The setup flow as the redesign draws it (canvas: OnbSpine, Onb-*): ten pages in four
 * groups — Studio (once), Channel (repeatable from + Add channel), Optional, Finish.
 *
 * Presentation only. A page groups one or more of the wizard's existing steps (steps.ts) and
 * completing a page means completing those steps through the same actions, with the same
 * checks, writing the same `onboarding_completed_steps`. Nothing here decides what is
 * verified; it decides what is shown together.
 *
 * The channel pages (cast, schedule, caps) have no step in STEPS — they configure a channel
 * through the 0022 bible actions — so their "done" is read from the channel's own rows by
 * the spine (src/lib/onboarding/spine.ts), never stored as a tick.
 */

export type SetupGroup = 'Studio' | 'Channel' | 'Optional' | 'Finish';

export interface SetupPage {
  readonly n: number;
  readonly slug: string;
  readonly label: string;
  readonly group: SetupGroup;
  /** The wizard steps this page completes (steps.ts numbers). Empty for channel pages. */
  readonly steps: readonly number[];
  readonly sub: string;
  /** One sentence: what this page blocks, while it is not done. null = blocks nothing. */
  readonly blocks: string | null;
  readonly optional?: boolean;
}

export const SETUP_PAGES: readonly SetupPage[] = [
  { n: 1, slug: 'studio', label: 'Profile & storage', group: 'Studio', steps: [1, 2], sub: 'Name, timezone, ₹ rate, media storage', blocks: 'No timezone or exchange rate yet, so slots and ₹ can’t be worked out.' },
  { n: 2, slug: 'models', label: 'Writing & embeddings', group: 'Studio', steps: [3, 11], sub: 'Writing model + embeddings keys', blocks: 'No verified writing model, so no brief or script can be drafted.' },
  { n: 3, slug: 'generation', label: 'Video & voice', group: 'Studio', steps: [4, 5], sub: 'Video + voices, one key', blocks: 'Generation isn’t verified, so nothing can be voiced or generated.' },
  { n: 4, slug: 'rate-card', label: 'Rate card', group: 'Studio', steps: [6], sub: 'Verified price per model', blocks: 'A rate an enabled driver uses is unverified, so no ₹ figure renders and paid stages refuse.' },
  { n: 5, slug: 'basics', label: 'Basics', group: 'Channel', steps: [8], sub: 'Name, handle, platforms, accent', blocks: 'No channel yet, so there’s nowhere to publish.' },
  { n: 6, slug: 'cast', label: 'Cast & voices', group: 'Channel', steps: [7], sub: 'Characters, voices, host voice', blocks: 'Some of the cast has no locked voice, so their lines can’t be recorded.' },
  { n: 7, slug: 'schedule', label: 'Series & slots', group: 'Channel', steps: [], sub: 'Series, publish slots, timezone', blocks: 'No publish slot ahead, so there’s nothing to fill.' },
  { n: 8, slug: 'caps', label: 'Caps & trends', group: 'Channel', steps: [], sub: 'Spend caps, trend sources', blocks: 'No spend caps, so Kiln won’t start a paid run.' },
  { n: 9, slug: 'connections', label: 'Connections', group: 'Optional', steps: [9], sub: 'Analytics, alerts, Instagram', blocks: null, optional: true },
  { n: 10, slug: 'finish', label: 'First episode', group: 'Finish', steps: [10], sub: 'Brief → cut → bundle', blocks: null },
];

export function setupPage(slug: string): SetupPage | undefined {
  return SETUP_PAGES.find((p) => p.slug === slug);
}

/** The page that shows a wizard step — so every old /setup/<step-slug> link still lands. */
export function pageForStep(stepN: number): SetupPage {
  return SETUP_PAGES.find((p) => p.steps.includes(stepN)) ?? SETUP_PAGES.find((p) => p.slug === 'cast')!;
}

export function pageNeighbours(p: SetupPage): { prev: SetupPage | null; next: SetupPage | null } {
  const i = SETUP_PAGES.findIndex((x) => x.n === p.n);
  return { prev: SETUP_PAGES[i - 1] ?? null, next: SETUP_PAGES[i + 1] ?? null };
}
