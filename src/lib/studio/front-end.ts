import 'server-only';

import type { Db } from '../db/server';
import type { BureauSideEffects } from '../bureau/mcp/surface';
import { formatOptions } from '../bureau/format-estimates';
import { MOTION_LEVELS, VISUAL_FORMATS, type MotionLevel, type VisualFormat } from '../bureau/formats';
import { mintBureauToken, type BureauToken } from '../bureau/tokens';

/**
 * The Studio lane's way into the real pipeline (decision recorded in 0008 §35).
 *
 * A Studio session used to materialise its own script and hand silent clips to the legacy
 * stage-4/5 lane, whose primary video integration has been dormant since 0015. That made a
 * conversation that could not end in a video. Now a session is a front end to the SAME path a
 * Bureau brief takes — brief → the approver's decision → `20-episode` → cut review → bundle —
 * so what comes out of the Studio is what comes out of the pipeline, with voice, captions,
 * graphics, format, motion, caps and the publish bundle.
 *
 * Three facts carry the link between a session and what it started, and none needs a column:
 *
 *   the brief    carries the tag `studio:<session id>` (and `format:` / `motion:` for the type
 *                asked for, which Approvals pre-selects);
 *   the episode  is the one `bureau_brief_approve` created for that brief;
 *   the cost     rows of the writer and judge carry `studio_session_id` beside the channel, so
 *                the session's cap sees the drafting it caused.
 *
 * The session drafts as an AGENT. It holds no approver token, so the one decision that spends
 * real money — approving a brief, which starts the run — stays the approver's, on Approvals.
 */

export const STUDIO_TAG_PREFIX = 'studio:';
export const studioTag = (sessionId: string) => `${STUDIO_TAG_PREFIX}${sessionId}`;

/** The tags a Studio draft carries: where it came from, and the type the session asked for. */
export function studioTags(base: readonly string[], sessionId: string, format: VisualFormat, motion: MotionLevel | null): string[] {
  const kept = base.filter((t) => t !== 'drafted:server' && !t.startsWith('format:') && !t.startsWith('motion:') && !t.startsWith(STUDIO_TAG_PREFIX));
  return [...kept, 'drafted:studio', studioTag(sessionId), `format:${format}`, ...(motion ? [`motion:${motion}`] : [])];
}

/**
 * The type a brief was asked for in, read back from its tags — what Approvals pre-selects.
 * Absent tags (every brief not drafted in the Studio) → nothing, and the series default stands.
 */
export function requestedFromTags(tags: unknown): { format: VisualFormat | null; motion: MotionLevel | null } {
  const list = Array.isArray(tags) ? tags.map(String) : [];
  const f = list.find((t) => t.startsWith('format:'))?.slice('format:'.length);
  const m = list.find((t) => t.startsWith('motion:'))?.slice('motion:'.length);
  return {
    format: (VISUAL_FORMATS as readonly string[]).includes(f ?? '') ? (f as VisualFormat) : null,
    motion: (MOTION_LEVELS as readonly string[]).includes(m ?? '') ? (m as MotionLevel) : null,
  };
}

const STUDIO_TOKEN_NAME = 'Studio (Opus session)';

/**
 * The agent token a Studio session drafts with, one per channel.
 *
 * Minted on first use with its plaintext discarded — it never leaves this server, exactly like
 * the web's "Control room (web)" approver token — so authorship_log and `briefs.created_by_token`
 * can say "drafted in the Studio" as precisely as they say "drafted by Routine C". Agent scope
 * on purpose: it can draft, read and queue a re-roll, and the database refuses it every decision.
 */
export async function studioAgentToken(db: Db, channelId: string): Promise<BureauToken> {
  const { data: existing } = await db
    .from('mcp_tokens')
    .select('id, name, scope, channel_id, profile_id, revoked_at')
    .eq('channel_id', channelId)
    .eq('name', STUDIO_TOKEN_NAME)
    .eq('scope', 'agent')
    .is('revoked_at', null)
    .maybeSingle();
  if (existing) return { id: existing.id, name: STUDIO_TOKEN_NAME, scope: 'agent', channelId, profileId: null };
  const minted = await mintBureauToken(db, { name: STUDIO_TOKEN_NAME, scope: 'agent', channelId, profileId: null });
  return { id: minted.id, name: STUDIO_TOKEN_NAME, scope: 'agent', channelId, profileId: null };
}

