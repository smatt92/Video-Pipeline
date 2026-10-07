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
// No route is disabled today (07-Oct-2026: Concepts and the three Library screens went ready).
// A route that needs to be disabled again gets `{ kind: 'disabled', reason, phase }` inline —
// the sidebar and the command palette still render that state with its reason.


export const NAV: readonly NavGroup[] = [
  {
    // Bureau of Reality — the control room. First because it is where the daily decisions are.
    label: 'Bureau',
    items: [
      { href: '/bureau/approvals', label: 'Approvals', hint: 'Pending briefs: pick a punchline, approve or reject', status: ready() },
      { href: '/bureau/cuts', label: 'Cuts', hint: 'Finished cuts: 9:16 player, shot strip, re-roll, approve', status: ready() },
      { href: '/bureau/ready', label: 'Ready to schedule', hint: 'Publish bundles and dubs for Studio', status: ready() },
      { href: '/bureau/board', label: 'Episodes', hint: 'Every episode by state', status: ready() },
      { href: '/bureau/monitor', label: 'Generation', hint: 'Queues, failures, spend vs caps, kill switch', status: ready() },
      { href: '/bureau/calendar', label: 'Calendar', hint: 'Slots, seasonal tags, bank, produce-by', status: ready() },
      { href: '/bureau/metrics', label: 'Metrics', hint: 'KPIs against the gates, mentions, top performers', status: ready() },
      { href: '/bureau/authorship', label: 'Authorship log', hint: 'Every decision, verbatim', status: ready() },
    ],
  },
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
        hint: 'Concepts per channel: script, shots, spend, episode',
        // Ready: lists the active channel's concepts from rows (script, shot count, ledger spend
        // with no-row as an em dash, the episode link), and /concepts/[id] refuses another channel's.
        status: ready(),
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
        hint: 'Shot recipes, params, rate, provenance',
        // Ready: list, params, retire/reinstate behind the watched-sample guard, and the rate each
        // recipe bills at from the rate card ("unpriced — why" when there is none).
        status: ready(),
      },
      {
        href: '/library/voices',
        label: 'Voices',
        hint: 'Each character’s voice, override, last take',
        // Ready: shows the route the voice stage will use (routeForCharacter, the same predicate),
        // and writes channel_voice_overrides, which the voice stage already reads.
        status: ready(),
      },
      {
        href: '/library/music',
        label: 'Music',
        hint: 'Beds per series: upload, preview, default',
        // Ready as a record: uploads (presigned PUT) and series defaults are written; the page says
        // plainly that the assembler does not mix a bed yet.
        status: ready(),
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
        hint: 'Queue, schedule, quota budget',
        // Ready for the YouTube half. Meta is still blocked on app review and always was —
        // leaving the whole route disabled for it hid a lane that works, which is the same
        // mistake as one status for two different facts.
        status: ready(),
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
