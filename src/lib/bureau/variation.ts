import { z } from 'zod';

import type { Db } from '../db/server';
import { BIBLE } from './bible';

/**
 * variation_check — the anti-repetition gate.
 *
 * A brief must differ from each of the last `variation_window` (14) episodes on at least
 * `variation_min_axes` (4) of the seven axes; its script must sit below `similarity_max`
 * (0.85) cosine against the last `similarity_window` (60); no hook archetype more than
 * `hook_archetype_weekly_max` (2) times in a calendar week; no catchphrase more than its
 * character's weekly limit. All thresholds are `channel_policy` columns — the approver sets
 * them with caps_set, nothing here hardcodes one.
 *
 * Three outcomes: pass, fail, and **refused** — similarity could not be computed (no
 * embedding key, the free tier rate-limited past its retries, the vendor refused). Refused
 * carries `refused_reason`, the vendor's own sentence, and is never reported as a pass and
 * never as a similarity of 0: a check that did not run has not passed (CLAUDE.md, "absent
 * and zero are different facts"). `approveBrief` refuses a brief whose check refused, and
 * so does `bureau_brief_approve` in the database (0043).
 *
 * Briefs written before 0043 stored this outcome as `incomplete`; `variationRefusal` reads
 * both spellings so an old row cannot slip through on its name.
 */

export const AXES = [
  'series',
  'lead',
  'desk',
  'premise_type',
  'structure_variant',
  'ending_type',
  'music_bed',
] as const;
export type Axis = (typeof AXES)[number];

export const VariationCandidateSchema = z.object({
  id: z.uuid().optional(),
  series: z.string().min(1),
  lead: z.string().min(1),
  desk: z.string().min(1),
  premise_type: z.string().min(1),
  structure_variant: z.string().min(1),
  ending_type: z.string().min(1),
  music_bed: z.string().min(1),
  hook_archetype: z.string().min(1),
  catchphrase_used: z.string().nullish(),
  /** The slot date the brief airs on (YYYY-MM-DD); today when absent. */
  on_date: z.iso.date().optional(),
});
export type VariationCandidate = z.infer<typeof VariationCandidateSchema>;

export interface HistoryRow extends Record<Axis, string> {
  brief_id: string;
  hook_archetype: string;
  catchphrase_used: string | null;
  on_date: string;
}

export interface VariationPolicy {
  variation_window: number;
  variation_min_axes: number;
  similarity_max: number;
  hook_archetype_weekly_max: number;
  catchphrase_weekly_max: number;
}

export type Similarity =
  | { checked: true; /** null = nothing to compare against yet, never 0. */ max: number | null; nearest_brief_id: string | null; compared: number }
  | { checked: false; reason: string };

export interface VariationResult {
  status: 'pass' | 'fail' | 'refused';
  passed: boolean;
  /** Set whenever similarity was not computed — including on a `fail`, so the reason survives. */
  refused_reason: string | null;
  failing_axes: { against_brief_id: string; differing: number; same_axes: Axis[] }[];
  hook_archetype: { week: string; count_including_this: number; max: number; ok: boolean };
  catchphrase: { text: string | null; week_count_including_this: number; max: number; ok: boolean };
  similarity: Similarity & { threshold: number; ok: boolean | null };
  compared_against: number;
}

