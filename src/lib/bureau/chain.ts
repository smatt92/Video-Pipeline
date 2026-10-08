/**
 * The pipeline chain on Home (Kiln Glass): Brief → Voice → Pictures → Clips → Cut → Bundle,
 * each node's state from the episode's status and each node's cost from the ledger.
 *
 * Pure, so `test:bureau` drives exactly what the screen draws. The order is the order an
 * episode moves through, not the stage numbers: voice (stage 6) runs before pictures and
 * clips (stage 5) because word timings set shot lengths (CLAUDE.md, Addendum 02 §1).
 */

export const CHAIN_NODES = ['brief', 'voice', 'pictures', 'clips', 'cut', 'bundle'] as const;
export type ChainNode = (typeof CHAIN_NODES)[number];
export type ChainState = 'idle' | 'ok' | 'run' | 'rev' | 'blk';

/**
 * Ledger stage → chain node. Anything not named here is not drawn on a node (it still counts
 * in the episode's total, which comes from v_episode_spend, not from summing nodes).
 */
export function nodeForStage(stage: string | null): ChainNode | null {
  if (!stage) return null;
  if (['02-concept', '03-script', '04-shotlist', '20-brief', '20-policy-judge', '20-script-polish', '20-embed'].includes(stage)) return 'brief';
  if (stage === '06-voice' || stage.startsWith('06-')) return 'voice';
  if (stage === '05-still' || stage === '20-still-prompt') return 'pictures';
  if (stage === '05-generate') return 'clips';
  if (['07-assemble', '08-review', '20-qc'].includes(stage)) return 'cut';
  if (['09-metadata', '10-publish', '24-dub-captions'].includes(stage) || stage.startsWith('dub:')) return 'bundle';
  return null;
}

/** Sums ledger rows into nodes. A node with no rows is absent from the map — never 0. */
export function costsByNode(rows: readonly { stage: string | null; inr: number | null }[]): Map<ChainNode, number | null> {
  const out = new Map<ChainNode, number | null>();
  for (const r of rows) {
    const n = nodeForStage(r.stage);
    if (!n) continue;
    const prev = out.has(n) ? out.get(n)! : 0;
    // One unpriced row makes the node's sum unknown, as everywhere else in the ledger.
    out.set(n, prev === null || r.inr === null ? null : prev + r.inr);
  }
  return out;
}

export interface ChainProgress {
  /** Pictures drawn / planned, when the episode has any picture shots. */
  stills?: { done: number; planned: number } | null;
  /** Clips made / planned, when it has any video shots. */
  clips?: { done: number; planned: number } | null;
  /** The episode is halted waiting on a format-fallback decision. */
  fallback?: boolean;
}

export interface ChainNodeView {
  stage: ChainNode;
  state: ChainState;
  label?: string;
  note?: string | null;
}

const RUNNING_AT: Record<string, ChainNode> = {
  queued: 'brief',
  scripting: 'brief',
  shotlisting: 'brief',
  estimating: 'brief',
  voicing: 'voice',
  qc: 'cut',
  assembling: 'cut',
  cut_approved: 'bundle',
};

/**
 * Node states for an episode status. Everything before the current node is done; the current
 * node runs, waits for you (a cut), or is blocked; everything after it has not started.
 * `generating` is pictures until every planned picture exists, then clips. A stopped episode
 * blocks at the fallback's node (pictures) when that is why it stopped, otherwise at the
 * first node with no ledger row — the furthest the money says it got.
 */
export function chainStates(status: string, p: ChainProgress = {}, spentNodes: ReadonlySet<ChainNode> = new Set()): ChainNodeView[] {
  const idx = (n: ChainNode) => CHAIN_NODES.indexOf(n);
  let at: number;
  let state: ChainState;
  if (['bundled', 'scheduled', 'live'].includes(status)) {
    return CHAIN_NODES.map((stage) => ({ stage, state: 'ok' as const, ...progressLabel(stage, p) }));
  }
  if (status === 'awaiting_cut') {
    at = idx('cut');
    state = 'rev';
  } else if (status === 'cut_rejected') {
    at = idx('cut');
    state = 'blk';
  } else if (status === 'halted' || status === 'failed') {
    if (p.fallback) at = idx('pictures');
    else {
      const first = CHAIN_NODES.findIndex((n, i) => i > 0 && !spentNodes.has(n));
      at = first < 0 ? idx('bundle') : first;
    }
    state = 'blk';
  } else if (status === 'generating') {
    const stillsLeft = p.stills && p.stills.done < p.stills.planned;
    at = stillsLeft || !p.clips || p.clips.planned === 0 ? idx('pictures') : idx('clips');
    state = 'run';
  } else {
    at = idx(RUNNING_AT[status] ?? 'brief');
    state = 'run';
  }
  return CHAIN_NODES.map((stage, i) => {
    const base = { stage, ...progressLabel(stage, p) };
    if (i < at) return { ...base, state: 'ok' as const };
    if (i === at) return { ...base, state, ...(state === 'blk' && p.fallback && stage === 'pictures' ? { note: 'fallback' } : {}) };
    return { ...base, state: 'idle' as const };
  });
}

function progressLabel(stage: ChainNode, p: ChainProgress): { label?: string } {
  if (stage === 'pictures' && p.stills && p.stills.planned > 0) return { label: `Pictures ${p.stills.done}/${p.stills.planned}` };
  if (stage === 'clips' && p.clips && p.clips.planned > 0) return { label: `Clips ${p.clips.done}/${p.clips.planned}` };
  return {};
}

/**
 * Consecutive days from today whose slot is past approval and not stopped — "days banked".
 * Null when nothing could be read; 0 when today's slot is not yet covered.
 */
export function daysBanked(slots: readonly { date: string; status: string | null }[] | null, today: string): number | null {
  if (slots === null) return null;
  const covered = new Set(
    slots
      .filter((s) => s.status !== null && !['open', 'needs_approval', 'halted', 'failed', 'cut_rejected'].includes(s.status))
      .map((s) => s.date),
  );
  let n = 0;
  const d = new Date(`${today}T00:00:00Z`);
  while (covered.has(d.toISOString().slice(0, 10))) {
    n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

/** How far along a slot is, 0–5, for the days-banked dot matrix. */
export function slotLevel(status: string | null): number {
  if (status === null || status === 'open') return 0;
  if (status === 'needs_approval') return 1;
  if (['halted', 'failed', 'cut_rejected'].includes(status)) return 1;
  if (status === 'approved' || status === 'queued') return 2;
  if (status === 'awaiting_cut' || status === 'cut_approved') return 4;
  if (['bundled', 'scheduled', 'live'].includes(status)) return 5;
  return 3;
}
