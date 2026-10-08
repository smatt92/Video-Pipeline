import 'server-only';

import { costsByNode, CHAIN_NODES, type ChainNode } from '../bureau/chain';
import { episodeClips } from '../bureau/overlay-only';
import type { Db } from '../db/server';
import { readVideoCosts } from '../cost/video';
import { fallbacksWaiting, type FallbackWaiting } from '../notifications/centre';
import type { EpisodeRow, SpendRow } from './common';

/**
 * Home's reads beyond the ones every screen shares (common.ts): the ledger by day for the
 * dot-matrix sparklines, each in-production episode's cost per chain node, the slots ahead
 * for "days banked", cost per video for the month, and what needs you.
 *
 * Every figure is a row or null. Null renders an em dash: a channel whose ledger has no rows
 * has not spent ₹0 a day, it has no spend to show, and a month with no finished video has no
 * cost per video — it is undefined, not free (CLAUDE.md, "absent and zero").
 */

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Spend per local day, from the effective ledger (superseded estimates excluded). */
export async function spendByDay(db: Db, channelId: string, tz: string, days: number): Promise<Map<string, number> | null> {
  const since = new Date(Date.now() - (days + 1) * 86_400_000).toISOString();
  const { data, error } = await db.from('v_ledger_effective').select('occurred_at, cost_inr').eq('eff_channel_id', channelId).gte('occurred_at', since).limit(5000);
  if (error) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const out = new Map<string, number>();
  for (const r of data ?? []) {
    if (r.occurred_at === null || r.cost_inr === null) continue;
    const d = fmt.format(new Date(r.occurred_at));
    out.set(d, (out.get(d) ?? 0) + Number(r.cost_inr));
  }
  return out;
}

/** Local dates (YYYY-MM-DD) ending today, oldest first. */
export function lastDays(today: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (count - 1));
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export interface ChainEpisode {
  episode: EpisodeRow;
  /** v_episode_spend; null when the episode has no script (nothing can attach) or the read failed. */
  spentInr: number | null;
  nodeCost: Map<ChainNode, number | null>;
  stills: { done: number; planned: number } | null;
  clips: { done: number; planned: number } | null;
}

/** Cost per chain node and progress, for the episodes Home shows in production. */
export async function chainEpisodes(db: Db, episodes: readonly EpisodeRow[]): Promise<ChainEpisode[]> {
  if (!episodes.length) return [];
  const scriptIds = episodes.map((e) => e.scriptId).filter((x): x is string => !!x);
  const [spendRes, effRes, clips] = await Promise.all([
    db.from('v_episode_spend').select('episode_id, spent_inr').in('episode_id', episodes.map((e) => e.id)),
    scriptIds.length ? db.from('v_ledger_effective').select('id, eff_script_id, cost_inr').in('eff_script_id', scriptIds).limit(5000) : Promise.resolve({ data: [], error: null }),
    Promise.all(episodes.map((e) => episodeClips(db, { script_id: e.scriptId, qc: e.qc }).catch(() => null))),
  ]);
  const eff = (effRes.data ?? []) as { id: string; eff_script_id: string | null; cost_inr: unknown }[];
  const stageOf = new Map<string, string | null>();
  for (let i = 0; i < eff.length; i += 150) {
    const ids = eff.slice(i, i + 150).map((r) => r.id);
    const { data } = await db.from('cost_ledger').select('id, stage').in('id', ids);
    for (const r of data ?? []) stageOf.set(r.id, r.stage);
  }
  const spent = new Map((spendRes.data ?? []).map((r) => [r.episode_id as string, n(r.spent_inr)]));
  return episodes.map((e, i) => {
    const rows = eff.filter((r) => r.eff_script_id === e.scriptId).map((r) => ({ stage: stageOf.get(r.id) ?? null, inr: n(r.cost_inr) }));
    const c = clips[i];
    return {
      episode: e,
      // v_episode_spend coalesces to 0, so with no attributed ledger row the total is withheld:
      // an episode nothing has been charged to yet has no spend to show, not ₹0.
      spentInr: e.scriptId && rows.length ? (spent.get(e.id) ?? null) : null,
      nodeCost: costsByNode(rows),
      stills: c && c.stillsPlanned > 0 ? { done: c.stills, planned: c.stillsPlanned } : null,
      clips: c && c.generatedPlanned > 0 ? { done: c.clips, planned: c.generatedPlanned } : null,
    };
  });
}

export const spentNodesOf = (m: Map<ChainNode, number | null>) => new Set(CHAIN_NODES.filter((k) => m.has(k)));

/**
 * Cost per finished video this month for this channel, with its denominator — the same rows
 * and the same "countable" rule as the Costs screen (cost/video.ts). Null = undefined: no
 * video finished this month.
 */
export async function monthCostPerVideo(channelId: string, monthStart: string): Promise<{ inr: number | null; n: number; readable: boolean }> {
  const r = await readVideoCosts();
  if (!r.ok) return { inr: null, n: 0, readable: false };
  const rows = r.rows.filter(
    (x) => x.channelId === channelId && x.createdAt.slice(0, 10) >= monthStart && (x.denominatorState === 'countable_measured' || x.denominatorState === 'countable_estimated'),
  );
  if (!rows.length) return { inr: null, n: 0, readable: true };
  const total = rows.reduce((a, x) => a + (x.measuredInr ?? 0) + (x.estimatedInr ?? 0), 0);
  return { inr: Math.round((total / rows.length) * 100) / 100, n: rows.length, readable: true };
}

/** Slots from today for days banked (v_slot_status.production_status). Null when unreadable. */
export async function slotsAhead(db: Db, channelId: string, today: string, days: number): Promise<{ date: string; status: string | null }[] | null> {
  const to = new Date(`${today}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + days);
  const { data, error } = await db
    .from('v_slot_status')
    .select('slot_date, production_status')
    .eq('channel_id', channelId)
    .gte('slot_date', today)
    .lte('slot_date', to.toISOString().slice(0, 10))
    .order('slot_date');
  if (error) return null;
  return (data ?? []).filter((s) => s.slot_date).map((s) => ({ date: s.slot_date!, status: s.production_status }));
}

export interface CutWaiting {
  episodeId: string;
  slot: string;
  title: string;
  durationS: number | null;
  lufs: number | null;
}

export async function cutsWaiting(db: Db, eps: readonly EpisodeRow[]): Promise<CutWaiting[]> {
  const waiting = eps.filter((e) => e.status === 'awaiting_cut');
  if (!waiting.length) return [];
  const renderIds = waiting.map((e) => e.finalRenderId).filter((x): x is string => !!x);
  const { data } = renderIds.length ? await db.from('renders').select('id, duration_s').in('id', renderIds) : { data: [] };
  const dur = new Map((data ?? []).map((r) => [r.id, n(r.duration_s)]));
  return waiting.map((e) => ({
    episodeId: e.id,
    slot: e.slot,
    title: e.premise,
    durationS: e.finalRenderId ? (dur.get(e.finalRenderId) ?? null) : null,
    lufs: n(((e.qc ?? {}) as { loudness_lufs?: unknown }).loudness_lufs),
  }));
}

export async function fallbacks(db: Db, channelId: string): Promise<FallbackWaiting[]> {
  return fallbacksWaiting(db, channelId).catch(() => []);
}

export type { SpendRow };
