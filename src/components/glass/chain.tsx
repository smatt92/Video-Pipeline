import { Icon, type IconName } from '@/components/ui/icon';

/**
 * The pipeline chain (Kiln Glass): Brief → Voice → Pictures → Clips → Cut → Bundle, one node
 * per stage with its state and what it cost. The stage order is the order an episode moves
 * through, not the stage numbers (voice runs before pictures — CLAUDE.md).
 *
 * `cost` is a pre-formatted figure or null; null renders an em dash — the stage has no ledger
 * row attributed to this episode — never "₹0".
 */

export const CHAIN_STAGES = ['brief', 'voice', 'pictures', 'clips', 'cut', 'bundle'] as const;
export type ChainStage = (typeof CHAIN_STAGES)[number];
export type NodeState = 'idle' | 'ok' | 'run' | 'rev' | 'blk';

const LABEL: Record<ChainStage, string> = { brief: 'Brief', voice: 'Voice', pictures: 'Pictures', clips: 'Clips', cut: 'Cut', bundle: 'Bundle' };
const ICON: Record<ChainStage, IconName> = { brief: 'brief', voice: 'voices', pictures: 'picture', clips: 'clip', cut: 'cuts', bundle: 'bundle' };
const WORD: Record<NodeState, string> = { idle: 'not started', ok: 'done', run: 'running', rev: 'waiting for you', blk: 'blocked' };

export interface ChainNodeData {
  stage: ChainStage;
  state: NodeState;
  /** e.g. "₹96"; null = nothing attributed → em dash. */
  cost: string | null;
  /** Overrides the cost line, e.g. "fallback". */
  note?: string | null;
  /** Overrides the label, e.g. "Pictures 4/12". */
  label?: string;
}

function nodeIcon(n: ChainNodeData): IconName {
  if (n.state === 'ok') return 'check';
  if (n.state === 'blk') return 'alert';
  if (n.state === 'rev') return 'eye';
  return ICON[n.stage];
}

export function Chain({ nodes }: { nodes: readonly ChainNodeData[] }) {
  const summary = nodes.map((n) => `${LABEL[n.stage]} ${WORD[n.state]}${n.cost ? ` ${n.cost}` : ''}`).join(', ');
  return (
    <div className="chain" role="img" aria-label={`Pipeline: ${summary}`}>
      {nodes.map((n) => (
        <div key={n.stage} className={`nd${n.state === 'idle' ? '' : ` ${n.state}`}`}>
          <span className="dot">
            <Icon name={nodeIcon(n)} />
          </span>
          <span className="nl">{n.label ?? LABEL[n.stage]}</span>
          <span className="nc">{n.note ?? n.cost ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}
