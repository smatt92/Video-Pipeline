/** Statuses during which the worker is doing something and the episode row changes on its own. */
export const RUNNING = ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'assembling', 'qc'] as const;
export const isRunning = (s: string) => (RUNNING as readonly string[]).includes(s);

/**
 * A run that stopped without saying so. Scripting, voicing and assembling write the episode row
 * as they go (assembly every ~5 s while rendering), so 30 minutes of silence in one of them means
 * the worker is gone — a crash or the task's CPU ceiling, which ends a run without its catch
 * block (S001, 07-Oct: "assembling" for an hour after the run was dead). Generating is excluded:
 * it legitimately waits on vendors for hours without touching the row.
 */
export const SILENT_STALL_MS = 30 * 60_000;
export const stalled = (status: string, updatedAt: string, now = Date.now()) =>
  ['scripting', 'voicing', 'assembling'].includes(status) && now - new Date(updatedAt).getTime() > SILENT_STALL_MS;
