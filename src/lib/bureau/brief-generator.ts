import { z } from 'zod';

import type { Db } from '../db/server';
import { hookPattern } from '../db/enums';
import { routedBatch } from '../llm/batch';
import { routed, type RoutedCall, type RouterDeps } from '../llm/router';
import { BRIEF_SYSTEM, briefUserMessage, JUDGE_SYSTEM } from '../prompts/20-bureau.v1';
import { ENGINEERED_PROMPT_REF, ENGINEERED_SYSTEM, engineeredUserMessage } from '../prompts/23-engineered.v1';
import { getBible, type ChannelBible, type Series } from './bible';
import { draftFromDecoded, EngineeredDecodeSchema, engineeredBrief, EngineeredDraftSchema, evolutionProblems, narratorOf } from './engineered';
import { formatOf, type VisualFormat } from './formats';
import { briefInputSchema, type BriefInput } from './briefs';
import { SHOT_ROUTES } from './estimate';
import type { LintResult } from './policy-lint';
import { topPerformers } from './read';

/**
 * The server-side brief writer (writer tier) and the policy judge (judge tier).
 *
 * Routine C drafts briefs through the MCP tools in the normal course; this exists for the
 * daily safety net (`19-draft-briefs`), which fills only a slot that is two days out with no
 * live brief — so a Routine that failed to run does not leave an empty slot. Both write
 * their cost rows through the router.
 */

// The decode schema: structural only. The cross-field rules live in BriefInputSchema and are
// applied after, where a violation is a legible error rather than an unterminated decode.
const DraftSchema = z.object({
  lead_character: z.string(),
  supporting_characters: z.array(z.string()),
  desk: z.string(),
  premise: z.string(),
  premise_type: z.string(),
  structure_variant: z.string(),
  ending_type: z.string(),
  music_bed: z.string(),
  hook_archetype: hookPattern,
  catchphrase_used: z.string().nullable(),
  punchlines: z.array(z.string()),
  beat_sheet: z.array(z.object({ beat_id: z.string(), summary: z.string() })),
  script_text: z.string(),
  shot_list: z.array(
    z.object({
      beat_id: z.string(),
      route: z.enum(SHOT_ROUTES),
      description: z.string(),
      duration_s: z.number(),
      characters: z.array(z.string()),
      realistic: z.boolean(),
    }),
  ),
  fact: z.object({ claim: z.string(), source_url: z.string(), source_title: z.string() }),
  titles: z.array(z.object({ text: z.string(), hook_archetype: hookPattern })),
  pinned_comment: z.string(),
});

export type GenerateResult = { ok: true; brief: BriefInput } | { ok: false; error: string };

/** What the writers need from a slot. A Studio draft has no slot row: `id` is null then. */
export interface DraftSlot {
  id: string | null;
  slot_date: string | null;
  series: string;
  topic: string;
  hook: string | null;
  lead: string | null;
  seasonal_tag: string | null;
  episode: string | null;
}

/**
 * Who pays for the writer calls. `studioSessionId` is set when a Studio session asked for the
 * draft: the ledger row then carries the session as well as the channel, so the session's
 * spend cap (derived from its rows by 0017's trigger) sees the writer it caused.
 */
export type DraftDeps = Omit<RouterDeps, 'subject'> & { channelId: string; studioSessionId?: string };

export async function draftBriefForSlot(db: Db, slotId: string, deps: DraftDeps): Promise<GenerateResult> {
  const { data: slot } = await db
    .from('slots')
    .select('id, slot_date, series, topic, hook, lead, seasonal_tag, episode, kind')
    .eq('id', slotId)
    .eq('channel_id', deps.channelId)
    .maybeSingle();
  if (!slot) return { ok: false, error: `No slot ${slotId} on this channel.` };
  if (slot.series === 'sequel') return { ok: false, error: 'Sequel slots are drafted by the weekly review, not here.' };
  return draftBrief(db, { slot }, deps);
}

