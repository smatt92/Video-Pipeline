import { z } from 'zod';

import type { Db } from '../db/server';
import { hookPattern } from '../db/enums';
import { routed, type RouterDeps } from '../llm/router';
import { BRIEF_SYSTEM, briefUserMessage, JUDGE_SYSTEM } from '../prompts/20-bureau.v1';
import { ENGINEERED_PROMPT_REF, ENGINEERED_SYSTEM, engineeredUserMessage } from '../prompts/23-engineered.v1';
import { getBible, type ChannelBible, type Series } from './bible';
import { draftFromDecoded, EngineeredDecodeSchema, engineeredBrief, EngineeredDraftSchema, evolutionProblems, narratorOf } from './engineered';
import { formatOf } from './formats';
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

export async function draftBriefForSlot(db: Db, slotId: string, deps: Omit<RouterDeps, 'subject'> & { channelId: string }): Promise<GenerateResult> {
  const { data: slot } = await db
    .from('slots')
    .select('id, slot_date, series, topic, hook, lead, seasonal_tag, episode, kind')
    .eq('id', slotId)
    .eq('channel_id', deps.channelId)
    .maybeSingle();
  if (!slot) return { ok: false, error: `No slot ${slotId} on this channel.` };
  if (slot.series === 'sequel') return { ok: false, error: 'Sequel slots are drafted by the weekly review, not here.' };
  const cb = await getBible(db, deps.channelId);
  const series = cb.seriesFor(slot.series);
  // A series whose default is the 3D explainer is written in that shape (0052) — a different
  // writer prompt, the draft's evolution shape checked in code, then the same brief schema.
  if (formatOf({ seriesFormat: series.visual_format }).format === 'engineered') return draftEngineeredBrief(db, { slot, cb, series }, deps);

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

  const result = await routed(
    {
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
    },
    { ...deps, subject: { kind: 'channel', channelId: deps.channelId, idempotencyKey: `brief:${slotId}:${Date.now()}`, stage: '20-brief' } },
  );

  const ep = slot.episode ? /^S(\d+)E(\d+)$/.exec(slot.episode) : null;
  const candidate = {
    ...result.data,
    slot_id: slot.id,
    series: slot.series,
    season: ep ? Number(ep[1]) : null,
    episode: ep ? Number(ep[2]) : null,
    lead_character: cb.characterBySlug(result.data.lead_character) ? result.data.lead_character : series.lead[0],
    tags: ['drafted:server'],
    flag: false,
    flag_reasons: [],
  };
  const parsed = briefInputSchema(cb).safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, brief: parsed.data };
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
  ctx: { slot: { id: string; slot_date: string | null; series: string; topic: string; hook: string | null; episode: string | null }; cb: ChannelBible; series: Series },
  deps: Omit<RouterDeps, 'subject'> & { channelId: string },
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
      { ...deps, subject: { kind: 'channel', channelId: deps.channelId, idempotencyKey: `brief:${slot.id}:${Date.now()}:${attempt}`, stage: '20-brief' } },
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
