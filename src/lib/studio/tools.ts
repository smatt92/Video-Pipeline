import 'server-only';

import { z } from 'zod';

import { createBriefs } from '../bureau/briefs';
import { draftBrief, writerSubject, type DraftSlot } from '../bureau/brief-generator';
import { getBible } from '../bureau/bible';
import { regenerateShot } from '../bureau/episodes';
import { FORMAT_INFO, MOTION_INFO, MotionLevelSchema, VisualFormatSchema, formatOf, motionOf, paceOf, type MotionLevel } from '../bureau/formats';
import { judgeLint } from '../bureau/brief-generator';
import { calendarUpcoming, episodeStatus } from '../bureau/read';
import { readUsdInrRate } from '../cost/fx';
import type { Db } from '../db/server';
import { RouterError } from '../llm/router';
import { listRecipes, RecipeInputSchema, saveRecipe } from '../prompts/library';
import { SKELETONS, skeletonOutline } from '../prompts/skeletons';
import { SHOT_KIND_KEYS } from '../shots/kinds';
import { TrendsRecentArgs, trendsRecent } from '../trends/recent';
import {
  links,
  priceBrief,
  sessionBrief,
  sessionEpisode,
  sessionWork,
  studioAgentToken,
  studioTags,
  type StudioEffects,
  type StudioLlm,
} from './front-end';

/**
 * The Studio tools, as implementations.
 *
 * This module is the only place they exist. `src/app/api/mcp/route.ts` exposes them over the
 * MCP protocol so Opus reaches them through the `mcp_servers` connector, and
 * `scripts/verify-studio.mjs` drives the same objects over a local bridge. Both paths run
 * *these* functions; neither reimplements one.
 *
 * ── A session is a front end to the pipeline, not a second one ──────────────
 *
 * Until 08-Oct a session could reach `generate_shot`, which materialised its own script and
 * queued the legacy stage-4/5 lane — whose primary video integration has been dormant since
 * decision 0015 — and `stitch_rough_cut`, which concatenated silent clips. On a correctly
 * configured workspace that refused; even when it worked it made a rough cut with no voice,
 * captions, graphics, format, motion, caps or publish bundle. Both are gone, along with the
 * two readers of that script (`check_generation`, `list_session_shots`). Nothing here imports
 * the stage-4/5 tasks; `verify:studio` asserts the tool list and the module graph.
 *
 * What a session does now is the Bureau path: read the channel and its trends, draft a brief
 * in a chosen video type (the 3D explainer through its own writer), price it per type and per
 * motion level against the channel's per-Short cap, hand it to the approver, then follow the
 * episode the approval starts — re-roll a shot, open the cut, open the bundle. The recipe
 * tools stay: exploring and saving a proven recipe is still worth doing here.
 *
 * ── A refusal is a result, not an error ──────────────────────────────────────
 *
 * `{ refused: true, blockers: [...] }` with every closed gate and what clears it. The model
 * relays it; an exception would read as "the tool is broken", which it is not.
 *
 * ── Every tool is session-scoped ─────────────────────────────────────────────
 *
 * The session id comes from the bearer token, never from an argument, and the channel from
 * the session row. A brief or episode id from another session is refused: a model that can
 * name another session's work could re-roll its shots.
 */

export interface ToolContext {
  db: Db;
  sessionId: string;
  /** Set from the session row. Tools that would spend money check it before they do. */
  spendCapInr: number | null;
  /** The channel the session was opened on (the active channel at the time). Null on a pre-08-Oct session. */
  channelId: string | null;
  /** Start a run, wake a gate, notify, embed — production's or a harness's recording fakes. */
  effects: StudioEffects;
  /** The model for writer and judge calls; absent → drafting refuses by name. */
  llm?: () => Promise<StudioLlm | null>;
  /** The deployment's public origin, for links the person can tap. */
  appUrl?: string;
}

/** What a tool hands back. JSON, because it is going into a model's context as text. */
export type ToolResult =
  | { ok: true; [k: string]: unknown }
  | {
      ok: false;
      refused: true;
      /** One line for the model to relay. */
      summary: string;
      /** Every gate that is closed, not just the first one hit. */
      blockers: { code: string; detail: string; remedy: string }[];
    };

