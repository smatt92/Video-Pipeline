import { z } from 'zod';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import { billedSeconds, providersForRoute, type RenderRoute } from '../drivers/generation';
import { TTS_RATE_KEY } from '../drivers/voice-route';

/**
 * What an episode will cost before it is made, and how to make it fit the cap.
 *
 * Every figure is rate-card × quantity — an estimate, labelled as one. A shot whose route
 * has no active recipe, or whose recipe's rate is missing or unverified, is **unpriced**:
 * its cost is null, never 0, and the episode total is null while any priced-by-us shot is
 * unpriced. `fitToCap` is what turns that into an action: an unpriced generated shot cannot
 * be proven to sit under the cap, so it is planned as an overlay, with the reason recorded.
 *
 * ── Two figures per shot, on purpose ─────────────────────────────────────────
 *
 * `inr` is ONE call: the billed clip length (`billedSeconds`, shared with the submitter) ×
 * the rate. It is what `enqueueGeneration` writes to `gen_jobs.estimate_inr` and what the
 * dispatcher ledgers at submit — a ledger row is one call, never a forecast.
 *
 * `planned_inr` is that × `REROLL_ALLOWANCE`: the plan expects half the generated shots to
 * be re-rolled once by QC (0015 arithmetic: an 8 s Gen-4 Turbo beat is 40 credits a call,
 * 60 planned). The episode total and `fitToCap` use `planned_inr`, so the cap is checked
 * against what a Short is expected to cost, not what it costs when everything works first
 * time. The per-call figure and the planned figure are never mixed in one sum.
 */

export const SHOT_ROUTES = ['overlay', 'character_beat', 'acted_beat', 'money_shot'] as const;

export const PlannedShotSchema = z.object({
  beat_id: z.string().min(1).optional(),
  route: z.enum(SHOT_ROUTES),
  description: z.string().min(3),
  duration_s: z.number().positive().max(30),
  characters: z.array(z.string()).default([]),
  /** Three.js overlay spec from the series template, for overlay shots. */
  overlay: z.record(z.string(), z.unknown()).optional(),
  /** Photoreal money shot → containsSyntheticMedia on the bundle. */
  realistic: z.boolean().default(false),
  style: z.string().optional(),
});
export type PlannedShot = z.infer<typeof PlannedShotSchema>;

/**
 * Expected calls per generated shot. QC re-rolls a failing clip up to
 * `channel_policy.rerolls_max` times; planning for one re-roll on half of them is the plan
 * v2.3 figure. A constant rather than a policy column because nothing measures it yet —
 * when `gen_jobs.reroll_index` has a month of rows, replace this with the observed mean.
 */
export const REROLL_ALLOWANCE = 1.5;

export interface Recipe {
  id: string;
  driver: string;
  model: string;
  template: string;
  params: Record<string, unknown>;
  acceptsCharacterRef: boolean;
}

/** The active recipe for a route: primary provider first, then the failover. */
export async function recipeForRoute(
  db: Db,
  route: Exclude<RenderRoute, 'overlay'>,
  opts: { failover?: boolean } = {},
): Promise<Recipe | null> {
  // The one routing predicate (drivers/jobs.ts). Estimator and submitter both arrive here.
  const providers = providersForRoute(route, opts);
  const { data } = await db
    .from('prompts')
    .select('id, driver, model, template, params, accepts_character_ref, created_at')
    .eq('is_active', true)
    .in('driver', providers)
    .order('created_at', { ascending: false });
  const rows = data ?? [];
  for (const p of providers) {
    const r = rows.find((x) => x.driver === p && (route !== 'character_beat' || x.accepts_character_ref));
    if (r) {
      return {
        id: r.id,
        driver: r.driver,
        model: r.model,
        template: r.template,
        params: (r.params ?? {}) as Record<string, unknown>,
        acceptsCharacterRef: r.accepts_character_ref,
      };
    }
  }
  return null;
}

export interface LineEstimate {
  idx: number;
  route: PlannedShot['route'];
  duration_s: number;
  /** Seconds one call is billed for; null for an overlay or an unpriced shot. */
  billed_s: number | null;
  /** One call. What gets ledgered. */
  inr: number | null;
  /** One call × REROLL_ALLOWANCE (overlays: 0). What the total and the cap fitter use. */
  planned_inr: number | null;
  basis: string;
}

export interface EpisodeEstimate {
  /** null while any generated shot or the voice is unpriced. */
  total_inr: number | null;
  priced_inr: number;
  voice_inr: number | null;
  shots: LineEstimate[];
  unpriced: string[];
  usd_inr_rate: number;
}

async function routeRateInr(db: Db, route: Exclude<RenderRoute, 'overlay'>, durationS: number, fx: number) {
  const recipe = await recipeForRoute(db, route);
  if (!recipe) return { inr: null, billed: null, basis: `no active recipe for ${route}` };
  const billed = billedSeconds(recipe.driver, recipe.model, durationS, Number(recipe.params.max_duration_s) || undefined);
  const perSecond = await currentRate(db, { driver: recipe.driver, model: recipe.model, endpoint: null, unit: 'second' });
  if (perSecond.found) {
    return { inr: billed * perSecond.rate.unitCostUsd * fx, billed, basis: `rate_card ${recipe.model} per second × ${billed}s billed` };
  }
  // Credit-priced recipes carry their own credits-per-second, proven with the sample.
  const cps = Number(recipe.params.credits_per_second);
  const perCredit = await currentRate(db, { driver: recipe.driver, model: recipe.model, endpoint: null, unit: 'credit' });
  if (perCredit.found && Number.isFinite(cps) && cps > 0) {
    return { inr: billed * cps * perCredit.rate.unitCostUsd * fx, billed, basis: `rate_card ${recipe.model} per credit × ${cps}/s × ${billed}s billed` };
  }
  return { inr: null, billed: null, basis: `${recipe.model}: ${perSecond.found ? '' : perSecond.detail}` };
}

