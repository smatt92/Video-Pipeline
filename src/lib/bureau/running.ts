/** Statuses during which the worker is doing something and the episode row changes on its own. */
export const RUNNING = ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'assembling', 'qc'] as const;
export const isRunning = (s: string) => (RUNNING as readonly string[]).includes(s);
