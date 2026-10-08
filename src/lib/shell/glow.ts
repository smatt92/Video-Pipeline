/**
 * Kiln Glass: glow is information (Sahil, 08-Oct). The app shell carries `data-glow`, and the
 * ambient orbs read it — grey when idle, breathing when something generates, one red pulse
 * when something needs you. Derived from row counts the rail already reads (rail.ts).
 */

export type Glow = 'idle' | 'generating' | 'alert';

/**
 * `alert` — an unread fallback or qc_failed alert, or a halted episode; `generating` — any
 * episode in a running status; otherwise `idle`. Alert wins: it is the one that needs you.
 *
 * Pure, so the shell and a test call the same rule. A count that could not be read is null
 * and contributes nothing — an unreadable table never lights the room.
 */
export function glowFrom(c: { running: number | null; halted: number | null; unreadAlarms: number | null }): Glow {
  if ((c.unreadAlarms ?? 0) > 0 || (c.halted ?? 0) > 0) return 'alert';
  if ((c.running ?? 0) > 0) return 'generating';
  return 'idle';
}
