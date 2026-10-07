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
  /** Canvas icon name (src/components/ui/icon.tsx). */
  readonly icon: string;
  /** Badge key the Rail fills from row counts (src/lib/shell/rail.ts). */
  readonly badge?: 'approvals' | 'cuts' | 'blocked' | 'ready' | 'genFailed';
  /** Shown in the mobile tab bar rather than the More sheet. */
  readonly tab?: boolean;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

const ready = (): NavStatus => ({ kind: 'ready' });
// No route is disabled today (07-Oct-2026: Concepts and the three Library screens went ready).
// A route that needs to be disabled again gets `{ kind: 'disabled', reason, phase }` inline —
// the rail and the command palette still render that state with its reason.

/**
 * Groups and order follow the canvas Rail (docs/design/kiln-redesign/Rail.dc.html): the
 * channel's control room first, then Library, then System. The canvas has no Pipeline group;
 * the screens in it (Trends, Concepts, the script board, Studio, Review, Analytics, Publish)
 * are not superseded by Prompt L's handover, so they keep a place below Library rather than
 * disappearing. The script board is labelled "Script board" here because the canvas's
 * "Board" is the episode board at /bureau/board, and two items called Board is a coin flip.
 */
export const NAV: readonly NavGroup[] = [
  {
    label: 'Bureau',
    items: [
      { href: '/home', label: 'Home', hint: 'Next slot, what needs you, spend, stages', status: ready(), icon: 'home', tab: true },
      { href: '/bureau/approvals', label: 'Approvals', hint: 'Pending briefs: pick a punchline, approve or reject', status: ready(), icon: 'approvals', badge: 'approvals', tab: true },
      { href: '/bureau/cuts', label: 'Cuts', hint: 'Finished cuts: 9:16 player, shot strip, re-roll, approve', status: ready(), icon: 'cuts', badge: 'cuts', tab: true },
      { href: '/bureau/ready', label: 'Ready', hint: 'Publish bundles for YouTube and Instagram', status: ready(), icon: 'ready', badge: 'ready' },
      { href: '/bureau/board', label: 'Board', hint: 'Every episode by stage, blockers first', status: ready(), icon: 'board', badge: 'blocked', tab: true },
      { href: '/bureau/calendar', label: 'Calendar', hint: 'Slots, seasonal tags, bank, produce-by', status: ready(), icon: 'calendar' },
      { href: '/bureau/monitor', label: 'Generation', hint: 'Queues, failures, spend vs caps, kill switch', status: ready(), icon: 'generation', badge: 'genFailed' },
      { href: '/bureau/metrics', label: 'Metrics', hint: 'KPIs against the gates, mentions, top performers', status: ready(), icon: 'metrics' },
      { href: '/costs', label: 'Costs', hint: 'Cost per video, with the denominator', status: ready(), icon: 'costs' },
      { href: '/bureau/authorship', label: 'Authorship', hint: 'Every decision, verbatim', status: ready(), icon: 'authorship' },
    ],
  },
  {
    label: 'Library',
    items: [
      { href: '/library/characters', label: 'Characters', hint: 'Each character’s locked sheet: generate, look, lock', status: ready(), icon: 'characters' },
      { href: '/library/voices', label: 'Voices', hint: 'Each character’s voice, override, last take', status: ready(), icon: 'voices' },
      { href: '/library/prompts', label: 'Prompts', hint: 'Shot recipes, params, rate, provenance', status: ready(), icon: 'prompts' },
      { href: '/library/music', label: 'Music', hint: 'Beds per series: upload, preview, default', status: ready(), icon: 'music' },
    ],
  },
  {
    label: 'Pipeline',
    items: [
      { href: '/trends', label: 'Trends', hint: 'Stage 1 intake — what was captured, from where, how recently', status: ready(), icon: 'trends' },
      { href: '/concepts', label: 'Concepts', hint: 'Concepts per channel: script, shots, spend, episode', status: ready(), icon: 'concepts' },
      { href: '/board', label: 'Script board', hint: 'Every script by stage, with the first blocker', status: ready(), icon: 'board' },
      { href: '/studio', label: 'Studio', hint: 'Conversational lane — brief in, shots out', status: ready(), icon: 'studio' },
      { href: '/review', label: 'Review', hint: 'Player, shot strip, per-shot regenerate', status: ready(), icon: 'review' },
      // Ready, and empty until something publishes — the page says which, in words.
      { href: '/analytics', label: 'Analytics', hint: 'Hook retention, cost per 1k views', status: ready(), icon: 'analytics' },
      // The YouTube half works; Meta is blocked on app review and the page says so.
      { href: '/publish', label: 'Publish', hint: 'Queue, schedule, quota budget', status: ready(), icon: 'publish' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/channels', label: 'Channels', hint: 'Each channel’s YouTube and Instagram target', status: ready(), icon: 'channels' },
      { href: '/settings', label: 'Settings', hint: 'Integrations, rate card, guardrails, voice', status: ready(), icon: 'settings' },
      { href: '/setup', label: 'Setup', hint: 'Studio and channel setup — every step verified by a real call', status: ready(), icon: 'setup' },
    ],
  },
];

export const ALL_NAV_ITEMS: readonly NavItem[] = NAV.flatMap((g) => g.items);
