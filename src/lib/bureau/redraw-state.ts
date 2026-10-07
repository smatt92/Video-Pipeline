/**
 * The state of "Redraw this picture" on an episode (`episodes.qc.redraws`), and the one refusal
 * built on it. Pure and dependency-free so decideCut (control.ts) can read it without pulling
 * in the assembler; the request and the run are in redraw.ts.
 */

export const REDRAW_STATES = ['queued', 'drawing', 'rendering', 'done', 'failed'] as const;
export type RedrawState = (typeof REDRAW_STATES)[number];
const IN_FLIGHT: readonly RedrawState[] = ['queued', 'drawing', 'rendering'];
/** An in-flight entry older than this is treated as dead (the same figure is in 0050's SQL). */
export const REDRAW_STALE_MS = 2 * 60 * 60_000;

export interface RedrawEntry {
  id: string;
  shot_id: string;
  shot_idx: number;
  parts: number[];
  note: string | null;
  state: RedrawState;
  reason: string | null;
  requested_at: string;
  finished_at: string | null;
  run_id: string | null;
  token_id: string | null;
  /** Per part: the new generation, or why not. */
  results?: { part: number; ok: boolean; generation_id?: string; reason?: string; cost_inr?: number }[];
  render_id?: string | null;
}

export function redrawsOf(qc: unknown): RedrawEntry[] {
  const r = qc && typeof qc === 'object' ? (qc as { redraws?: unknown }).redraws : undefined;
  return Array.isArray(r) ? (r.filter((x) => x && typeof x === 'object' && typeof (x as RedrawEntry).id === 'string') as RedrawEntry[]) : [];
}

export function redrawInFlight(qc: unknown, now = Date.now()): RedrawEntry | null {
  return redrawsOf(qc).find((r) => IN_FLIGHT.includes(r.state) && now - new Date(r.requested_at).getTime() < REDRAW_STALE_MS) ?? null;
}

/** The sentence decideCut refuses with, or null. Shared so the screen and the refusal agree. */
export function redrawRefusal(qc: unknown, now = Date.now()): string | null {
  const r = redrawInFlight(qc, now);
  if (!r) return null;
  const which = r.parts.length === 1 ? `picture ${r.parts[0] + 1}` : `${r.parts.length} pictures`;
  return `Shot ${r.shot_idx} (${which}) is being redrawn — the cut is about to change. Approve or send it back once the new composite is in (Cuts shows it).`;
}
