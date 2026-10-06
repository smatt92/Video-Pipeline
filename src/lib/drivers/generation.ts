import { clipSeconds } from './video-runway';

export { providersForRoute, REFERENCE_FRAME_PARAM, type RenderRoute } from './jobs';

/**
 * The vendor-neutral face of generation, for core code (rule 1).
 *
 * `src/lib/bureau/` must not name a vendor, and the module that knows Gen-4 Turbo bills in
 * whole seconds from 2 to 10 while Veo bills 4, 6 or 8 has the vendor in its file name. So
 * core asks this module "how many seconds will this provider bill for a shot this long?"
 * and never learns which provider it asked about.
 */

/**
 * The seconds a single generation call is billed for. **The** shared number: the estimator
 * prices it, `fitToCap` swaps against it, `enqueueGeneration` submits it as the clip length
 * and the dispatcher ledgers it. If two of those used different arithmetic, the cap would be
 * checked against a figure the vendor never charges.
 *
 * Providers without a duration table fall back to the previous rule: whole seconds, capped
 * by the recipe's `max_duration_s` when it has one.
 */
export function billedSeconds(provider: string, model: string, shotSeconds: number, maxDurationS?: number): number {
  if (provider === 'runway') {
    const s = clipSeconds(model, shotSeconds);
    if (s !== null) return s;
  }
  const whole = Math.ceil(shotSeconds);
  return maxDurationS && Number.isFinite(maxDurationS) && maxDurationS > 0 ? Math.min(whole, maxDurationS) : whole;
}
