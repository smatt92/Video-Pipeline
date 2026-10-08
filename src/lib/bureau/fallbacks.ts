/**
 * Fallbacks: every time Kiln makes something cheaper or lower than what was picked.
 *
 * Sahil, 08-Oct: "no notifications received for fallback, no approvals for fallback". Each
 * fallback was recorded somewhere (qc.plan.swaps, the stills result, the voice detail) and
 * said nowhere. Two rules now:
 *
 *   1. A **format** fallback is asked, never taken. A 3D explainer or Cartoon characters that
 *      cannot be made stops the episode before anything is paid for, and waits for "Run as
 *      illustrated" on Notifications or Approvals. The status detail carries a prefix so both
 *      screens find the waiting episodes from the row, not from a second flag that can drift.
 *   2. A **shot-level** fallback (clips swapped to stills by the cap, a picture that became a
 *      diagram, a voice on the second model) is told: one 'fallback' notification per step,
 *      naming what changed and why. Those are budget and vendor outcomes inside a run already
 *      approved; stopping the run for each would cost more than it protects.
 */

export const FORMAT_FALLBACK_PREFIX = 'awaiting fallback decision: ';

export function awaitingFallback(status: string, detail: string | null): boolean {
  return status === 'halted' && !!detail && detail.startsWith(FORMAT_FALLBACK_PREFIX);
}

export function fallbackReason(detail: string | null): string {
  return (detail ?? '').slice(FORMAT_FALLBACK_PREFIX.length);
}

const ROUTE_WORDS: Record<string, string> = {
  picture_clip: 'animated clip',
  character_beat: 'character clip',
  acted_beat: 'acted clip',
  money_shot: 'money shot',
  still: 'still picture',
  overlay: 'chalk diagram',
};
const word = (r: string | undefined) => (r ? (ROUTE_WORDS[r] ?? r) : 'something else');

/**
 * One sentence for a plan's swaps, grouped by from → to, with the first reason of each group.
 * Null when nothing was swapped, so the caller sends nothing.
 */
export function describeSwaps(swaps: readonly { idx: number; from: string; to?: string; reason: string }[]): string | null {
  if (!swaps.length) return null;
  const groups = new Map<string, { n: number; reason: string; from: string; to?: string }>();
  for (const s of swaps) {
    const k = `${s.from}→${s.to ?? ''}`;
    const g = groups.get(k);
    if (g) g.n++;
    else groups.set(k, { n: 1, reason: s.reason, from: s.from, to: s.to });
  }
  return [...groups.values()]
    .map((g) => `${g.n} ${word(g.from)}${g.n === 1 ? '' : 's'} → ${word(g.to)} (${g.reason.slice(0, 140)})`)
    .join('; ');
}