/**
 * Draft one brief for a slot — a calendar row, or a topic the Studio was given with no slot.
 *
 * The writer follows the video type: the 3D explainer is written in its own shape (0052) when
 * it is the type asked for, or the series' default (Built Like That's narrator-only cast has
 * no dialogue for the ordinary writer to write); every other type gets the ordinary writer.
 * Either way the result passes the channel's own brief schema, and `createBriefs` lints,
 * checks variation and prices it like any other brief.
 */
export async function draftBrief(db: Db, input: { slot: DraftSlot; format?: VisualFormat }, deps: DraftDeps): Promise<GenerateResult> {
  const plan = await planDraft(db, input, deps);
  if (plan.kind === 'refused') return { ok: false, error: plan.error };
  if (plan.kind === 'engineered') return draftEngineeredBrief(db, plan.ctx, deps);
  const label = input.slot.id ?? `studio-${input.slot.topic.slice(0, 24)}`;
  const result = await routed(plan.call, { ...deps, subject: writerSubject(deps, `brief:${label}:${Date.now()}`, '20-brief') });
  return plan.finish(result.data);
}

/**
 * The nightly safety net's draft, through the Message Batches API (llm/batch.ts).
 *
 * Call it on every tick with the same `dayKey`: the first call submits and returns 'pending',
 * later ones collect, and the one after the batch has ended returns the brief (or why not).
 * One attempt per slot per day — the same cadence the daily task always had — because the key
 * is the slot and the day: a draft that fails validation today is redrafted tomorrow, never
 * re-collected forever.
 *
 * The 3D explainer is NOT batched: its writer may rewrite once on length (two calls, the second
 * depending on the first), so it is drafted synchronously, exactly as before.
 */
export async function draftBriefForSlotBatched(
  db: Db,
  slotId: string,
  dayKey: string,
  deps: DraftDeps,
): Promise<{ state: 'pending' } | { state: 'done'; result: GenerateResult } | { state: 'failed'; reason: string }> {
  const { data: slot } = await db
    .from('slots')
    .select('id, slot_date, series, topic, hook, lead, seasonal_tag, episode, kind')
    .eq('id', slotId)
    .eq('channel_id', deps.channelId)
    .maybeSingle();
  if (!slot) return { state: 'done', result: { ok: false, error: `No slot ${slotId} on this channel.` } };
  if (slot.series === 'sequel') return { state: 'done', result: { ok: false, error: 'Sequel slots are drafted by the weekly review, not here.' } };
  const plan = await planDraft(db, { slot }, deps);
  if (plan.kind === 'refused') return { state: 'done', result: { ok: false, error: plan.error } };
  if (plan.kind === 'engineered') return { state: 'done', result: await draftEngineeredBrief(db, plan.ctx, deps) };
  const customId = briefBatchCustomId(slotId, dayKey);
  const r = await routedBatch({ ...plan.call, customId }, { ...deps, subject: writerSubject(deps, customId, '20-brief') });
  if (r.state === 'pending') return { state: 'pending' };
  if (r.state === 'failed') return { state: 'failed', reason: r.reason };
  return { state: 'done', result: plan.finish(r.data) };
}

/** 06:45 IST: the hour the daily safety net has always drafted in. Other hourly ticks only collect. */
export const SAFETY_NET_SUBMIT_HOUR_UTC = 1;

/** The slot and day a safety-net batch key names, or null for any other key. */
export function briefBatchKey(customId: string): { slotId: string; dayKey: string } | null {
  const m = /^brief-(.+)-(\d{8})$/.exec(customId);
  return m ? { slotId: m[1], dayKey: m[2] } : null;
}

export const briefBatchCustomId = (slotId: string, dayKey: string) => `brief-${slotId}-${dayKey.replaceAll('-', '')}`;

type DraftPlan =
  | { kind: 'refused'; error: string }
  | { kind: 'engineered'; ctx: Parameters<typeof draftEngineeredBrief>[1] }
  | { kind: 'ordinary'; call: RoutedCall<typeof DraftSchema>; finish(data: z.infer<typeof DraftSchema>): GenerateResult };

/**
 * What drafting a brief for this slot will take: a refusal, the 3D explainer's writer, or the
 * ordinary writer's one call plus what turns its output into a brief. Shared by the
 * synchronous draft and the batched one, so the two cannot drift into asking differently.
 * Which writer a slot gets is described on `draftBrief`.
 */
