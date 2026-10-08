import { episodeStatus } from '../db/enums';
import { isRunning } from './running';

/**
 * Where an episode shows on the status-bearing screens, and when a screen must keep itself
 * current. Pure, so `test:bureau` can hold the rules (the screens import them; nothing here
 * reads a row).
 *
 * Why this exists (08-Oct, "a video is shown in Ready when it is supposed to be in
 * generation"): after a cut is approved the episode sits in `cut_approved` until the worker
 * wakes, then `assembling` for ~8–12 minutes while the clean master and caption layer render,
 * then `bundled`. The Board put `cut_approved` in its Ready column, with an "Open bundle"
 * button for a bundle that did not exist yet — and `cut_approved` was not a running status,
 * so the Board stopped refreshing itself at exactly that moment. The screen then held the
 * episode in Ready for the whole render. A finishing episode is in production; Ready means a
 * bundle exists.
 */

export type BoardColumnKey = 'approval' | 'render' | 'qc' | 'cut' | 'ready' | 'scheduled' | 'live' | 'stopped';

export const BOARD_COLUMNS: readonly { key: BoardColumnKey; label: string; dot: string; statuses: readonly string[]; empty: string }[] = [
  { key: 'approval', label: 'Needs approval', dot: 'var(--draft)', statuses: [], empty: 'Briefs waiting for your punchline pick land here.' },
  { key: 'render', label: 'Rendering', dot: 'var(--gen)', statuses: ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'assembling', 'cut_approved'], empty: 'Nothing is rendering.' },
  { key: 'qc', label: 'QC', dot: 'var(--gen)', statuses: ['qc'], empty: 'Loudness, captions and policy checks run here.' },
  { key: 'cut', label: 'Needs cut review', dot: 'var(--rev)', statuses: ['awaiting_cut', 'cut_rejected'], empty: 'You watch every cut before it can be scheduled.' },
  { key: 'ready', label: 'Ready', dot: 'var(--rdy)', statuses: ['bundled'], empty: 'Approved cuts with a publish bundle.' },
  { key: 'scheduled', label: 'Scheduled', dot: 'var(--rdy)', statuses: ['scheduled'], empty: 'Marked scheduled with the platform link.' },
  { key: 'live', label: 'Live', dot: 'var(--live)', statuses: ['live'], empty: 'Nothing is live yet.' },
  { key: 'stopped', label: 'Stopped', dot: 'var(--t4)', statuses: ['halted', 'failed'], empty: 'Halted or failed runs.' },
];

/** The Rendering column's sub-groups, in pipeline order. Approved cuts render their deliverables last. */
export const RENDER_SUB: readonly { label: string; statuses: readonly string[] }[] = [
  { label: 'Queued', statuses: ['queued'] },
  { label: 'Scripting', statuses: ['scripting', 'shotlisting', 'estimating'] },
  { label: 'Voicing', statuses: ['voicing'] },
  { label: 'Generating', statuses: ['generating'] },
  { label: 'Assembling', statuses: ['assembling'] },
  { label: 'Finishing after approval', statuses: ['cut_approved'] },
];

/** The Board column an episode status belongs in, or null for a status no column shows. */
export function boardColumnFor(status: string): BoardColumnKey | null {
  return BOARD_COLUMNS.find((c) => c.statuses.includes(status))?.key ?? null;
}

/**
 * Episode statuses whose publish bundle the Ready screen may show. An episode back in
 * production (a restart, a re-cut) is not ready, whatever bundle row it left behind — the
 * bundle describes a cut that is being replaced.
 */
export const READY_EPISODE_STATUSES = ['bundled', 'scheduled', 'live'] as const;
/** Every other status the schema allows (0037's CHECK, via enums.ts): the ones Ready filters out. */
export const NOT_READY_EPISODE_STATUSES: readonly string[] = episodeStatus.options.filter((s) => !(READY_EPISODE_STATUSES as readonly string[]).includes(s));
export const showsOnReady = (episodeStatus: string | null) => episodeStatus === null || (READY_EPISODE_STATUSES as readonly string[]).includes(episodeStatus);

/**
 * Whether a status-bearing screen should re-read itself on a timer: while anything on it is
 * changing on its own (the worker writes the row). Nothing running → no timer; a refresh on
 * focus still catches a change made elsewhere.
 */
export const shouldAutoRefresh = (statuses: readonly string[]) => statuses.some((s) => isRunning(s));
