/**
 * Statuses during which the worker is doing something and the episode row changes on its own.
 * `cut_approved` is one: the run wakes from the cut gate, renders the clean master and caption
 * layer (as `assembling`) and bundles — ~10 minutes in which the row moves without anyone
 * touching it, and the screens must follow it (screen-state.ts says why).
 */
export const RUNNING = ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'assembling', 'qc', 'cut_approved'] as const;
export const isRunning = (s: string) => (RUNNING as readonly string[]).includes(s);

/**
 * A run that stopped without saying so. Scripting, voicing and assembling write the episode row
 * as they go (assembly every ~5 s while rendering), so 30 minutes of silence in one of them means
 * the worker is gone — a crash or the task's CPU ceiling, which ends a run without its catch
 * block; an approved cut the run never woke from (no wait token) reads the same way (S001, 07-Oct: "assembling" for an hour after the run was dead). Generating is excluded:
 * it legitimately waits on vendors for hours without touching the row.
 */
export const SILENT_STALL_MS = 30 * 60_000;
export const stalled = (status: string, updatedAt: string, now = Date.now()) =>
  ['scripting', 'voicing', 'assembling', 'cut_approved'].includes(status) && now - new Date(updatedAt).getTime() > SILENT_STALL_MS;