async function planDraft(db: Db, input: { slot: DraftSlot; format?: VisualFormat }, deps: DraftDeps): Promise<DraftPlan> {
  const { slot } = input;
  let cb: ChannelBible;
  let series: Series;
  try {
    cb = await getBible(db, deps.channelId);
    series = cb.seriesFor(slot.series);
  } catch (err) {
    return { kind: 'refused', error: err instanceof Error ? err.message : String(err) };
  }
  if (!series) return { kind: 'refused', error: `This channel runs no "${slot.series}" series.` };
  if (slot.series === 'sequel' || slot.series === 'long_form') return { kind: 'refused', error: `A ${slot.series} brief is assembled from aired episodes, not drafted from a topic.` };
  const seriesFormat = formatOf({ seriesFormat: series.visual_format }).format;
  if (input.format === 'engineered' || seriesFormat === 'engineered') return { kind: 'engineered', ctx: { slot, cb, series } };

  const leads = cb.leadsFromCalendar(slot.lead);
  // 'ohm' and 'complaint_box' are the Bureau's standing cast; on another channel they are
  // simply not in the bible and match nothing.
  const castSlugs = new Set([...series.lead, ...leads, 'ohm', 'complaint_box']);
  const cast = cb.bible.characters.filter((c) => castSlugs.has(c.id) && (c.season_introduced === 1 || c.id !== 'auditor'));

  const { data: recent } = await db
    .from('briefs')
    .select('premise, hook_archetype, structure_variant')
    .eq('channel_id', deps.channelId)
    .order('created_at', { ascending: false })
    .limit(14);
  const top = await topPerformers(db, deps.channelId, 5);

  const call: RoutedCall<typeof DraftSchema> = {
    task: 'brief',
    system: BRIEF_SYSTEM,
    user: briefUserMessage({
      series,
      slot: { id: slot.id, date: slot.slot_date, topic: slot.topic, hook: slot.hook, lead: slot.lead, seasonal_tag: slot.seasonal_tag, episode: slot.episode },
      cast,
      recent: recent ?? [],
      performers: top.performers.map((p) => ({ title: p.title, hook_archetype: p.hook_archetype, apv: p.apv })),
    }),
    schema: DraftSchema,
    maxTokens: 4000,
  };

  const finish = (data: z.infer<typeof DraftSchema>): GenerateResult => {
    const ep = slot.episode ? /^S(\d+)E(\d+)$/.exec(slot.episode) : null;
    const candidate = {
      ...data,
      slot_id: slot.id,
      series: slot.series,
      season: ep ? Number(ep[1]) : null,
      episode: ep ? Number(ep[2]) : null,
      lead_character: cb.characterBySlug(data.lead_character) ? data.lead_character : series.lead[0],
      tags: ['drafted:server'],
      flag: false,
      flag_reasons: [],
    };
    const parsed = briefInputSchema(cb).safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    return { ok: true, brief: parsed.data };
  };
  return { kind: 'ordinary', call, finish };
}

/** The ledger subject for a writer or judge call: the channel, and the Studio session when one asked. */
export function writerSubject(deps: DraftDeps, idempotencyKey: string, stage: '20-brief' | '20-policy-judge'): RouterDeps['subject'] {
  return { kind: 'channel', channelId: deps.channelId, idempotencyKey, stage, ...(deps.studioSessionId ? { studioSessionId: deps.studioSessionId } : {}) };
}

/**
 * The 3D explainer's brief (0052): the writer returns beats with their graphics
 * (EngineeredDraftSchema, Zod-validated); the evolution shape is checked in code and a draft
 * that breaks it is refused by name; then it becomes an ordinary brief — narrator lines, one
 * shot per beat — and passes the channel's brief schema like any other. The server's policy
 * lint (with the hedge check) and variation check run on it in `createBriefs`, as for every
 * brief.
 */