/** A brief this session drafted, on this session's channel — or null. Never another session's. */
export async function sessionBrief(db: Db, sessionId: string, channelId: string, briefId: string) {
  const { data, error } = await db
    .from('briefs')
    .select('id, channel_id, slot_id, series, status, premise, punchlines, script_text, shot_list, lead_character, hero_objects, estimate_inr, flagged, flag_reasons, policy, variation, tags, chosen_punchline, created_at')
    .eq('id', briefId)
    .eq('channel_id', channelId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || !(data.tags ?? []).includes(studioTag(sessionId))) return null;
  return data;
}

/** Every brief this session drafted, newest first, with the episode its approval created. */
export async function sessionWork(db: Db, sessionId: string) {
  const { data: briefs, error } = await db
    .from('briefs')
    .select('id, channel_id, slot_id, series, status, premise, estimate_inr, flagged, flag_reasons, tags, chosen_punchline, reject_reason, created_at')
    .contains('tags', [studioTag(sessionId)])
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  const ids = (briefs ?? []).map((b) => b.id);
  const { data: episodes, error: eErr } = ids.length
    ? await db
        .from('episodes')
        .select('id, brief_id, channel_id, status, status_detail, run_id, final_render_id, publication_id, estimate_inr, updated_at')
        .in('brief_id', ids)
    : { data: [], error: null };
  if (eErr) throw new Error(eErr.message);
  return { briefs: briefs ?? [], episodes: episodes ?? [] };
}

/** An episode started from one of this session's briefs, or null. */
export async function sessionEpisode(db: Db, sessionId: string, episodeId: string) {
  const { data: ep } = await db.from('episodes').select('id, brief_id, channel_id, status').eq('id', episodeId).maybeSingle();
  if (!ep?.brief_id) return null;
  const { data: brief } = await db.from('briefs').select('tags').eq('id', ep.brief_id).maybeSingle();
  return brief && (brief.tags ?? []).includes(studioTag(sessionId)) ? ep : null;
}

export type CapVerdict = 'within_cap' | 'over_cap' | 'unpriced' | 'no_cap_set';

/**
 * The per-type and per-motion price of one brief against the channel's per-Short cap.
 *
 * `formatOptions` is what Approvals shows — the same routing and estimator the planner uses,
 * motion levels already fitted to the cap — so the figure the session quotes is the figure
 * the approver sees and the run checks. Unpriced stays unpriced (`inr: null`, verdict
 * `unpriced`), and a channel with no cap says so: absent is never zero.
 */
export async function priceBrief(
  db: Db,
  channelId: string,
  brief: { series: string; shot_list: unknown; script_text: string; lead_character?: string | null; hero_objects?: unknown; tags?: unknown },
) {
  const [opts, { data: policy }] = await Promise.all([
    formatOptions(db, channelId, brief),
    db.from('channel_policy').select('per_short_cap_inr').eq('channel_id', channelId).maybeSingle(),
  ]);
  const cap = policy?.per_short_cap_inr === null || policy?.per_short_cap_inr === undefined ? null : Number(policy.per_short_cap_inr);
  const verdict = (inr: number | null): CapVerdict => (inr === null ? 'unpriced' : cap === null ? 'no_cap_set' : inr <= cap ? 'within_cap' : 'over_cap');
  const asked = requestedFromTags(brief.tags);
  return {
    cap_inr: cap,
    cap_basis: 'channel_policy.per_short_cap_inr — the run is refused (or its clips planned as pictures) above it',
    requested: { format: asked.format ?? opts.seriesDefault, motion: asked.format === 'engineered' ? asked.motion ?? opts.seriesMotion : null },
    series_default: { format: opts.seriesDefault, motion: opts.seriesMotion, pace: opts.seriesPace },
    formats: opts.options.map((o) => ({ format: o.format, label: o.label, inr: o.inr, verdict: verdict(o.inr), note: o.note, disabled: o.disabled })),
    motions: opts.motions.map((m) => ({ motion: m.motion, label: m.label, inr: m.inr, verdict: verdict(m.inr), clips: m.clips, clips_wanted: m.wanted, note: m.note })),
  };
}

/** Relative links into the control room; absolute when the deployment's origin is known. */
export function links(appUrl: string | undefined, paths: Record<string, string>): Record<string, string> {
  if (!appUrl) return paths;
  return Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, new URL(p, appUrl).toString()]));
}

/** What a tool needs to reach the model for a writer or judge call. */
export interface StudioLlm {
  apiKey: string;
  /** Injected by harnesses; production builds the SDK client. */
  client?: import('../llm/router').RouterDeps['client'];
}

export type StudioEffects = BureauSideEffects;
