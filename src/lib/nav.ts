/**
 * The route inventory, per Addendum 03 §3.
 *
 * Unbuilt routes are listed and visibly disabled with the reason they are disabled — not
 * hidden, and not labelled "coming soon". "Coming soon" tells you nothing; "needs Meta
 * app review" tells you what the blocker is and whether you can do anything about it.
 * A nav that shows the whole shape of the product is also the fastest way to notice when
 * the shape is wrong.
 */

export type NavStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'disabled'; readonly reason: string; readonly phase: string };

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** One-line description, shown on the disabled state and in the command palette. */
  readonly hint: string;
  readonly status: NavStatus;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const ready = (): NavStatus => ({ kind: 'ready' });
const blocked = (phase: string, reason: string): NavStatus => ({
  kind: 'disabled',
  reason,
  phase,
});

export const NAV: readonly NavGroup[] = [
  {
    label: 'Pipeline',
    items: [
      {
        // First in the group because it is first in the pipeline, and because "is intake
        // working?" is the question that precedes every other one on this list.
        href: '/trends',
        label: 'Trends',
        hint: 'Stage 1 intake — what was captured, from where, how recently',
        status: ready(),
      },
      {
        href: '/board',
        label: 'Board',
        hint: 'Every video by state',
        status: ready(),
      },
      {
        href: '/concepts',
        label: 'Concepts',
        hint: 'Concept queue, script editor, shotlist',
        status: blocked('1c', 'Needs the script generation leg'),
      },
      {
        href: '/studio',
        label: 'Studio',
        hint: 'Conversational lane — brief in, shots out',
        status: ready(),
      },
      {
        href: '/review',
        label: 'Review',
        hint: 'Player, shot strip, per-shot regenerate',
        status: ready(),
      },
    ],
  },
  {
    label: 'Library',
    items: [
      {
        href: '/library/prompts',
        label: 'Prompts',
        hint: 'Shot recipes, win rate, provenance',
        status: blocked('1b', 'Needs the driver implementations'),
      },
      {
        href: '/library/voices',
        label: 'Voices',
        hint: 'Host voice, pronunciation dictionary, model policy',
        status: blocked('1b', 'Needs the audio driver'),
      },
      {
        href: '/library/music',
        label: 'Music',
        hint: 'Beds and SFX',
        status: blocked('2', 'Assembly phase'),
      },
    ],
  },
  {
    label: 'Measure',
    items: [
      {
        href: '/costs',
        label: 'Costs',
        hint: 'Cost per video, with the denominator',
        status: ready(),
      },
      {
        href: '/analytics',
        label: 'Analytics',
        hint: 'Hook retention, cost per 1k views',
        // Ready, and empty — which are different states and the screen says which. It
        // renders the denominator (live videos, measurements due, how many read) and says
        // in words that every rate is undefined rather than zero until something publishes.
        // Left `blocked` it would have been a stage nobody could reach the moment stage 10
        // landed, and "needs published videos" is what the page itself now tells you.
        status: ready(),
      },
      {
        href: '/publish',
        label: 'Publish',
        hint: 'Queue, schedule, rate-limit budget',
        status: blocked('3', 'Blocked on Meta app review — 2–4 weeks, started week 1'),
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        href: '/setup',
        label: 'First run',
        hint: 'The setup wizard — every step verified by a real call',
        status: ready(),
      },
      {
        href: '/settings',
        label: 'Settings',
        hint: 'Integrations, rate card, guardrails, voice',
        status: ready(),
      },
    ],
  },
];

export const ALL_NAV_ITEMS: readonly NavItem[] = NAV.flatMap((g) => g.items);
