import { z } from 'zod';

import { readUsdInrRate } from '../cost/fx';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { bureauSeries, hookPattern } from '../db/enums';
import { BIBLE, CHARACTER_SLUGS, SERIES } from './bible';
import type { Embedder } from './embed';
import { estimateEpisode, PlannedShotSchema } from './estimate';
import { classifySource, FactSchema, policyLint, type LintResult } from './policy-lint';
import { parseScript } from './script-lines';
import type { BureauToken } from './tokens';
import {
  checkVariation,
  loadVariationHistory,
  loadVariationPolicy,
  similarityFor,
  type VariationResult,
} from './variation';

/**
 * Briefs: the unit Sahil approves.
 *
 * An agent drafts them (Routine C, through briefs_create_batch); the server re-runs both
 * checks itself rather than trusting the agent's report, records the results on the row,
 * and flags anything that failed. A flagged brief can still be approved — the approver sees
 * why it was flagged — but it is never silently passed.
 */

const Slug = z.string().refine((s) => CHARACTER_SLUGS.includes(s), 'not a cast slug');

export const TitleSchema = z.object({ text: z.string().min(3).max(100), hook_archetype: hookPattern });

export const BeatSchema = z.object({
  beat_id: z.string().min(1),
  summary: z.string().min(1),
});

export const BriefInputSchema = z
  .object({
    slot_id: z.string().regex(/^(S\d{3}|L\d{2}|B\d{2})$/).nullish(),
    series: bureauSeries,
    season: z.number().int().positive().nullish(),
    episode: z.number().int().positive().nullish(),
    lead_character: Slug,
    supporting_characters: z.array(Slug).default([]),
    desk: z.string().min(1),
    premise: z.string().min(10).max(300),
    premise_type: z.string().min(1),
    structure_variant: z.string().min(1),
    ending_type: z.string().min(1),
    music_bed: z.string().min(1),
    hook_archetype: hookPattern,
    catchphrase_used: z.string().nullish(),
    punchlines: z.array(z.string().min(3).max(200)).length(3),
    beat_sheet: z.array(BeatSchema).min(1),
    script_text: z.string().min(10),
    shot_list: z.array(PlannedShotSchema).default([]),
    fact: FactSchema,
    titles: z.array(TitleSchema).length(3),
    pinned_comment: z.string().min(5).max(300),
    tags: z.array(z.string()).default([]),
    /** The agent's own judgement that this brief needs a human look, with reasons. */
    flag: z.boolean().default(false),
    flag_reasons: z.array(z.string()).default([]),
    source_comment_id: z.uuid().nullish(),
  })
  .superRefine((b, ctx) => {
    const series = SERIES[b.series];
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!series.structure_variants.some((v) => v.id === b.structure_variant)) {
      issue('structure_variant', `not one of ${series.structure_variants.map((v) => v.id).join(', ')}`);
    }
    if (!series.ending_types.includes(b.ending_type)) issue('ending_type', `not one of ${series.ending_types.join(', ')}`);
    if (!series.music_bed_pool.includes(b.music_bed)) issue('music_bed', `not in the ${b.series} music-bed pool`);
    if (!series.premise_types.includes(b.premise_type)) issue('premise_type', `not one of ${series.premise_types.join(', ')}`);
    if (b.series === 'pip' && (!b.season || !b.episode)) issue('episode', "Pip's First Year is serialised: season and episode are required");
    const parsed = parseScript(b.script_text);
    if (!parsed.ok) issue('script_text', parsed.problems.join('; '));
    if (b.catchphrase_used && !BIBLE.characters.some((c) => c.catchphrase.text.toLowerCase() === b.catchphrase_used!.toLowerCase())) {
      issue('catchphrase_used', 'not a cast catchphrase');
    }
    if (b.series === 'complaint' && !b.source_comment_id) {
      issue('source_comment_id', 'Complaint Box episodes are built from a real comment (complaint_candidates)');
    }
  });
export type BriefInput = z.infer<typeof BriefInputSchema>;

export interface CreateDeps {
  db: Db;
  token: BureauToken;
  embed?: Embedder;
}

