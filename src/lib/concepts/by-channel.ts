import 'server-only';

import type { Db } from '../db/server';

/**
 * The Concepts list for one channel: each concept with its latest script, shot count, what it
 * has cost, and the episode that carries it.
 *
 * ── Cost: two figures, never one sum ─────────────────────────────────────────
 *
 * The ledger writes an estimate at submit and a reconcile on completion, as two rows about one
 * charge (rule 5). Adding them would double every finished charge. So the list shows what has
 * settled (reconcile + refund) and what was committed as an estimate, separately, each null when
 * no row of that kind exists — null renders as an em dash, never ₹0, because a concept nothing
 * has been spent on yet has not cost zero, it has no cost.
 *
 * Rows are read through `v_cost_attributed`, which resolves a generation's charge to its
 * script through the shot. Reading `cost_ledger.concept_id` alone would miss every video
 * generation, which names only its generation (submit.ts says why).
 */

export interface ConceptCost {
  /** Sum of reconcile + refund rows with a figure; null when there are none. */
  readonly settledInr: number | null;
  /** Sum of estimate rows with a figure; null when there are none. */
  readonly estimatedInr: number | null;
  /** Rows whose cost_inr is null — priced against nothing, counted rather than summed as 0. */
  readonly unpricedRows: number;
  readonly rows: number;
}

export interface ConceptListRow {
  readonly id: string;
  readonly title: string;
  readonly angle: string;
  readonly status: string;
  readonly createdAt: string;
  readonly script: { readonly id: string; readonly version: number; readonly humanEditCount: number } | null;
  /** Shots on the latest script; null when there is no script (not zero shots). */
  readonly shotCount: number | null;
  readonly cost: ConceptCost;
  readonly episode: { readonly id: string; readonly status: string; readonly href: string } | null;
}

/** Statuses the Cuts screen lists; anything else is found on the episode board. */
const CUTS_STATUSES = new Set(['awaiting_cut', 'cut_rejected', 'qc', 'assembling']);

export function episodeHref(status: string): string {
  return CUTS_STATUSES.has(status) ? '/bureau/cuts' : '/bureau/board';
}

export async function listConcepts(db: Db, channelId: string, limit = 100): Promise<ConceptListRow[]> {
  const { data: concepts, error } = await db
    .from('concepts')
    .select('id, title, angle, status, created_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Reading concepts: ${error.message}`);
  const ids = (concepts ?? []).map((c) => c.id);
  if (ids.length === 0) return [];

  const { data: scripts } = await db
    .from('scripts')
    .select('id, concept_id, version, human_edit_count')
    .in('concept_id', ids)
    .order('version', { ascending: false });
  const latest = new Map<string, { id: string; version: number; humanEditCount: number }>();
  const scriptToConcept = new Map<string, string>();
  for (const s of scripts ?? []) {
    scriptToConcept.set(s.id, s.concept_id);
    if (!latest.has(s.concept_id)) latest.set(s.concept_id, { id: s.id, version: s.version, humanEditCount: s.human_edit_count });
  }
  const scriptIds = [...scriptToConcept.keys()];
  const latestIds = [...latest.values()].map((s) => s.id);

  const [shots, byConcept, byScript, episodesByConcept, episodesByScript] = await Promise.all([
    latestIds.length ? db.from('shots').select('script_id').in('script_id', latestIds) : Promise.resolve({ data: [] as { script_id: string }[] }),
    db.from('v_cost_attributed').select('id, concept_id, script_id, entry_kind, cost_inr').in('concept_id', ids),
    scriptIds.length
      ? db.from('v_cost_attributed').select('id, concept_id, script_id, entry_kind, cost_inr').in('script_id', scriptIds)
      : Promise.resolve({ data: [] as { id: string | null; concept_id: string | null; script_id: string | null; entry_kind: string | null; cost_inr: number | null }[] }),
    db.from('episodes').select('id, status, concept_id, script_id, updated_at').in('concept_id', ids).order('updated_at', { ascending: false }),
    scriptIds.length
      ? db.from('episodes').select('id, status, concept_id, script_id, updated_at').in('script_id', scriptIds).order('updated_at', { ascending: false })
      : Promise.resolve({ data: [] as { id: string; status: string; concept_id: string | null; script_id: string | null; updated_at: string }[] }),
  ]);

  const shotCounts = new Map<string, number>();
  for (const s of shots.data ?? []) shotCounts.set(s.script_id, (shotCounts.get(s.script_id) ?? 0) + 1);

  // One ledger row can match both queries (a row naming the concept and a script of it).
  const ledger = new Map<string, { conceptId: string; kind: string; inr: number | null }>();
  for (const r of [...(byConcept.data ?? []), ...(byScript.data ?? [])]) {
    if (!r.id) continue;
    const conceptId = r.concept_id ?? (r.script_id ? scriptToConcept.get(r.script_id) : undefined);
    if (!conceptId) continue;
    // numeric arrives as a string; Number() here, at the mapper. A rupee figure is far inside 2^53.
    ledger.set(r.id, { conceptId, kind: r.entry_kind ?? 'estimate', inr: r.cost_inr === null ? null : Number(r.cost_inr) });
  }
  const costs = new Map<string, { settled: number | null; estimated: number | null; unpriced: number; rows: number }>();
  for (const r of ledger.values()) {
    const c = costs.get(r.conceptId) ?? { settled: null, estimated: null, unpriced: 0, rows: 0 };
    c.rows++;
    if (r.inr === null) c.unpriced++;
    else if (r.kind === 'estimate') c.estimated = (c.estimated ?? 0) + r.inr;
    else c.settled = (c.settled ?? 0) + r.inr;
    costs.set(r.conceptId, c);
  }

  const episode = new Map<string, { id: string; status: string; href: string }>();
  for (const e of [...(episodesByConcept.data ?? []), ...(episodesByScript.data ?? [])]) {
    const conceptId = e.concept_id ?? (e.script_id ? scriptToConcept.get(e.script_id) : undefined);
    if (!conceptId || episode.has(conceptId)) continue;
    episode.set(conceptId, { id: e.id, status: e.status, href: episodeHref(e.status) });
  }

  return (concepts ?? []).map((c) => {
    const script = latest.get(c.id) ?? null;
    const cost = costs.get(c.id);
    return {
      id: c.id,
      title: c.title,
      angle: c.angle,
      status: c.status,
      createdAt: c.created_at,
      script,
      shotCount: script ? (shotCounts.get(script.id) ?? 0) : null,
      cost: {
        settledInr: cost?.settled ?? null,
        estimatedInr: cost?.estimated ?? null,
        unpricedRows: cost?.unpriced ?? 0,
        rows: cost?.rows ?? 0,
      },
      episode: episode.get(c.id) ?? null,
    };
  });
}

/** The concept, only when it belongs to this channel — the detail page's 404 test. */
export async function conceptOnChannel(db: Db, conceptId: string, channelId: string): Promise<boolean> {
  const { data } = await db.from('concepts').select('channel_id').eq('id', conceptId).maybeSingle();
  return !!data && data.channel_id === channelId;
}