export interface StudioTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** JSON Schema, served verbatim by `tools/list` and by the Anthropic tool declaration. */
  readonly inputSchema: Record<string, unknown>;
  readonly args: z.ZodType;
  run(ctx: ToolContext, args: unknown): Promise<ToolResult>;
}

type Blocker = { code: string; detail: string; remedy: string };

function refuse(summary: string, blockers: Blocker[]): ToolResult {
  return { ok: false, refused: true, summary, blockers };
}

/** A tool's input schema, from its Zod args — one source, so the two cannot disagree. */
function schemaOf(args: z.ZodType): Record<string, unknown> {
  const schema = z.toJSONSchema(args, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Parse, or refuse naming every bad field — never `as`. */
function parseArgs<A extends z.ZodType>(args: A, raw: unknown): { ok: true; data: z.infer<A> } | { ok: false; result: ToolResult } {
  const parsed = args.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    result: refuse('The arguments were not well-formed.', [
      { code: 'invalid_arguments', detail: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '), remedy: 'Fix the named fields and call again.' },
    ]),
  };
}

const NO_CHANNEL: Blocker = {
  code: 'no_channel',
  detail: 'This session was opened before sessions carried a channel, so it has none to draft for.',
  remedy: 'Start a new session from Studio — it opens on the channel selected in the sidebar.',
};

const LINKS = {
  approvals: (briefId: string) => `/bureau/approvals?id=${briefId}`,
  cuts: (episodeId: string) => `/bureau/cuts?id=${episodeId}`,
  ready: '/bureau/ready',
  board: '/bureau/board',
  session: (sessionId: string) => `/studio/${sessionId}`,
};

const APPROVER_ONLY =
  'Approving starts the paid run, so it is the approver’s decision and this session cannot make it. ' +
  'Hand it over: the approver opens the link, picks a punchline and the type, and approves.';

// ═════════════════════════════════════════════════════════════════════════════
// channel_overview
// ═════════════════════════════════════════════════════════════════════════════

const OverviewArgs = z.object({ days: z.number().int().min(1).max(60).default(14).describe('How far ahead to list calendar slots.') }).strict();

const channelOverview: StudioTool = {
  name: 'channel_overview',
  title: 'The channel this session makes videos for',
  description:
    'Read first. The active channel: its series (with each one’s default video type, motion and pace), ' +
    'its cast and narrator, the video types and motion levels available, the per-Short cost cap, ' +
    'open calendar slots in the next `days`, and the briefs this session has already drafted.',
  inputSchema: schemaOf(OverviewArgs),
  args: OverviewArgs,
  async run(ctx, raw) {
    const a = parseArgs(OverviewArgs, raw);
    if (!a.ok) return a.result;
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const { db, channelId } = ctx;
    const [{ data: channel }, cbOrError, { data: policy }, calendar, work] = await Promise.all([
      db.from('channels').select('id, name, slug, niche').eq('id', channelId).maybeSingle(),
      getBible(db, channelId).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
      db.from('channel_policy').select('per_short_cap_inr, daily_cap_inr, kill_switch').eq('channel_id', channelId).maybeSingle(),
      calendarUpcoming(db, channelId, a.data.days),
      sessionWork(db, ctx.sessionId),
    ]);
    if (cbOrError instanceof Error) {
      return refuse('This channel has no bible, so nothing can be drafted for it.', [
        { code: 'no_bible', detail: cbOrError.message, remedy: 'Library → Bible: import or write the channel’s bible first.' },
      ]);
    }
    const cb = cbOrError;
    return {
      ok: true,
      channel: { id: channelId, name: channel?.name ?? null, slug: channel?.slug ?? null, niche: channel?.niche ?? null },
      caps: {
        per_short_cap_inr: policy?.per_short_cap_inr === null || policy?.per_short_cap_inr === undefined ? null : Number(policy.per_short_cap_inr),
        daily_cap_inr: policy?.daily_cap_inr === null || policy?.daily_cap_inr === undefined ? null : Number(policy.daily_cap_inr),
        kill_switch: policy?.kill_switch ?? null,
        note: 'null = no cap set, not a zero cap.',
      },
      series: Object.values(cb.series)
        .filter((s): s is NonNullable<typeof s> => !!s && s.id !== 'long_form')
        .map((s) => ({
          id: s.id,
          name: s.name,
          template: s.template,
          lead: s.lead,
          default_type: formatOf({ seriesFormat: s.visual_format }).format,
          default_motion: motionOf({ seriesMotion: s.motion }).motion,
          default_pace: paceOf({ seriesPace: s.voice_pace }).pace,
        })),
      cast: cb.bible.characters.map((c) => ({ id: c.id, name: c.name, on_screen: (c as { on_screen?: boolean }).on_screen ?? true })),
      video_types: Object.entries(FORMAT_INFO).map(([id, i]) => ({ id, ...i })),
      motion_levels: Object.entries(MOTION_INFO).map(([id, i]) => ({ id, ...i, applies_to: 'engineered (3D explainer) only' })),
      open_slots: calendar.slots
        .filter((s) => !s.brief_id && s.series !== 'sequel' && s.series !== 'long_form')
        .map((s) => ({ id: s.id, date: s.slot_date, series: s.series, topic: s.topic, hook: s.hook, lead: s.lead })),
      this_session: {
        briefs: work.briefs.map((b) => ({ id: b.id, status: b.status, premise: b.premise, series: b.series })),
        episodes: work.episodes.map((e) => ({ id: e.id, brief_id: e.brief_id, status: e.status })),
      },
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// trends_recent
// ═════════════════════════════════════════════════════════════════════════════

const trendsTool: StudioTool = {
  name: 'trends_recent',
  title: 'Recent trend signals',
  description:
    'Top stage-1 trend signals for the session’s channel over the last `days` (1–30), highest velocity ' +
    'first: source, term, velocity (a proxy), volume, relevance to the niche (null = not scored, never 0) and a link.',
  inputSchema: schemaOf(TrendsRecentArgs),
  args: TrendsRecentArgs,
  async run(ctx, raw) {
    const a = parseArgs(TrendsRecentArgs, raw);
    if (!a.ok) return a.result;
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const r = await trendsRecent(ctx.db, ctx.channelId, a.data);
    if (!r.ok) return refuse(r.summary, [{ code: 'trends_refused', detail: r.summary, remedy: 'Ask for this session’s own channel.' }]);
    return { ...r, ok: true };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// draft_brief
// ═════════════════════════════════════════════════════════════════════════════

const DraftArgs = z
  .object({
    video_type: VisualFormatSchema.describe('illustrated | diagram | cinematic | characters | engineered (the 3D explainer).'),
    motion: MotionLevelSchema.optional().describe('engineered only: "key" = clips on the action beats, "full" = clips on most beats. Default: the series’.'),
    slot_id: z.string().min(1).max(40).optional().describe('A calendar slot from channel_overview.open_slots. Its series, topic and hook are used.'),
    series: z.string().min(1).max(40).optional().describe('Unslotted only: a series id from channel_overview.series.'),
    topic: z.string().min(3).max(200).optional().describe('Unslotted only: what the video is about, in one line.'),
    hook: z.string().min(3).max(200).optional().describe('Unslotted only, optional: the opening line or angle.'),
  })
  .strict();

const draftBriefTool: StudioTool = {
  name: 'draft_brief',
  title: 'Draft a brief for the approver',
  description:
    'Draft one brief for the session’s channel in a video type (and, for the 3D explainer, a motion level), ' +
    'either for an open calendar slot (slot_id) or unslotted (series + topic). The channel’s own writer drafts ' +
    'it; the server lints it against the content policy, checks it for repetition and prices it. The brief is ' +
    'created PENDING. Returns its id, flags, the price of every type and motion level against the per-Short ' +
    'cap, and the Approvals link. This spends money (one writer call, ~₹2–7). It does NOT start a video: ' +
    'the approver approves on Approvals, and that starts the run.',
  inputSchema: schemaOf(DraftArgs),
  args: DraftArgs,
  async run(ctx, raw) {
    const a = parseArgs(DraftArgs, raw);
    if (!a.ok) return a.result;
    const args = a.data;
    const { db, sessionId } = ctx;
    const blockers: Blocker[] = [];
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const channelId = ctx.channelId;

    // ── Which slot ─────────────────────────────────────────────────────────
    let slot: DraftSlot | null = null;
    if (args.slot_id) {
      const { data } = await db
        .from('slots')
        .select('id, slot_date, series, topic, hook, lead, seasonal_tag, episode')
        .eq('id', args.slot_id)
        .eq('channel_id', channelId)
        .maybeSingle();
      if (!data) blockers.push({ code: 'unknown_slot', detail: `No slot ${args.slot_id} on this channel.`, remedy: 'Pick one of channel_overview.open_slots, or draft unslotted with series + topic.' });
      else slot = data;
    } else if (args.series && args.topic) {
      slot = { id: null, slot_date: null, series: args.series, topic: args.topic, hook: args.hook ?? null, lead: null, seasonal_tag: null, episode: null };
    } else {
      blockers.push({ code: 'no_topic', detail: 'Neither a slot_id nor a series and topic was given.', remedy: 'Pass slot_id, or series and topic.' });
    }
    if (args.motion && args.video_type !== 'engineered') {
      blockers.push({ code: 'motion_without_engineered', detail: `Motion levels exist only for the 3D explainer; "${args.video_type}" has none.`, remedy: 'Drop motion, or choose video_type "engineered".' });
    }

    // ── Can it be paid for, and is the session under its cap ─────────────
    const fx = await readUsdInrRate(db);
    if (!fx.ok) blockers.push({ code: 'no_fx_rate', detail: fx.reason, remedy: fx.remedy });
    const llm = ctx.llm ? await ctx.llm() : null;
    if (!llm) blockers.push({ code: 'no_llm_credential', detail: 'No verified model credential is configured for drafting.', remedy: 'Settings → Integrations → the LLM integration, then Test connection.' });
    const { data: session } = await db.from('studio_sessions').select('cost_inr, spend_cap_inr').eq('id', sessionId).maybeSingle();
    const spent = Number(session?.cost_inr ?? 0);
    const cap = session?.spend_cap_inr === null || session?.spend_cap_inr === undefined ? null : Number(session.spend_cap_inr);
    if (cap === null || spent >= cap) {
      blockers.push({ code: 'session_cap', detail: cap === null ? 'This session has no spend cap.' : `This session has spent ₹${spent.toFixed(2)} of its ₹${cap.toFixed(2)} cap.`, remedy: 'Start a new session with a cap that leaves room for a draft.' });
    }
    if (blockers.length || !slot || !fx.ok || !llm) {
      return refuse(`Cannot draft this brief yet — ${blockers.length} thing${blockers.length === 1 ? '' : 's'} must be true first.`, blockers);
    }

    // ── Draft: the channel's writer, costed to the channel AND this session ──
    const deps = { db, apiKey: llm.apiKey, client: llm.client, usdInrRate: fx.rate, channelId, studioSessionId: sessionId };
    let drafted;
    try {
      drafted = await draftBrief(db, { slot, format: args.video_type }, deps);
    } catch (err) {
      // The router has already written the billed tokens (rule 5); this reports the outcome.
      const code = err instanceof RouterError ? `writer_${err.code}` : 'writer_failed';
      return refuse('The writer did not produce a usable draft. Its cost is recorded.', [
        { code, detail: err instanceof Error ? err.message : String(err), remedy: 'Try again once, perhaps with a narrower topic. A second failure is worth reading, not retrying.' },
      ]);
    }
    if (!drafted.ok) {
      return refuse('The draft did not pass the channel’s brief rules, so no brief was created. Its cost is recorded.', [
        { code: 'draft_rejected', detail: drafted.error, remedy: 'Draft again with a different angle or topic; the rules named are the channel’s own.' },
      ]);
    }

    const cb = await getBible(db, channelId);
    const seriesMotion = motionOf({ seriesMotion: cb.seriesFor(drafted.brief.series).motion }).motion;
    const motion: MotionLevel | null = args.video_type === 'engineered' ? args.motion ?? seriesMotion : null;
    const brief = { ...drafted.brief, tags: studioTags(drafted.brief.tags, sessionId, args.video_type, motion) };

    // ── Create it pending, as this channel's Studio agent ─────────────────
    const token = await studioAgentToken(db, channelId);
    const embed = await ctx.effects.embedderFor?.(db, channelId);
    const judge = (lint: Parameters<typeof judgeLint>[0], text: string) =>
      judgeLint(lint, text, { db, apiKey: llm.apiKey, client: llm.client, usdInrRate: fx.rate, subject: writerSubject(deps, `judge:${sessionId}:${Date.now()}`, '20-policy-judge') });
    const [created] = await createBriefs([brief], { db, token, embed, judge });
    if (!created?.ok) {
      return refuse('The brief was drafted and then refused when it was created.', [
        { code: 'create_refused', detail: created?.ok === false ? created.error : 'no result', remedy: 'A slot that already has a live brief cannot take another — pick an open slot or draft unslotted.' },
      ]);
    }
    await ctx.effects.notify?.(channelId, 'briefs_pending', `A brief from a Studio session is waiting for approval: ${brief.premise.slice(0, 120)}`);

    const pricing = await priceBrief(db, channelId, { ...brief, shot_list: brief.shot_list, hero_objects: brief.hero_objects });
    return {
      ok: true,
      brief_id: created.brief_id,
      status: 'pending',
      series: brief.series,
      slot_id: brief.slot_id ?? null,
      premise: brief.premise,
      punchlines: brief.punchlines,
      titles: brief.titles.map((t) => t.text),
      script_words: brief.script_text.split(/\s+/).filter(Boolean).length,
      shots: brief.shot_list.length,
      flagged: created.flagged,
      flag_reasons: created.flag_reasons,
      policy: created.policy,
      variation: created.variation,
      pricing,
      approval: { links: links(ctx.appUrl, { approvals: LINKS.approvals(created.brief_id) }), who: 'the approver', why: APPROVER_ONLY },
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// brief_get / price_brief
// ═════════════════════════════════════════════════════════════════════════════

const BriefIdArgs = z.object({ brief_id: z.uuid() }).strict();

const NOT_THIS_SESSION = (what: string, id: string): Blocker => ({
  code: 'not_this_session',
  detail: `${what} ${id} was not started by this session (or is on another channel).`,
  remedy: 'Use the ids from channel_overview.this_session; another session’s work is opened from that session.',
});

const briefGet: StudioTool = {
  name: 'brief_get',
  title: 'Read a brief this session drafted',
  description: 'Everything on one of this session’s briefs: status, premise, punchlines, script, shot list, flags, the policy and variation results, and the episode its approval started, if any.',
  inputSchema: schemaOf(BriefIdArgs),
  args: BriefIdArgs,
  async run(ctx, raw) {
    const a = parseArgs(BriefIdArgs, raw);
    if (!a.ok) return a.result;
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const b = await sessionBrief(ctx.db, ctx.sessionId, ctx.channelId, a.data.brief_id);
    if (!b) return refuse('That brief is not this session’s.', [NOT_THIS_SESSION('Brief', a.data.brief_id)]);
    const { data: ep } = await ctx.db.from('episodes').select('id, status').eq('brief_id', b.id).maybeSingle();
    return {
      ok: true,
      brief: b,
      episode: ep ?? null,
      links: links(ctx.appUrl, b.status === 'pending' ? { approvals: LINKS.approvals(b.id) } : ep ? { cuts: LINKS.cuts(ep.id), ready: LINKS.ready } : {}),
    };
  },
};

const priceBriefTool: StudioTool = {
  name: 'price_brief',
  title: 'Price a brief per type and motion',
  description:
    'Price one of this session’s briefs in every video type, and the 3D explainer at each motion level, against the ' +
    'channel’s per-Short cap — the same figures Approvals shows. verdict is within_cap, over_cap, unpriced (a rate or ' +
    'recipe is missing; never read as ₹0) or no_cap_set.',
  inputSchema: schemaOf(BriefIdArgs),
  args: BriefIdArgs,
  async run(ctx, raw) {
    const a = parseArgs(BriefIdArgs, raw);
    if (!a.ok) return a.result;
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const b = await sessionBrief(ctx.db, ctx.sessionId, ctx.channelId, a.data.brief_id);
    if (!b) return refuse('That brief is not this session’s.', [NOT_THIS_SESSION('Brief', a.data.brief_id)]);
    return { ok: true, brief_id: b.id, pricing: await priceBrief(ctx.db, ctx.channelId, b) };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// episode_status / shot_regenerate / episode_links
// ═════════════════════════════════════════════════════════════════════════════

const EpisodeArgs = z.object({ episode_id: z.uuid().optional().describe('Omit for every episode this session started.') }).strict();

const episodeStatusTool: StudioTool = {
  name: 'episode_status',
  title: 'Follow an episode',
  description:
    'Where an episode started from this session’s brief is: status and the worker’s progress line, shots and their ' +
    'routes, generation jobs, QC, spend against the cap, and the first blocker. With no episode_id, every one this session started.',
  inputSchema: schemaOf(EpisodeArgs),
  args: EpisodeArgs,
  async run(ctx, raw) {
    const a = parseArgs(EpisodeArgs, raw);
    if (!a.ok) return a.result;
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const channelId = ctx.channelId;
    let ids: string[];
    if (a.data.episode_id) {
      const ep = await sessionEpisode(ctx.db, ctx.sessionId, a.data.episode_id);
      if (!ep) return refuse('That episode is not this session’s.', [NOT_THIS_SESSION('Episode', a.data.episode_id)]);
      ids = [ep.id];
    } else {
      const work = await sessionWork(ctx.db, ctx.sessionId);
      ids = work.episodes.map((e) => e.id).slice(0, 5);
      if (!ids.length) {
        const pending = work.briefs.filter((b) => b.status === 'pending');
        return {
          ok: true,
          episodes: [],
          note: pending.length
            ? `No episode yet: ${pending.length} brief${pending.length === 1 ? ' is' : 's are'} waiting for the approver on Approvals. ${APPROVER_ONLY}`
            : 'This session has not drafted a brief yet, so nothing has been started.',
          links: links(ctx.appUrl, pending[0] ? { approvals: LINKS.approvals(pending[0].id) } : {}),
        };
      }
    }
    const episodes = await Promise.all(ids.map((id) => episodeStatus(ctx.db, channelId, id)));
    return {
      ok: true,
      episodes: episodes.filter(Boolean).map((e) => ({ ...e!, links: links(ctx.appUrl, { cuts: LINKS.cuts(e!.id), ready: LINKS.ready, board: LINKS.board }) })),
    };
  },
};

const RegenArgs = z
  .object({
    episode_id: z.uuid(),
    shot: z.union([z.number().int().min(0), z.uuid()]).describe('The shot’s idx (0-based) or id.'),
    note: z.string().min(3).max(400).describe('What to change, for the prompt.'),
  })
  .strict();

const shotRegenerateTool: StudioTool = {
  name: 'shot_regenerate',
  title: 'Re-roll one shot',
  description:
    'Queue a re-roll of one generated clip of an episode this session started, with a note for the prompt — limited to the ' +
    'channel’s re-roll max. A picture (still) shot is redrawn instead, which is the approver’s call on Cuts; this refuses it ' +
    'and says so. The cut still needs the approver afterwards.',
  inputSchema: schemaOf(RegenArgs),
  args: RegenArgs,
  async run(ctx, raw) {
    const a = parseArgs(RegenArgs, raw);
    if (!a.ok) return a.result;
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const ep = await sessionEpisode(ctx.db, ctx.sessionId, a.data.episode_id);
    if (!ep) return refuse('That episode is not this session’s.', [NOT_THIS_SESSION('Episode', a.data.episode_id)]);
    const token = await studioAgentToken(ctx.db, ctx.channelId);
    try {
      const r = await regenerateShot(ctx.db, token, { episode_id: ep.id, shot: a.data.shot, note: a.data.note }, ctx.effects);
      return { ...r, ok: true, links: links(ctx.appUrl, { cuts: LINKS.cuts(ep.id) }) };
    } catch (err) {
      return refuse('The re-roll was not queued.', [
        { code: 'reroll_refused', detail: err instanceof Error ? err.message : String(err), remedy: 'Read the reason: a picture is redrawn on Cuts by the approver; a capped shot has used its re-rolls.' },
      ]);
    }
  },
};

const LinksArgs = z.object({ episode_id: z.uuid() }).strict();

const episodeLinksTool: StudioTool = {
  name: 'open_cut_and_bundle',
  title: 'Open the cut and the bundle',
  description:
    'Links to the cut (Cuts — where the approver approves or sends it back) and to the publish bundle (Ready), with the bundle’s ' +
    'title, status and slot when one exists. Download URLs are signed on Ready for the approver, not here.',
  inputSchema: schemaOf(LinksArgs),
  args: LinksArgs,
  async run(ctx, raw) {
    const a = parseArgs(LinksArgs, raw);
    if (!a.ok) return a.result;
    if (!ctx.channelId) return refuse('This session has no channel.', [NO_CHANNEL]);
    const ep = await sessionEpisode(ctx.db, ctx.sessionId, a.data.episode_id);
    if (!ep) return refuse('That episode is not this session’s.', [NOT_THIS_SESSION('Episode', a.data.episode_id)]);
    const { data: bundles } = await ctx.db
      .from('v_ready_bundles')
      .select('publication_id, platform, status, title, scheduled_for, slot_date')
      .eq('episode_id', ep.id);
    const cutReady = ['awaiting_cut', 'cut_rejected', 'cut_approved', 'bundled', 'scheduled', 'live'].includes(ep.status);
    return {
      ok: true,
      episode_id: ep.id,
      status: ep.status,
      cut: cutReady ? 'assembled' : 'not assembled yet',
      bundle: (bundles ?? []).length ? bundles : null,
      bundle_note: (bundles ?? []).length ? null : 'No bundle yet: it is built after the approver passes the cut.',
      links: links(ctx.appUrl, { cuts: LINKS.cuts(ep.id), ready: LINKS.ready }),
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// list_prompt_recipes
// ═════════════════════════════════════════════════════════════════════════════

const ListRecipesArgs = z.object({
  tag: z.enum(SHOT_KIND_KEYS as [string, ...string[]]).optional(),
  include_retired: z.boolean().default(false),
});

const listPromptRecipes: StudioTool = {
  name: 'list_prompt_recipes',
  title: 'List prompt recipes',
  description:
    'List the shot recipes in the prompt library. A recipe is a proven template plus the ' +
    'exact vendor parameters it was proven with. Production never improvises: an episode\u2019s ' +
    'clip routes (the cinematic type, the 3D explainer\u2019s motion) read only active recipes ' +
    'from this library, and an unpriced or missing one is why price_brief says "unpriced". ' +
    'For exploring; save_prompt_recipe adds one.',
  inputSchema: {
    type: 'object',
    properties: {
      tag: {
        type: 'string',
        enum: SHOT_KIND_KEYS,
        description: 'Only recipes serving this shot kind.',
      },
      include_retired: {
        type: 'boolean',
        description: 'Include recipes that have been retired. Default false.',
      },
    },
    additionalProperties: false,
  },
  args: ListRecipesArgs,

  async run(ctx, raw) {
    const args = ListRecipesArgs.parse(raw);
    const all = await listRecipes(ctx.db);

    const recipes = all
      .filter((r) => (args.include_retired ? true : r.isActive))
      .filter((r) => (args.tag ? r.tags.includes(args.tag) : true));

    return {
      ok: true,
      count: recipes.length,
      // Said explicitly rather than left to be inferred from a zero. An empty list is a
      // state with a cause and a next action, and the model is better at relaying that
      // than at deducing it.
      note:
        recipes.length === 0
          ? 'The library is empty, so no clip route can be priced or generated (pictures and ' +
            'diagrams still can). A ' +
            'recipe is only worth saving once its parameters have actually produced a clip ' +
            'you watched — explore against the vendor\u2019s own hosted MCP server in Claude ' +
            'Code, then save the exact params here with save_prompt_recipe.'
          : undefined,

      // Returned only when there is nothing to list, which is the one moment an author
      // needs a starting shape rather than a warning. Skeletons are NOT recipes: no params,
      // no sample output, never run against our driver — `unverified` says so on every one,
      // and the model is told the route to the library still runs through a watched clip.
      //
      // This is also what reads `prompts/skeletons.ts`. A shape catalogue with no caller
      // would be the same failure as a view with no reader, and harder to notice, because
      // its existence reads as coverage.
      skeletons:
        recipes.length === 0
          ? SKELETONS.map((sk) => ({
              key: sk.key,
              label: sk.label,
              shot_kinds: sk.shotKinds,
              slots: sk.slots.map((slot) => ({ name: slot.name, asks: slot.asks })),
              outline: skeletonOutline(sk),
              provenance: sk.provenance,
              unverified: sk.unverified,
            }))
          : undefined,
      recipes: recipes.map((r) => ({
        id: r.id,
        name: r.name,
        driver: r.driver,
        model: r.model,
        template: r.template,
        params: r.params,
        tags: r.tags,
        version: r.version,
        accepts_character_ref: r.acceptsCharacterRef,
        times_compiled: r.timesCompiled,
        times_shipped: r.timesShipped,
        discovered_in: r.discoveredIn,
      })),
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// save_prompt_recipe
// ═════════════════════════════════════════════════════════════════════════════

const SaveRecipeArgs = z.object({
  name: z.string(),
  driver: z.string(),
  model: z.string(),
  template: z.string(),
  params: z.string(),
  tags: z.array(z.string()).min(1),
  sample_output_url: z.string().optional(),
  accepts_character_ref: z.boolean().default(false),
});

const savePromptRecipe: StudioTool = {
  name: 'save_prompt_recipe',
  title: 'Save a prompt recipe',
  description:
    'Persist a shot recipe to the library. Only save a recipe whose parameters produced a ' +
    'clip that was actually watched and judged good — the library is the set of things ' +
    'that are not guesses. `params` is the exact vendor payload as a JSON object string, ' +
    'verbatim, not a summary and not defaults. Every {{placeholder}} in the template must ' +
    'be fillable from what a shot carries: description, intent, duration.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short identifying name, letters and digits.' },
      driver: { type: 'string', description: 'Vendor slug the recipe belongs to.' },
      model: { type: 'string', description: 'Vendor model the params were proven against.' },
      template: {
        type: 'string',
        description: 'Prompt template. Placeholders: {{description}}, {{intent}}, {{duration}}.',
      },
      params: {
        type: 'string',
        description: 'The exact vendor parameters as a JSON object, serialised to a string.',
      },
      tags: {
        type: 'array',
        items: { type: 'string', enum: SHOT_KIND_KEYS },
        minItems: 1,
        description: 'Which shot kinds this recipe serves. A recipe with none matches nothing.',
      },
      sample_output_url: {
        type: 'string',
        description: 'URL of the clip this recipe was proven with.',
      },
      accepts_character_ref: {
        type: 'boolean',
        description:
          'Only true if you watched a clip from these params and the character reference ' +
          'came through as the right person.',
      },
    },
    required: ['name', 'driver', 'model', 'template', 'params', 'tags'],
    additionalProperties: false,
  },
  args: SaveRecipeArgs,

  async run(ctx, raw) {
    const args = SaveRecipeArgs.parse(raw);

    // Re-validated through the library's own schema rather than trusted from here. The
    // model is an external caller like any other, and `RecipeInputSchema` is the boundary.
    const parsed = RecipeInputSchema.safeParse({
      name: args.name,
      driver: args.driver,
      model: args.model,
      template: args.template,
      params: args.params,
      tags: args.tags,
      sampleOutputUrl: args.sample_output_url ?? '',
      discoveredIn: 'claude-code-mcp',
      acceptsCharacterRef: args.accepts_character_ref,
    });

    if (!parsed.success) {
      return refuse('That recipe is not well-formed and was not saved.', [
        {
          code: 'schema',
          detail: parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
          remedy: 'Fix the named fields and call save_prompt_recipe again.',
        },
      ]);
    }

    const result = await saveRecipe(ctx.db, parsed.data);

    if (!result.ok) {
      return refuse('That recipe was rejected by the library.', [
        {
          code: 'invalid_recipe',
          detail: result.problems.join('; '),
          remedy:
            'A recipe that cannot reproduce its own sample is worse than no recipe. Fix ' +
            'the problems listed and save again.',
        },
      ]);
    }

    return {
      ok: true,
      id: result.id,
      name: result.name,
      version: result.version,
      note: `Saved as "${result.name}" v${result.version}, discovered_in='claude-code-mcp'.`,
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════

export const STUDIO_TOOLS: readonly StudioTool[] = [
  channelOverview,
  trendsTool,
  draftBriefTool,
  briefGet,
  priceBriefTool,
  episodeStatusTool,
  shotRegenerateTool,
  episodeLinksTool,
  listPromptRecipes,
  savePromptRecipe,
];

export function toolByName(name: string): StudioTool | undefined {
  return STUDIO_TOOLS.find((t) => t.name === name);
}

/** The `tools/list` payload, and the shape the Anthropic tool declaration reuses. */
export function toolDescriptors() {
  return STUDIO_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