export async function draftEngineeredBrief(
  db: Db,
  ctx: { slot: Pick<DraftSlot, 'id' | 'slot_date' | 'series' | 'topic' | 'hook' | 'episode'>; cb: ChannelBible; series: Series },
  deps: DraftDeps,
): Promise<GenerateResult> {
  const { slot, cb, series } = ctx;
  const narrator = narratorOf(cb, series);
  const { data: recent } = await db.from('briefs').select('premise, hook_archetype, structure_variant').eq('channel_id', deps.channelId).order('created_at', { ascending: false }).limit(14);
  // One rewrite when the ONLY problem is length: the model overshoots the word budget it was
  // given (the first hosted draft, 08-Oct, was 159 against 150), and a shorter retelling of a
  // good draft is cheaper than refusing it. Any other shape problem is refused as before.
  const userMessage = engineeredUserMessage({ series, slot: { id: slot.id, topic: slot.topic, hook: slot.hook }, narrator: narrator.name, recent: recent ?? [] });
  let feedback = '';
  let draft: ReturnType<typeof EngineeredDraftSchema.safeParse> | null = null;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await routed(
      {
        task: 'brief',
        system: ENGINEERED_SYSTEM,
        user: userMessage + feedback,
        schema: EngineeredDecodeSchema,
        maxTokens: 8000,
        thinking: 'minimal',
      },
      { ...deps, subject: writerSubject(deps, `brief:${slot.id ?? 'studio'}:${Date.now()}:${attempt}`, '20-brief') },
    );
    draft = EngineeredDraftSchema.safeParse(draftFromDecoded(result.data));
    if (!draft.success) return { ok: false, error: `the draft is malformed (${ENGINEERED_PROMPT_REF}): ${draft.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    problems = evolutionProblems(draft.data);
    const onlyLength = problems.length > 0 && problems.every((x) => x.startsWith('the script is ') || /narration is \d+ words/.test(x));
    if (!onlyLength || attempt === 2) break;
    feedback = `\n\nYOUR PREVIOUS DRAFT WAS TOO LONG — ${problems.join('; ')}. Write the whole draft again, same story and beats, with every narration line shorter: at most 115 spoken words in total.`;
  }
  if (!draft || !draft.success) return { ok: false, error: 'no draft' };
  if (problems.length) return { ok: false, error: `the draft does not have the evolution shape (${ENGINEERED_PROMPT_REF}): ${problems.join('; ')}` };
  const ep = slot.episode ? /^S(\d+)E(\d+)$/.exec(slot.episode) : null;
  const candidate = {
    ...engineeredBrief(draft.data, { narrator, series }),
    slot_id: slot.id,
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
    tags: ['drafted:server', `prompt:${ENGINEERED_PROMPT_REF}`],
    flag: false,
    flag_reasons: [],
  };
  const parsed = briefInputSchema(cb).safeParse(candidate);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, brief: parsed.data };
}

const JudgeSchema = z.object({
  verdicts: z.array(z.object({ question: z.string(), violation: z.boolean(), reason: z.string() })),
});

/**
 * Settle a `needs_judge` lint. A violation (or any doubt — the prompt says so) keeps the
 * brief flagged for Sahil; only an all-clear turns needs_judge into pass, and the verdicts
 * are kept on the row as the reason.
 */
export async function judgeLint(
  lint: LintResult,
  text: string,
  deps: RouterDeps,
): Promise<LintResult & { judge?: z.infer<typeof JudgeSchema>; judge_model?: string }> {
  if (lint.status !== 'needs_judge') return lint;
  const r = await routed(
    {
      task: 'policy_judge',
      system: JUDGE_SYSTEM,
      user: `SCRIPT AND COPY:\n${text}\n\nQUESTIONS:\n${lint.judge_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      schema: JudgeSchema,
      maxTokens: 1200,
    },
    deps,
  );
  const violation = r.data.verdicts.some((v) => v.violation) || r.data.verdicts.length !== lint.judge_questions.length;
  return {
    ...lint,
    status: violation ? 'fail' : 'pass',
    violations: violation
      ? [...lint.violations, ...r.data.verdicts.filter((v) => v.violation).map((v) => ({ rule: 'judge', detail: v.reason, match: v.question }))]
      : lint.violations,
    judge: r.data,
    judge_model: r.model,
  };
}