/** ISO week key, e.g. "2026-W43". The channel's schedule is weekly Mon–Sun. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function catchphraseLimit(text: string | null | undefined, policyMax: number): number {
  if (!text) return policyMax;
  const owner = BIBLE.characters.find((c) => c.catchphrase.text.toLowerCase() === text.toLowerCase());
  return owner ? Math.min(owner.catchphrase.max_per_week, policyMax) : policyMax;
}

export function checkVariation(
  raw: VariationCandidate,
  history: readonly HistoryRow[],
  policy: VariationPolicy,
  similarity: Similarity,
  today: string = new Date().toISOString().slice(0, 10),
): VariationResult {
  const c = VariationCandidateSchema.parse(raw);
  const onDate = c.on_date ?? today;
  const others = history.filter((h) => h.brief_id !== c.id);

  // The last N by air date, nearest first — "the last 14 episodes" relative to this one.
  const window = [...others]
    .sort((a, b) => b.on_date.localeCompare(a.on_date))
    .slice(0, policy.variation_window);

  const failing_axes = window
    .map((h) => {
      const same = AXES.filter((a) => h[a] === c[a]);
      return { against_brief_id: h.brief_id, differing: AXES.length - same.length, same_axes: same };
    })
    .filter((r) => r.differing < policy.variation_min_axes);

  const week = isoWeek(onDate);
  const sameWeek = others.filter((h) => isoWeek(h.on_date) === week);
  const hookCount = sameWeek.filter((h) => h.hook_archetype === c.hook_archetype).length + 1;
  const hookOk = hookCount <= policy.hook_archetype_weekly_max;

  const phrase = c.catchphrase_used ?? null;
  const phraseMax = catchphraseLimit(phrase, policy.catchphrase_weekly_max);
  const phraseCount = phrase
    ? sameWeek.filter((h) => (h.catchphrase_used ?? '').toLowerCase() === phrase.toLowerCase()).length + 1
    : 0;
  const phraseOk = phraseCount <= phraseMax;

  const simOk = similarity.checked ? similarity.max === null || similarity.max < policy.similarity_max : null;

  const hardFail = failing_axes.length > 0 || !hookOk || !phraseOk || simOk === false;
  const status = hardFail ? 'fail' : simOk === null ? 'refused' : 'pass';

  return {
    status,
    passed: status === 'pass',
    refused_reason: similarity.checked ? null : `similarity not computed — ${similarity.reason}`,
    failing_axes,
    hook_archetype: { week, count_including_this: hookCount, max: policy.hook_archetype_weekly_max, ok: hookOk },
    catchphrase: { text: phrase, week_count_including_this: phraseCount, max: phraseMax, ok: phraseOk },
    similarity: { ...similarity, threshold: policy.similarity_max, ok: simOk },
    compared_against: window.length,
  };
}

// ── Loading the history and the policy ───────────────────────────────────────

export async function loadVariationPolicy(db: Db, channelId: string): Promise<VariationPolicy & { similarity_window: number }> {
  const { data, error } = await db
    .from('channel_policy')
    .select('variation_window, variation_min_axes, similarity_window, similarity_max, hook_archetype_weekly_max, catchphrase_weekly_max')
    .eq('channel_id', channelId)
    .single();
  if (error || !data) throw new Error(`No channel_policy row for ${channelId}: ${error?.message}`);
  return {
    variation_window: data.variation_window,
    variation_min_axes: data.variation_min_axes,
    similarity_window: data.similarity_window,
    // numeric arrives as a string over the wire; Number() is safe for a 0–1 threshold.
    similarity_max: Number(data.similarity_max),
    hook_archetype_weekly_max: data.hook_archetype_weekly_max,
    catchphrase_weekly_max: data.catchphrase_weekly_max,
  };
}

export async function loadVariationHistory(db: Db, channelId: string): Promise<HistoryRow[]> {
  const { data, error } = await db
    .from('v_variation_ledger')
    .select('brief_id, series, lead, desk, premise_type, structure_variant, ending_type, music_bed, hook_archetype, catchphrase_used, on_date')
    .eq('channel_id', channelId)
    .order('on_date', { ascending: false })
    .limit(200);
  if (error) throw new Error(`Reading the variation ledger failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    brief_id: r.brief_id!,
    series: r.series!,
    lead: r.lead!,
    desk: r.desk!,
    premise_type: r.premise_type!,
    structure_variant: r.structure_variant!,
    ending_type: r.ending_type!,
    music_bed: r.music_bed!,
    hook_archetype: r.hook_archetype!,
    catchphrase_used: r.catchphrase_used,
    on_date: String(r.on_date).slice(0, 10),
  }));
}

/** Cosine against the last N, through the database's own pgvector function. */
export async function similarityFor(
  db: Db,
  channelId: string,
  embedding: number[] | null,
  window: number,
  excludeBriefId: string | null,
  unavailableReason = 'no embedding was computed for this brief',
): Promise<Similarity> {
  if (!embedding) return { checked: false, reason: unavailableReason };
  const { data, error } = await db.rpc('brief_similarity', {
    p_channel: channelId,
    p_embedding: `[${embedding.join(',')}]`,
    p_window: window,
    // The function treats a null as "exclude nothing"; the generated arg type is non-null,
    // and the nil UUID matches no brief, so it means the same thing.
    p_exclude: excludeBriefId ?? '00000000-0000-0000-0000-000000000000',
  });
  if (error) return { checked: false, reason: `similarity query failed: ${error.message}` };
  const rows = data ?? [];
  if (rows.length === 0) return { checked: true, max: null, nearest_brief_id: null, compared: 0 };
  return {
    checked: true,
    max: Number(rows[0].similarity),
    nearest_brief_id: rows[0].brief_id,
    compared: rows.length,
  };
}

/**
 * Why a stored variation result may not be approved, or null when it may. A `fail` is
 * approvable — it is flagged, and a human deciding against a flag is the design. A check
 * that could not run is not: there is nothing for the human to weigh. Also reads the pre-0043
 * spelling (`incomplete`) and a result with no similarity block at all.
 */
export function variationRefusal(stored: unknown): string | null {
  const v = (stored ?? null) as { status?: string; refused_reason?: string | null; similarity?: { checked?: boolean; reason?: string } } | null;
  if (!v || typeof v.status !== 'string') return 'variation_check has no stored result for this brief';
  if (v.status === 'refused' || v.status === 'incomplete' || v.similarity?.checked !== true) {
    return v.refused_reason ?? `similarity not computed — ${v.similarity?.reason ?? 'no reason recorded'}`;
  }
  return null;
}
