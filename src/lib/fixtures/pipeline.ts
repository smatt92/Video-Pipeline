/**
 * Fixture data for the pipeline board.
 *
 * No database reads. This is Gate 1 — the question being answered is whether the
 * interface reads as templated, and wiring it to Postgres would answer a different
 * question more slowly.
 *
 * Two things are modelled honestly rather than conveniently, because getting them wrong
 * here would teach the wrong lesson about what the real screen has to do:
 *
 *   1. A generating video knows *which shot it is on*. "Generating shot 3 of 6" is the
 *      whole difference between a progress indicator and a spinner. The real screen reads
 *      this from `generations` rows; the shape here matches.
 *   2. Cost is a union, not a number. Where the rate card has no verified entry the cost
 *      is genuinely unknown, and the board says so rather than rendering ₹0 — a wrong
 *      number gets believed in a way a missing one does not.
 */

export type VideoState =
  | 'drafting'
  | 'generating'
  | 'needs_review'
  | 'blocked'
  | 'ready'
  | 'live'
  | 'killed';

/** Mirrors `CostEstimate` in the driver layer. Same union, same reason. */
export type Cost =
  | { readonly kind: 'priced'; readonly inr: number; readonly verified: true }
  | { readonly kind: 'unpriced'; readonly reason: string; readonly generations: number };

export interface PipelineVideo {
  readonly id: string;
  readonly title: string;
  readonly angle: string;
  readonly channel: string;
  readonly state: VideoState;
  /** Present only while generating. Drives the real-step label. */
  readonly progress?: {
    readonly step: string;
    readonly current: number;
    readonly total: number;
  };
  /** Present on blocked and killed. Why, in words, not a code. */
  readonly detail?: string;
  readonly cost: Cost;
  readonly shots: number;
  readonly durationS: number;
  readonly updatedAgo: string;
  readonly origin: 'pipeline' | 'studio';
}

export const VIDEOS: readonly PipelineVideo[] = [
  {
    id: 'v_8f2a',
    title: 'The Vice City map leak nobody checked',
    angle: 'Debunk — the "leak" is a 2013 mod screenshot',
    channel: 'gta6',
    state: 'generating',
    progress: { step: 'Generating shot', current: 3, total: 6 },
    cost: { kind: 'unpriced', reason: 'dop-turbo rate unverified', generations: 4 },
    shots: 6,
    durationS: 32,
    updatedAgo: '40s ago',
    origin: 'pipeline',
  },
  {
    id: 'v_3c71',
    title: 'Why Rockstar delayed it twice',
    angle: 'Timeline, sourced from earnings calls only',
    channel: 'gta6',
    state: 'needs_review',
    cost: { kind: 'priced', inr: 612, verified: true },
    shots: 5,
    durationS: 28,
    updatedAgo: '12m ago',
    origin: 'pipeline',
  },
  {
    id: 'v_a904',
    title: 'Every confirmed vehicle so far',
    angle: 'Inventory — only what appeared in official trailers',
    channel: 'gta6',
    state: 'blocked',
    detail: 'Structure hash matches v_7b20, published 4 days ago',
    cost: { kind: 'priced', inr: 388, verified: true },
    shots: 4,
    durationS: 24,
    updatedAgo: '1h ago',
    origin: 'pipeline',
  },
  {
    id: 'v_dd15',
    title: 'The soundtrack theory that holds up',
    angle: 'Music licensing filings vs the trailer cut',
    channel: 'gta6',
    state: 'ready',
    cost: { kind: 'priced', inr: 741, verified: true },
    shots: 7,
    durationS: 41,
    updatedAgo: '3h ago',
    origin: 'studio',
  },
  {
    id: 'v_60be',
    title: 'What the second trailer actually showed',
    angle: 'Frame-by-frame, no speculation',
    channel: 'gta6',
    state: 'live',
    cost: { kind: 'priced', inr: 559, verified: true },
    shots: 6,
    durationS: 35,
    updatedAgo: '2d ago',
    origin: 'pipeline',
  },
  {
    id: 'v_1e47',
    title: 'Untitled — map speculation',
    angle: '',
    channel: 'gta6',
    state: 'drafting',
    cost: { kind: 'unpriced', reason: 'nothing generated yet', generations: 0 },
    shots: 0,
    durationS: 0,
    updatedAgo: '5m ago',
    origin: 'studio',
  },
  {
    id: 'v_7b20',
    title: 'Top 10 GTA 6 features you missed',
    angle: 'Listicle',
    channel: 'gta6',
    state: 'killed',
    detail: 'Killed at review — templated structure, would not survive an appeal',
    cost: { kind: 'priced', inr: 204, verified: true },
    shots: 3,
    durationS: 18,
    updatedAgo: '4d ago',
    origin: 'pipeline',
  },
];

export const STATE_LABEL: Record<VideoState, string> = {
  drafting: 'Drafting',
  generating: 'Generating',
  needs_review: 'Needs review',
  blocked: 'Blocked',
  ready: 'Ready',
  live: 'Live',
  killed: 'Killed',
};

/**
 * Order the board reads in: what needs a human first, what is moving second, what is
 * finished last. Answering "is everything okay?" before "what happened?" is the whole
 * point of a board rather than a table.
 */
export const STATE_ORDER: readonly VideoState[] = [
  'blocked',
  'needs_review',
  'generating',
  'ready',
  'drafting',
  'live',
  'killed',
];

export function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}