export type CreateOutcome =
  | { index: number; ok: true; brief_id: string; flagged: boolean; flag_reasons: string[]; estimate_inr: number | null; variation: VariationResult['status']; policy: LintResult['status'] }
  | { index: number; ok: false; error: string };

export async function createBriefs(rawBriefs: unknown[], deps: CreateDeps): Promise<CreateOutcome[]> {
  const { db, token } = deps;
  const out: CreateOutcome[] = [];
  const fx = await readUsdInrRate(db);
  const usdInrRate = fx.ok ? fx.rate : null;
  const policy = await loadVariationPolicy(db, token.channelId);

  for (const [index, raw] of rawBriefs.entries()) {
    const parsed = BriefInputSchema.safeParse(raw);
    if (!parsed.success) {
      out.push({ index, ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'brief'}: ${i.message}`).join('; ') });
      continue;
    }
    const b = parsed.data;

    const lint = policyLint({ ...b, fact: b.fact });
    const embedding = deps.embed ? await deps.embed([`${b.premise}\n${b.script_text}`, b.titles.map((t) => t.text).join('\n')]) : null;
    const vectors = embedding && embedding.ok ? embedding.vectors : null;

    let slotDate: string | null = null;
    if (b.slot_id) {
      const { data: slot } = await db.from('slots').select('slot_date, channel_id').eq('id', b.slot_id).maybeSingle();
      if (!slot || slot.channel_id !== token.channelId) {
        out.push({ index, ok: false, error: `slot ${b.slot_id} does not exist on this channel` });
        continue;
      }
      slotDate = slot.slot_date;
    }

    const history = await loadVariationHistory(db, token.channelId);
    const similarity = await similarityFor(
      db,
      token.channelId,
      vectors ? vectors[0] : null,
      policy.similarity_window,
      null,
      embedding && !embedding.ok ? embedding.detail : 'embeddings are not configured',
    );
    const variation = checkVariation(
      { ...b, lead: b.lead_character, on_date: slotDate ?? undefined },
      history,
      policy,
      similarity,
    );

    const parsedScript = parseScript(b.script_text);
    const voChars = parsedScript.ok ? parsedScript.voText.length : b.script_text.length;
    const estimate = usdInrRate === null ? null : await estimateEpisode(db, { shots: b.shot_list, voChars, usdInrRate });

    const flagReasons = [
      ...b.flag_reasons,
      ...lint.violations.map((v) => `policy:${v.rule}`),
      ...(lint.status === 'needs_judge' ? ['policy:needs_judge'] : []),
      ...variation.failing_axes.map((f) => `variation:axes_vs_${f.against_brief_id.slice(0, 8)}`),
      ...(variation.hook_archetype.ok ? [] : ['variation:hook_archetype_weekly']),
      ...(variation.catchphrase.ok ? [] : ['variation:catchphrase_weekly']),
      ...(variation.similarity.ok === false ? ['variation:similarity'] : []),
    ];
    const flagged = b.flag || flagReasons.length > b.flag_reasons.length;

    const { data: row, error } = await db
      .from('briefs')
      .insert({
        channel_id: token.channelId,
        slot_id: b.slot_id ?? null,
        series: b.series,
        season: b.season ?? null,
        episode: b.episode ?? null,
        lead_character: b.lead_character,
        supporting_characters: b.supporting_characters,
        desk: b.desk,
        premise: b.premise,
        premise_type: b.premise_type,
        structure_variant: b.structure_variant,
        ending_type: b.ending_type,
        music_bed: b.music_bed,
        hook_archetype: b.hook_archetype,
        catchphrase_used: b.catchphrase_used ?? null,
        punchlines: b.punchlines as unknown as Json,
        beat_sheet: b.beat_sheet as unknown as Json,
        script_text: b.script_text,
        shot_list: b.shot_list as unknown as Json,
        fact: b.fact as unknown as Json,
        titles: b.titles as unknown as Json,
        pinned_comment: b.pinned_comment,
        estimate_inr: estimate?.total_inr ?? null,
        estimate_basis: (estimate ?? { unpriced: ['no USD→INR rate set'] }) as unknown as Json,
        tags: b.tags,
        flagged,
        flag_reasons: flagReasons,
        variation: variation as unknown as Json,
        policy: lint as unknown as Json,
        script_embedding: vectors ? `[${vectors[0].join(',')}]` : null,
        title_embedding: vectors ? `[${vectors[1].join(',')}]` : null,
        embedding_model: embedding && embedding.ok ? embedding.model : null,
        source_comment_id: b.source_comment_id ?? null,
        created_by: token.scope,
        created_by_token: token.id,
      })
      .select('id')
      .single();

    if (error || !row) {
      const msg = error?.message ?? 'no row';
      out.push({
        index,
        ok: false,
        error: /briefs_one_live_per_slot/.test(msg) ? `slot ${b.slot_id} already has a pending or approved brief` : msg,
      });
      continue;
    }

    const c = classifySource(b.fact.source_url);
    await db.from('fact_sources').insert({
      brief_id: row.id,
      claim: b.fact.claim,
      url: b.fact.source_url,
      domain: c.domain ?? 'unparseable',
      source_class: c.source_class,
      title: b.fact.source_title ?? null,
    });
    if (b.source_comment_id) {
      await db.from('comments').update({ used_in_brief_id: row.id }).eq('id', b.source_comment_id);
    }
    await db.from('authorship_log').insert({
      channel_id: token.channelId,
      actor_scope: token.scope,
      token_id: token.id,
      profile_id: token.profileId,
      action: 'brief_create',
      subject_type: 'brief',
      subject_id: row.id,
      exact_text: b.premise,
      payload: { slot_id: b.slot_id ?? null, flagged, flag_reasons: flagReasons } as unknown as Json,
    });

    out.push({
      index,
      ok: true,
      brief_id: row.id,
      flagged,
      flag_reasons: flagReasons,
      estimate_inr: estimate?.total_inr ?? null,
      variation: variation.status,
      policy: lint.status,
    });
  }
  return out;
}

// ── Reads ────────────────────────────────────────────────────────────────────

// One literal: supabase-js infers the row type from it, and a concatenation defeats that.
const BRIEF_COLUMNS =
  'id, slot_id, series, season, episode, lead_character, supporting_characters, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, catchphrase_used, punchlines, beat_sheet, script_text, shot_list, fact, titles, pinned_comment, estimate_inr, estimate_basis, flagged, flag_reasons, variation, policy, status, chosen_punchline, approved_at, rejected_at, reject_reason, created_by, created_at' as const;

export async function getBrief(db: Db, channelId: string, id: string) {
  const { data, error } = await db.from('briefs').select(BRIEF_COLUMNS).eq('id', id).eq('channel_id', channelId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function pendingBriefs(db: Db, channelId: string) {
  const { data, error } = await db
    .from('briefs')
    .select(BRIEF_COLUMNS)
    .eq('channel_id', channelId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  const slots = new Map<string, string | null>();
  const ids = [...new Set((data ?? []).map((b) => b.slot_id).filter((s): s is string => !!s))];
  if (ids.length) {
    const { data: rows } = await db.from('slots').select('id, slot_date').in('id', ids);
    for (const r of rows ?? []) slots.set(r.id, r.slot_date);
  }
  return (data ?? [])
    .map((b, n) => ({ n: n + 1, slot_date: b.slot_id ? slots.get(b.slot_id) ?? null : null, ...b }))
    .sort((a, b) => (a.slot_date ?? '9999').localeCompare(b.slot_date ?? '9999'));
}

/** "A" / "B" / "C" pick a drafted punchline; anything else is Sahil's own line. */
export function resolvePunchline(punchlines: string[], choice: string): { text: string; choice: 'A' | 'B' | 'C' | 'custom' } {
  const t = choice.trim();
  const letter = /^[ABCabc]$/.test(t) ? (t.toUpperCase() as 'A' | 'B' | 'C') : null;
  if (letter) {
    const text = punchlines['ABC'.indexOf(letter)];
    if (!text) throw new Error(`Punchline ${letter} does not exist on this brief.`);
    return { text, choice: letter };
  }
  return { text: t, choice: 'custom' };
}
