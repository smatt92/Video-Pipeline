import type { Db } from '../db/server';
import { estimateEpisode, fitToCap, type EpisodeEstimate, type FitResult, type PlannedShot } from './estimate';

/**
 * Estimate → fit to the channel's cap → re-estimate: the one function the planner
 * (`planShots`) and the Approvals price of the 3D explainer's motion levels both call, so the
 * figure beside "Key moments" / "Full motion" is the plan the run will make, cap swaps
 * included. Two copies of these three calls would be two places to disagree about the price.
 */
export async function fittedPlan(
  db: Db,
  input: { channelId: string; kind: 'short' | 'long_form'; shots: PlannedShot[]; voChars: number; usdInrRate: number; objectSheets?: number },
): Promise<{ est: EpisodeEstimate; fit: FitResult; finalEst: EpisodeEstimate; capInr: number }> {
  const base = { voChars: input.voChars, usdInrRate: input.usdInrRate, channelId: input.channelId, objectSheets: input.objectSheets ?? 0 };
  const est = await estimateEpisode(db, { ...base, shots: input.shots });
  const { data: pol } = await db.from('channel_policy').select('per_short_cap_inr, daily_longform_cap_inr, overlay_min_share, character_beat_max_s, money_shot_max').eq('channel_id', input.channelId).single();
  if (!pol) throw new Error('the channel has no policy row');
  const capInr = Number(input.kind === 'long_form' ? pol.daily_longform_cap_inr : pol.per_short_cap_inr);
  const fit = fitToCap(input.shots, est, {
    capInr,
    overlayMinShare: Number(pol.overlay_min_share),
    characterBeatMaxS: Number(pol.character_beat_max_s),
    moneyShotMax: pol.money_shot_max,
  });
  const finalEst = await estimateEpisode(db, { ...base, shots: fit.shots });
  return { est, fit, finalEst, capInr };
}
