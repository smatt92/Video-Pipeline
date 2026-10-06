import { z } from 'zod';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { getBrief, resolvePunchline } from './briefs';
import type { BureauToken } from './tokens';

/**
 * The approver's decisions. Each is one database function (migration 0040) that checks the
 * token's scope, makes the change and writes `authorship_log` in a single transaction. This
 * module adds the readable refusal in front and the side effect behind — starting a run,
 * waking a gate — which cannot live in SQL.
 *
 * Scope is checked here first so an agent gets a sentence, not a Postgres exception; the
 * database checks it again so a caller that forgets this module still cannot decide.
 */

export class ScopeError extends Error {
  constructor(action: string) {
    super(`${action} needs the approver scope. This token is an agent token: it can draft, read and queue, never decide.`);
    this.name = 'ScopeError';
  }
}

export function requireApprover(token: BureauToken, action: string): void {
  if (token.scope !== 'approver') throw new ScopeError(action);
}

/** Postgres raises `code: detail`; surface the detail without the plumbing. */
function dbError(message: string): Error {
  const m = /(token_invalid|scope_denied|not_found|conflict|invalid): (.+)/.exec(message);
  return new Error(m ? m[2] : message);
}

export interface Effects {
  /** Start the episode run (Trigger task `20-episode`). Returns the run id. */
  startEpisode(episodeId: string): Promise<string | null>;
  /** Complete a Trigger wait token (the cut gate). */
  completeWaitToken(tokenId: string, output: Record<string, unknown>): Promise<void>;
  /** Post a Slack notification, recorded in `notifications`. */
  notify?(channelId: string, kind: string, text: string, dedupeKey?: string): Promise<void>;
}

export async function approveBrief(
  db: Db,
  token: BureauToken,
  effects: Effects,
  input: { brief_id: string; punchline: string; edits?: Record<string, unknown> },
) {
  requireApprover(token, 'brief_approve');
  const brief = await getBrief(db, token.channelId, input.brief_id);
  if (!brief) throw new Error(`Brief ${input.brief_id} does not exist on this channel.`);
  const punchlines = Array.isArray(brief.punchlines) ? brief.punchlines.map(String) : [];
  const chosen = resolvePunchline(punchlines, input.punchline);

  const { data: episodeId, error } = await db.rpc('bureau_brief_approve', {
    p_token: token.id,
    p_brief: input.brief_id,
    p_punchline: chosen.text,
    p_choice: chosen.choice,
    p_edits: (input.edits ?? {}) as Json,
  });
  if (error || !episodeId) throw dbError(error?.message ?? 'approve returned no episode');

  // The decision is committed before the run starts. If starting fails, the episode row is
  // 'queued' with the reason in status_detail and the board shows it — the approval stands.
  let runId: string | null = null;
  let startError: string | null = null;
  try {
    runId = await effects.startEpisode(episodeId);
    await db.from('episodes').update({ run_id: runId, updated_at: new Date().toISOString() }).eq('id', episodeId);
  } catch (err) {
    startError = err instanceof Error ? err.message : String(err);
    await db.from('episodes').update({ status_detail: `run not started: ${startError}` }).eq('id', episodeId);
  }
  return { ok: true as const, brief_id: input.brief_id, episode_id: episodeId, punchline: chosen.text, choice: chosen.choice, run_id: runId, start_error: startError };
}

export async function rejectBrief(db: Db, token: BureauToken, input: { brief_id: string; reason: string }) {
  requireApprover(token, 'brief_reject');
  const { error } = await db.rpc('bureau_brief_reject', { p_token: token.id, p_brief: input.brief_id, p_reason: input.reason });
  if (error) throw dbError(error.message);
  return { ok: true as const, brief_id: input.brief_id, status: 'rejected' };
}

const CutDecision = z.object({ review_id: z.uuid(), cut_wait_token: z.string().nullable() });

export async function decideCut(
  db: Db,
  token: BureauToken,
  effects: Effects,
  input: { episode_id: string; approve: boolean; note?: string },
) {
  requireApprover(token, input.approve ? 'cut_approve' : 'cut_reject');
  const { data, error } = await db.rpc('bureau_cut_decide', {
    p_token: token.id,
    p_episode: input.episode_id,
    p_approve: input.approve,
    p_note: input.note ?? '',
  });
  if (error || !data) throw dbError(error?.message ?? 'cut decision returned nothing');
  const result = CutDecision.parse(data);

  // The run parked on this token; completing it is what lets the episode bundle (or re-roll
  // the shots the note names). A missing token means the run is gone — the decision still
  // stands, and the board shows the episode needs a manual restart.
  let woke = false;
  if (result.cut_wait_token) {
    await effects.completeWaitToken(result.cut_wait_token, { approved: input.approve, note: input.note ?? null, review_id: result.review_id });
    woke = true;
  }
  return { ok: true as const, episode_id: input.episode_id, decision: input.approve ? 'pass' : 'reshoot', review_id: result.review_id, run_woken: woke };
}

export async function setCaps(db: Db, token: BureauToken, changes: Record<string, unknown>) {
  requireApprover(token, 'caps_set');
  const { data, error } = await db.rpc('bureau_caps_set', { p_token: token.id, p_changes: changes as Json });
  if (error) throw dbError(error.message);
  return { ok: true as const, policy: data };
}

export async function setKillSwitch(db: Db, token: BureauToken, effects: Effects, input: { on: boolean; reason?: string }) {
  requireApprover(token, 'kill_switch');
  const { data, error } = await db.rpc('bureau_kill_switch', { p_token: token.id, p_on: input.on, p_reason: input.reason ?? '' });
  if (error) throw dbError(error.message);
  await effects.notify?.(token.channelId, 'kill_switch', `Kill switch ${input.on ? 'ON' : 'off'}${input.reason ? `: ${input.reason}` : ''}`);
  return { ok: true as const, kill_switch: input.on, policy: data };
}

/**
 * `videoId` is optional and is how the metrics loop finds the video: with manual Studio
 * scheduling nothing else here learns the YouTube id. Parsed by the caller (the publish
 * layer owns the URL shapes); stored only after the scheduling decision committed.
 */
export async function markScheduled(db: Db, token: BureauToken, input: { publication_id: string; at: string; videoId?: string | null; videoUrl?: string | null }) {
  requireApprover(token, 'mark_scheduled');
  const { data, error } = await db.rpc('bureau_mark_scheduled', { p_token: token.id, p_publication: input.publication_id, p_at: input.at });
  if (error) throw dbError(error.message);
  if (input.videoId) {
    await db.from('publications').update({ external_post_id: input.videoId, external_url: input.videoUrl ?? null }).eq('id', input.publication_id);
  }
  return { ok: true as const, publication: data, video_id: input.videoId ?? null, metrics: input.videoId ? 'will be pulled at 1h / 24h / 72h / 7d after the slot' : 'pass video_url to enable metric pulls' };
}
