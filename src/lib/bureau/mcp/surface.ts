import { z } from 'zod';

import type { Db } from '../../db/server';
import type { Json } from '../../db/types';
import type { McpSurface } from '../../studio/mcp';
import { bibleForChannel, type ChannelBible } from '../bible';
import { createBriefs, getBrief, pendingBriefs } from '../briefs';
import { approveBrief, decideCut, markScheduled, rejectBrief, setCaps, setKillSwitch, type Effects } from '../control';
import type { Embedder } from '../embed';
import { DUB_LANGUAGES, listDubs, queueDubs, regenerateShot } from '../episodes';
import { LintInputSchema, policyLint, type LintResult } from '../policy-lint';
import {
  calendarUpcoming,
  complaintCandidates,
  costsLedger,
  episodeStatus,
  metricsSummary,
  readyBundles,
  topPerformers,
} from '../read';
import type { BureauToken } from '../tokens';
import { youtubeVideoId } from '../../publish/yt-analytics';
import {
  checkVariation,
  loadVariationHistory,
  loadVariationPolicy,
  similarityFor,
  VariationCandidateSchema,
} from '../variation';

/**
 * The Bureau control plane as an MCP surface.
 *
 * ── Scope is enforced in three places, on purpose ────────────────────────────
 *
 *   1. `tools/list` shows an agent token only the tools it may call, so a Routine is not
 *      tempted by a tool it cannot use.
 *   2. `tools/call` refuses an approver tool for an agent token *before* running it — the
 *      refusal names the scope, so the model relays it instead of retrying.
 *   3. Each decision is a database function that checks the token's scope again.
 *
 * (1) is a courtesy; (2) and (3) are the enforcement, and `verify:bureau` drives both over
 * HTTP with real tokens.
 */

export type BureauSideEffects = Effects & {
  /** Embeddings for variation_check; absent → similarity reported as not computed. */
  embedderFor?(db: Db, channelId: string): Promise<Embedder | undefined>;
  /** Signed download URL for a stored bundle file; absent → the deployment's storage driver. */
  presign?(key: string, downloadAs: string): Promise<string>;
  /** The policy judge for needs_judge lints; absent → the brief stays flagged. */
  judgeFor?(db: Db, channelId: string): Promise<((lint: LintResult, text: string) => Promise<LintResult>) | undefined>;
};

export const NO_EFFECTS: BureauSideEffects = {
  async startEpisode() {
    throw new Error('This deployment cannot start episode runs (no Trigger.dev secret key).');
  },
  async completeWaitToken() {
    throw new Error('This deployment cannot wake a waiting run (no Trigger.dev secret key).');
  },
};

export interface BureauContext {
  db: Db;
  token: BureauToken;
  effects: BureauSideEffects;
  /**
   * The token's channel, loaded once per request by the server (`loadTokenChannel`). Every
   * resource and every bible-reading tool answers for THIS channel — a token for channel A
   * never reads channel B's cast. `bible: null` = the channel has no bible folder in this
   * build, and the bible-reading surfaces refuse by name.
   */
  channel: { id: string; name: string; bible: ChannelBible | null; refusal: string | null };
}

/** The token's channel row and bible, for `BureauContext.channel`. */
export async function loadTokenChannel(db: Db, channelId: string): Promise<BureauContext['channel']> {
  const { data } = await db.from('channels').select('name').eq('id', channelId).maybeSingle();
  try {
    return { id: channelId, name: data?.name ?? channelId, bible: await bibleForChannel(db, channelId), refusal: null };
  } catch (err) {
    return { id: channelId, name: data?.name ?? channelId, bible: null, refusal: err instanceof Error ? err.message : String(err) };
  }
}

type Scope = 'approver' | 'any';

interface BureauTool<A extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  args: A;
  run(ctx: BureauContext, args: z.infer<A>): Promise<unknown>;
}

const tool = <A extends z.ZodType>(t: BureauTool<A>) => t as unknown as BureauTool;

const Empty = z.object({}).strict();
const Range = z.object({ range: z.string().default('7d').describe('"1d", "7d", "28d" or "24h"') }).strict();

