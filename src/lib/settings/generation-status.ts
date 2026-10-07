import { stillsAvailability } from '../bureau/stills';
import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import { STILL_INTEGRATION, STILL_RATE_KEY } from '../drivers/still-image';
import { failoverEnabled } from '../drivers/jobs';
import { usability } from '../integrations/verify';

/**
 * Read-only status for Settings → Generation: what is switched on and what it costs, from the
 * rows. Nothing here writes; recipes are changed on Library → Prompts, the integration on
 * Integrations, the failover flag in the environment.
 */

export interface GenerationStatus {
  recipes: { name: string; driver: string; model: string; version: number; acceptsCharacterRef: boolean; createdAt: string }[];
  /** null when GENERATION_FAILOVER holds a value the code refuses — said, not guessed. */
  failover: boolean | null;
  failoverProblem: string | null;
  stillIntegration: { slug: string; usable: boolean; reason: string };
  /** Per image, USD; null when there is no verified rate (absent ≠ zero). */
  stillRate: { usd: number; verified: boolean; effectiveFrom: string } | null;
  stillRateDetail: string | null;
  stills: { available: boolean; reason: string | null };
}

export async function generationStatus(db: Db, channelId: string): Promise<GenerationStatus> {
  const { data: recipes, error } = await db
    .from('prompts')
    .select('name, driver, model, version, accepts_character_ref, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Reading prompts: ${error.message}`);

  let failover: boolean | null = null;
  let failoverProblem: string | null = null;
  try {
    failover = failoverEnabled();
  } catch (err) {
    failoverProblem = err instanceof Error ? err.message : String(err);
  }

  const use = await usability(db, STILL_INTEGRATION);
  // `currentRate` refuses an unverified rate; this screen shows what is in force either way,
  // so it reads the row too when the lookup refuses.
  const rate = await currentRate(db, { ...STILL_RATE_KEY });
  const stills = await stillsAvailability(db, channelId);

  return {
    recipes: (recipes ?? []).map((r) => ({ name: r.name, driver: r.driver, model: r.model, version: r.version, acceptsCharacterRef: r.accepts_character_ref, createdAt: r.created_at })),
    failover,
    failoverProblem,
    stillIntegration: { slug: STILL_INTEGRATION, usable: use.usable, reason: use.reason },
    stillRate: rate.found ? { usd: rate.rate.unitCostUsd, verified: rate.rate.isVerified, effectiveFrom: rate.rate.effectiveFrom } : null,
    stillRateDetail: rate.found ? null : rate.detail,
    stills: stills.available ? { available: true, reason: null } : { available: false, reason: stills.reason },
  };
}