export async function estimateEpisode(
  db: Db,
  input: { shots: PlannedShot[]; voChars: number; usdInrRate: number },
): Promise<EpisodeEstimate> {
  const fx = input.usdInrRate;
  const lines: LineEstimate[] = [];
  const unpriced: string[] = [];

  for (const [idx, s] of input.shots.entries()) {
    if (s.route === 'overlay') {
      lines.push({ idx, route: s.route, duration_s: s.duration_s, billed_s: null, inr: 0, planned_inr: 0, basis: 'in-house render (worker compute is not ledgered)' });
      continue;
    }
    const r = await routeRateInr(db, s.route, s.duration_s, fx);
    if (r.inr === null) unpriced.push(`shot ${idx} (${s.route}): ${r.basis}`);
    lines.push({
      idx,
      route: s.route,
      duration_s: s.duration_s,
      billed_s: r.billed,
      inr: r.inr === null ? null : round2(r.inr),
      planned_inr: r.inr === null ? null : round2(r.inr * REROLL_ALLOWANCE),
      basis: r.basis,
    });
  }

  const voiceRate = await currentRate(db, { ...TTS_RATE_KEY });
  const voice_inr = voiceRate.found ? input.voChars * voiceRate.rate.unitCostUsd * fx : null;
  if (voice_inr === null) unpriced.push(`voice: ${voiceRate.found ? '' : voiceRate.detail}`);

  const priced_inr = lines.reduce((n, l) => n + (l.planned_inr ?? 0), 0) + (voice_inr ?? 0);
  return {
    total_inr: unpriced.length ? null : round2(priced_inr),
    priced_inr: round2(priced_inr),
    voice_inr: voice_inr === null ? null : round2(voice_inr),
    shots: lines,
    unpriced,
    usd_inr_rate: fx,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface FitPolicy {
  capInr: number;
  overlayMinShare: number;
  characterBeatMaxS: number;
  moneyShotMax: number;
}

export interface FitResult {
  shots: PlannedShot[];
  swaps: { idx: number; from: PlannedShot['route']; reason: string }[];
}

/**
 * Make a shot list obey the channel's shape rules and fit the cap.
 *
 * Order: (1) unpriced generated shots → overlay; (2) money shots beyond the max → overlay;
 * (3) character beats beyond the per-Short seconds → overlay, longest first; (4) while the
 * overlay share of runtime is under the minimum, the longest generated shot → overlay;
 * (5) while the priced total exceeds the cap, the most expensive generated shot → overlay.
 * Overlay is the floor because it is the one route that costs no vendor money.
 */
export function fitToCap(shots: PlannedShot[], est: EpisodeEstimate, p: FitPolicy): FitResult {
  const out = shots.map((s) => ({ ...s }));
  // The planned figure — the same one the episode total is made of (see the header).
  const cost = est.shots.map((l) => l.planned_inr);
  const swaps: FitResult['swaps'] = [];
  const swap = (i: number, reason: string) => {
    if (out[i].route === 'overlay') return;
    swaps.push({ idx: i, from: out[i].route, reason });
    out[i] = { ...out[i], route: 'overlay', realistic: false };
    cost[i] = 0;
  };

  out.forEach((s, i) => {
    if (s.route !== 'overlay' && cost[i] === null) swap(i, `unpriced: ${est.shots[i].basis}`);
  });

  let money = 0;
  out.forEach((s, i) => {
    if (s.route === 'money_shot' && ++money > p.moneyShotMax) swap(i, `more than ${p.moneyShotMax} money shot`);
  });

  const byLength = (route: PlannedShot['route']) =>
    out.map((s, i) => ({ s, i })).filter((x) => x.s.route === route).sort((a, b) => b.s.duration_s - a.s.duration_s);
  let beatS = out.filter((s) => s.route === 'character_beat').reduce((n, s) => n + s.duration_s, 0);
  for (const { s, i } of byLength('character_beat')) {
    if (beatS <= p.characterBeatMaxS) break;
    swap(i, `character beats over ${p.characterBeatMaxS}s`);
    beatS -= s.duration_s;
  }

  const runtime = out.reduce((n, s) => n + s.duration_s, 0);
  const overlayS = () => out.filter((s) => s.route === 'overlay').reduce((n, s) => n + s.duration_s, 0);
  while (runtime > 0 && overlayS() / runtime < p.overlayMinShare) {
    const longest = out.map((s, i) => ({ s, i })).filter((x) => x.s.route !== 'overlay').sort((a, b) => b.s.duration_s - a.s.duration_s)[0];
    if (!longest) break;
    swap(longest.i, `overlay share under ${Math.round(p.overlayMinShare * 100)}%`);
  }

  const total = () => cost.reduce<number>((n, c) => n + (c ?? 0), 0) + (est.voice_inr ?? 0);
  while (total() > p.capInr) {
    const priciest = cost.map((c, i) => ({ c: c ?? 0, i })).filter((x) => out[x.i].route !== 'overlay').sort((a, b) => b.c - a.c)[0];
    if (!priciest || priciest.c === 0) break;
    swap(priciest.i, `over the ₹${p.capInr} per-Short cap`);
  }

  return { shots: out, swaps };
}