export const BUREAU_TOOLS: BureauTool[] = [
  tool({
    name: 'calendar_upcoming',
    title: 'Upcoming calendar slots',
    description: 'Slots from today forward: series, lead, topic, seasonal tag, and production status (open, needs_approval, approved, or the episode state). Includes the bank count.',
    scope: 'any',
    args: z.object({ days: z.number().int().min(0).max(120).default(14) }).strict(),
    run: (c, a) => calendarUpcoming(c.db, c.token.channelId, a.days),
  }),
  tool({
    name: 'briefs_create_batch',
    title: 'Submit draft briefs',
    description:
      'Submit up to 10 briefs. Each needs: series, lead_character, desk, premise, premise_type, structure_variant, ending_type and music_bed from the series file (kiln://series/{id}), hook_archetype, 3 punchlines, a beat_sheet, script_text as "Name: line" dialogue (≤150 words), a shot_list (≥50% overlay runtime, ≤8 s character beats, ≤1 money shot), exactly one fact with an https primary-source URL, 3 titles with distinct hook archetypes, and a pinned_comment. The server re-runs policy_lint and variation_check itself and flags failures; set flag=true with flag_reasons if you are submitting despite a failure. Each item succeeds or fails on its own.',
    scope: 'any',
    args: z.object({ briefs: z.array(z.unknown()).min(1).max(10) }).strict(),
    run: async (c, a) => {
      const embed = await c.effects.embedderFor?.(c.db, c.token.channelId);
      const judge = await c.effects.judgeFor?.(c.db, c.token.channelId);
      const results = await createBriefs(a.briefs, { db: c.db, token: c.token, embed, judge });
      const created = results.filter((r) => r.ok).length;
      if (created) await c.effects.notify?.(c.token.channelId, 'briefs_pending', `${created} brief${created === 1 ? '' : 's'} waiting for approval.`);
      const policyFlags = results.filter((r) => r.ok && r.flag_reasons.some((f) => f.startsWith('policy:')));
      if (policyFlags.length) {
        await c.effects.notify?.(c.token.channelId, 'policy_flag', `${policyFlags.length} brief(s) flagged by policy_lint: ${policyFlags.map((r) => (r.ok ? r.flag_reasons.filter((f) => f.startsWith('policy:')).join(',') : '')).join(' | ')}`);
      }
      return { ok: true, created, failed: results.length - created, results };
    },
  }),
  tool({
    name: 'brief_get',
    title: 'Read one brief',
    description: 'Everything on one brief, including the server-side policy and variation results.',
    scope: 'any',
    args: z.object({ id: z.uuid() }).strict(),
    run: async (c, a) => (await getBrief(c.db, c.token.channelId, a.id)) ?? { ok: false, error: 'No such brief on this channel.' },
  }),
  tool({
    name: 'briefs_pending',
    title: 'Briefs waiting for approval',
    description: 'Pending briefs, numbered and in slot order, with premise, punchlines A/B/C, ₹ estimate (null = unpriced) and flags.',
    scope: 'any',
    args: Empty,
    run: async (c) => {
      const briefs = await pendingBriefs(c.db, c.token.channelId);
      return { ok: true, count: briefs.length, briefs };
    },
  }),
  tool({
    name: 'brief_approve',
    title: 'Approve a brief',
    description:
      'Approve a pending brief with a punchline: "A", "B" or "C" picks a drafted one, any other text is used verbatim. Optional edits: premise, script_text, pinned_comment. Writes the authorship log and starts the episode run.',
    scope: 'approver',
    args: z.object({
      id: z.uuid(),
      punchline: z.string().min(1),
      edits: z.object({ premise: z.string().optional(), script_text: z.string().optional(), pinned_comment: z.string().optional() }).strict().optional(),
    }).strict(),
    run: (c, a) => approveBrief(c.db, c.token, c.effects, { brief_id: a.id, punchline: a.punchline, edits: a.edits }),
  }),
  tool({
    name: 'brief_reject',
    title: 'Reject a brief',
    description: 'Reject a pending brief with a reason. The slot reopens for a new brief.',
    scope: 'approver',
    args: z.object({ id: z.uuid(), reason: z.string().min(3) }).strict(),
    run: (c, a) => rejectBrief(c.db, c.token, { brief_id: a.id, reason: a.reason }),
  }),
  tool({
    name: 'variation_check',
    title: 'Check a brief for repetition',
    description: 'Differs from each of the last 14 episodes on ≥4 of 7 axes; script cosine vs the last 60 under the threshold; hook archetype ≤2/week; catchphrase ≤1/week. Pass a brief_id, or the axes of a draft. "refused" means similarity could not be computed (refused_reason says why) — it is not a pass, and a refused brief cannot be approved. For a pending brief with no stored embedding, this computes one and stores the new result on the brief.',
    scope: 'any',
    args: z.object({ brief_id: z.uuid().optional(), brief: VariationCandidateSchema.optional() }).strict(),
    run: async (c, a) => {
      const policy = await loadVariationPolicy(c.db, c.token.channelId);
      const history = await loadVariationHistory(c.db, c.token.channelId);
      if (a.brief_id) {
        const b = await getBrief(c.db, c.token.channelId, a.brief_id);
        if (!b) return { ok: false, error: 'No such brief on this channel.' };
        const { data: emb } = await c.db.from('briefs').select('script_embedding, flag_reasons').eq('id', a.brief_id).single();
        let vec = emb?.script_embedding ? JSON.parse(String(emb.script_embedding)) as number[] : null;
        let reason = 'no embedding was computed for this brief';
        // The re-check path for a brief refused because embeddings were unavailable when it
        // was written: compute now, store the vectors, then judge. Pending briefs only —
        // an approved brief's result is part of its record.
        if (!vec && b.status === 'pending') {
          const embed = await c.effects.embedderFor?.(c.db, c.token.channelId);
          const titles = Array.isArray(b.titles) ? (b.titles as { text?: string }[]).map((t) => String(t?.text ?? '')).join('\n') : '';
          const r = embed ? await embed([`${b.premise}\n${b.script_text}`, titles]) : { ok: false as const, detail: 'embeddings are not configured' };
          if (r.ok) {
            vec = r.vectors[0];
            await c.db
              .from('briefs')
              .update({ script_embedding: `[${r.vectors[0].join(',')}]`, title_embedding: `[${r.vectors[1].join(',')}]`, embedding_model: r.model })
              .eq('id', a.brief_id);
          } else {
            reason = r.detail;
          }
        }
        const { data: slot } = b.slot_id ? await c.db.from('slots').select('slot_date').eq('id', b.slot_id).maybeSingle() : { data: null };
        const sim = await similarityFor(c.db, c.token.channelId, vec, policy.similarity_window, a.brief_id, reason);
        const result = checkVariation({ ...b, id: b.id, lead: b.lead_character, on_date: slot?.slot_date ?? undefined }, history, policy, sim);
        if (b.status === 'pending') {
          const kept = (emb?.flag_reasons ?? []).filter((f: string) => !f.startsWith('variation:'));
          const now = [
            ...result.failing_axes.map((f) => `variation:axes_vs_${f.against_brief_id.slice(0, 8)}`),
            ...(result.hook_archetype.ok ? [] : ['variation:hook_archetype_weekly']),
            ...(result.catchphrase.ok ? [] : ['variation:catchphrase_weekly']),
            ...(result.similarity.ok === false ? ['variation:similarity'] : []),
            ...(result.refused_reason ? [`variation:refused — ${result.refused_reason}`] : []),
          ];
          await c.db.from('briefs').update({ variation: result as unknown as Json, flag_reasons: [...kept, ...now] }).eq('id', a.brief_id);
        }
        return result;
      }
      if (!a.brief) return { ok: false, error: 'Pass brief_id or brief.' };
      return checkVariation(a.brief, history, policy, { checked: false, reason: 'a draft has no stored embedding; submit it to compute similarity' });
    },
  }),
  tool({
    name: 'policy_lint',
    title: 'Lint a script against the content policy',
    description: 'Rejects finance/health advice, politics, real living people, franchises/brands, true crime, devotional framing, kid-coded styling; requires exactly one fact with a primary-source URL. "needs_judge" lists questions a pattern cannot decide — never treat it as a pass.',
    scope: 'any',
    args: LintInputSchema,
    run: async (c, a) => (c.channel.bible ? policyLint(a, c.channel.bible) : { ok: false, refused: true, summary: c.channel.refusal }),
  }),
  tool({
    name: 'episode_status',
    title: 'Episode status',
    description: 'Where an episode is: status and detail, shots and routes, generation jobs, QC, spend vs cap, and the first blocker if any.',
    scope: 'any',
    args: z.object({ id: z.uuid() }).strict(),
    run: async (c, a) => (await episodeStatus(c.db, c.token.channelId, a.id)) ?? { ok: false, error: 'No such episode on this channel.' },
  }),
  tool({
    name: 'shot_regenerate',
    title: 'Re-roll one shot',
    description: 'Queue a re-roll of one generated shot (by idx or shot id) with a note for the prompt. Limited to the channel’s re-roll max (default 2). The cut still needs approval afterwards.',
    scope: 'any',
    args: z.object({ episode: z.uuid(), shot: z.union([z.number().int().min(0), z.uuid()]), note: z.string().min(3) }).strict(),
    run: (c, a) => regenerateShot(c.db, c.token, { episode_id: a.episode, shot: a.shot, note: a.note }),
  }),
  tool({
    name: 'cut_approve',
    title: 'Approve a cut',
    description: 'Pass the finished cut of an episode awaiting review. Records a review (the publish gate reads it), writes the authorship log and lets the run produce the publish bundle.',
    scope: 'approver',
    args: z.object({ id: z.uuid(), note: z.string().optional() }).strict(),
    run: (c, a) => decideCut(c.db, c.token, c.effects, { episode_id: a.id, approve: true, note: a.note }),
  }),
  tool({
    name: 'cut_reject',
    title: 'Reject a cut',
    description: 'Send a cut back with a note. Shots marked for re-roll (shot_regenerate) are re-generated and the cut is re-assembled for review.',
    scope: 'approver',
    args: z.object({ id: z.uuid(), note: z.string().min(3) }).strict(),
    run: (c, a) => decideCut(c.db, c.token, c.effects, { episode_id: a.id, approve: false, note: a.note }),
  }),
  tool({
    name: 'publish_bundles',
    title: 'Publish bundles ready to schedule',
    description: 'Bundles for manual scheduling in YouTube Studio (the upload API is not audited): MP4 download URL (1 h), title, description, tags, madeForKids=false, containsSyntheticMedia, slot time.',
    scope: 'approver',
    args: Empty,
    run: async (c) => ({ ok: true, bundles: await readyBundles(c.db, c.token.channelId, { presign: c.effects.presign }) }),
  }),
  tool({
    name: 'mark_scheduled',
    title: 'Mark a bundle scheduled',
    description: 'Record that you scheduled a bundle in Studio, at the given ISO time. Pass video_url (the Studio link or Shorts URL) so metrics can be pulled. The review gate and the daily publish cap are enforced by the database.',
    scope: 'approver',
    args: z.object({ id: z.uuid(), at: z.iso.datetime({ offset: true }), video_url: z.string().min(11).optional() }).strict(),
    run: async (c, a) => {
      const videoId = a.video_url ? youtubeVideoId(a.video_url) : null;
      if (a.video_url && !videoId) return { ok: false, error: `"${a.video_url}" does not contain a YouTube video id.` };
      return markScheduled(c.db, c.token, { publication_id: a.id, at: a.at, videoId, videoUrl: a.video_url ?? null });
    },
  }),
  tool({
    name: 'metrics_summary',
    title: 'Metrics summary',
    description: 'Views, viewed-vs-swiped median (last 20), APV median, subs per 1k, character-name mentions, cost per Short and spend vs cap, with gate verdicts (VVSA 70%, APV 70%, 1 sub/1k, ₹150/Short). Unknown is not zero.',
    scope: 'any',
    args: Range,
    run: (c, a) => metricsSummary(c.db, c.token.channelId, a.range),
  }),
  tool({
    name: 'top_performers',
    title: 'Top performers',
    description: 'Live Shorts ranked by APV then views, with series, lead, hook archetype and structure variant.',
    scope: 'any',
    args: z.object({ n: z.number().int().min(1).max(50).default(5) }).strict(),
    run: (c, a) => topPerformers(c.db, c.token.channelId, a.n),
  }),
  tool({
    name: 'complaint_candidates',
    title: 'Complaint Box candidates',
    description: 'Public, unused comments ranked as Sunday Complaint Box material. Credit a viewer by handle only.',
    scope: 'any',
    args: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
    run: async (c, a) => ({ ok: true, candidates: await complaintCandidates(c.db, c.token.channelId, a.limit) }),
  }),
  tool({
    name: 'dub_queue',
    title: 'Dub queue',
    description: 'action "add": queue hi / es / pt-BR dubs for an approved episode. action "list": every dub job with status and cost (always labelled "rate unverified").',
    scope: 'any',
    args: z.object({
      action: z.enum(['add', 'list']),
      episode_id: z.uuid().optional(),
      languages: z.array(z.enum(DUB_LANGUAGES)).min(1).optional(),
    }).strict(),
    run: async (c, a) => {
      if (a.action === 'list') return listDubs(c.db, c.token.channelId);
      if (!a.episode_id) return { ok: false, error: 'add needs episode_id.' };
      return queueDubs(c.db, c.token, { episode_id: a.episode_id, languages: a.languages ?? [...DUB_LANGUAGES] });
    },
  }),
  tool({
    name: 'costs_ledger',
    title: 'Cost ledger',
    description: 'Ledger rows in a range, totals by component, unpriced and measured counts, and spend vs the daily and monthly caps.',
    scope: 'any',
    args: Range,
    run: (c, a) => costsLedger(c.db, c.token.channelId, a.range),
  }),
  tool({
    name: 'caps_set',
    title: 'Set caps',
    description: 'Change caps and thresholds: per_short_cap_inr, daily_cap_inr, daily_longform_cap_inr, monthly_cap_inr, monthly_cap_after_gate2_inr, daily_publish_cap, gate2_passed, variation_min_axes, similarity_max, hook_archetype_weekly_max, catchphrase_weekly_max, overlay_min_share, character_beat_max_s, money_shot_max, rerolls_max.',
    scope: 'approver',
    args: z.object({ changes: z.record(z.string(), z.union([z.number(), z.boolean()])) }).strict(),
    run: (c, a) => setCaps(c.db, c.token, a.changes),
  }),
  tool({
    name: 'kill_switch',
    title: 'Kill switch',
    description: 'on=true stops new generation claims and blocks publishing for the channel (reason required). on=false resumes.',
    scope: 'approver',
    args: z.object({ on: z.boolean(), reason: z.string().optional() }).strict(),
    run: (c, a) => setKillSwitch(c.db, c.token, c.effects, a),
  }),
];

function descriptor(t: BureauTool) {
  const schema = z.toJSONSchema(t.args, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: t.name,
    title: t.title,
    description: t.scope === 'approver' ? `[approver] ${t.description}` : t.description,
    inputSchema: schema,
  };
}

export function visibleTools(scope: BureauToken['scope']): BureauTool[] {
  return BUREAU_TOOLS.filter((t) => t.scope === 'any' || scope === 'approver');
}

export function bureauSurface(ctx: BureauContext): McpSurface {
  const series = ctx.channel.bible?.series ?? {};
  return {
    serverInfo: { name: 'kiln-bureau', title: `Kiln — ${ctx.channel.name}`, version: '0.3.0' },
    instructions:
      `Kiln control plane for "${ctx.channel.name}" (${ctx.token.scope} token). Every tool and resource answers for this channel only. Read kiln://bible/characters, ` +
      'kiln://series/{id} and kiln://policy/rubric before drafting. Agent tokens draft, read and queue; ' +
      'only the approver approves, rejects, schedules, changes caps or flips the kill switch. A result with ' +
      '`refused: true` names what would clear it — relay it, do not retry.',
    listTools: () => visibleTools(ctx.token.scope).map(descriptor),
    callTool(name, args) {
      const t = BUREAU_TOOLS.find((x) => x.name === name);
      if (!t) return undefined;
      return (async () => {
        if (t.scope === 'approver' && ctx.token.scope !== 'approver') {
          return {
            ok: false,
            refused: true,
            summary: `${name} needs the approver scope; this is an agent token.`,
            blockers: [{ code: 'scope_denied', detail: `token scope: ${ctx.token.scope}`, remedy: 'Ask Sahil to make this decision.' }],
          };
        }
        const parsed = t.args.safeParse(args);
        if (!parsed.success) {
          return { ok: false, error: 'invalid arguments', issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
        }
        return t.run(ctx, parsed.data);
      })();
    },
    resources: {
      list: () => [
        { uri: 'kiln://bible/characters', name: 'characters', title: 'Cast bible', mimeType: 'application/json' },
        { uri: 'kiln://policy/rubric', name: 'policy', title: 'Content policy rubric', mimeType: 'application/json' },
        { uri: 'kiln://calendar/next-14', name: 'calendar-next-14', title: 'Next 14 days of slots', mimeType: 'application/json' },
        ...Object.values(series).map((s) => ({ uri: `kiln://series/${s!.id}`, name: `series-${s!.id}`, title: s!.name, mimeType: 'application/json' })),
      ],
      templates: () => [
        { uriTemplate: 'kiln://series/{id}', name: 'series', title: 'Series template', description: `id: ${Object.keys(series).join(', ') || 'none — this channel has no bible'}`, mimeType: 'application/json' },
      ],
      async read(uri) {
        const json = (v: unknown) => ({ uri, mimeType: 'application/json', text: JSON.stringify(v, null, 2) });
        const cb = ctx.channel.bible;
        if ((uri === 'kiln://bible/characters' || uri === 'kiln://policy/rubric') && !cb) return json({ refused: true, summary: ctx.channel.refusal });
        if (uri === 'kiln://bible/characters') return json(cb!.bible);
        if (uri === 'kiln://policy/rubric') return json(cb!.policy);
        if (uri === 'kiln://calendar/next-14') return json(await calendarUpcoming(ctx.db, ctx.token.channelId, 14));
        const m = /^kiln:\/\/series\/([a-z_]+)$/.exec(uri);
        if (m && m[1] in series) return json(series[m[1] as keyof typeof series]);
        return null;
      },
    },
  };
}
