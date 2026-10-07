import { z } from 'zod';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { getBrief, resolvePunchline } from './briefs';
import type { BureauToken } from './tokens';
import { stillsForRecut } from './recut';
import { stalled } from './running';
import { variationRefusal } from './variation';

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
  startEpisode(episodeId: string, attempt?: string): Promise<string | null>;
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
  // The repetition check must have RUN. A failed check is the approver's call against a flag;
  // a check that could not run gives the approver nothing to weigh. The same refusal sits in
  // bureau_brief_approve (0044) for any caller that skips this function.
  const refused = variationRefusal(brief.variation);
  if (refused) {
    throw new Error(
      `variation_check refused this brief: ${refused}. Fix embeddings (onboarding step "Embeddings", or Settings → Integrations), ` +
        'then run variation_check with this brief_id to compute and store it.',
    );
  }
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

/**
 * Start the run for an approved episode whose run never started.
 *
 * approveBrief commits the decision first and then starts the run; when the start fails (a
 * wrong Trigger key, the worker not deployed yet) the episode sits at 'queued' with the reason
 * in status_detail and run_id null. Before this existed nothing could move it: re-approving
 * is refused (the brief is no longer pending) and no other caller starts a run. The board's
 * "Start run" button calls this. The trigger carries the same idempotency key approveBrief
 * uses, so a double click or a retry after a run did start cannot start a second run.
 */
export async function startQueuedEpisode(db: Db, token: BureauToken, effects: Effects, input: { episode_id: string }) {
  requireApprover(token, 'episode_start');
  const { data: ep, error } = await db.from('episodes').select('id, status, run_id, channel_id').eq('id', input.episode_id).maybeSingle();
  if (error) throw dbError(error.message);
  // The token's channel, like every decision function in the database (0040).
  if (!ep || ep.channel_id !== token.channelId) throw new Error('No such episode on this channel.');
  if (ep.status !== 'queued') throw new Error(`Episode is ${ep.status}, not queued — its run already started.`);
  if (ep.run_id) throw new Error('This episode already has a run.');
  try {
    const runId = await effects.startEpisode(ep.id);
    await db.from('episodes').update({ run_id: runId, status_detail: null, updated_at: new Date().toISOString() }).eq('id', ep.id);
    return { ok: true as const, episode_id: ep.id, run_id: runId, start_error: null };
  } catch (err) {
    const startError = err instanceof Error ? err.message : String(err);
    await db.from('episodes').update({ status_detail: `run not started: ${startError}` }).eq('id', ep.id);
    return { ok: false as const, episode_id: ep.id, run_id: null, start_error: startError };
  }
}

/**
 * Restart the run for an episode that HALTED — a refusal, not a crash: no locked voice, an
 * unconfirmed stage, a missing integration. Fix the cause, then restart here. Every stage is
 * replayable and re-uses what it already paid for (voice re-uses its takes), so a restart
 * spends only what the earlier run did not reach.
 *
 * The idempotency key carries the halted row's updated_at: two clicks on the same halt start
 * one run; the next halt writes a new updated_at, so it can be restarted in turn. Before this,
 * the only restart path was Replay in the Trigger.dev dashboard.
 */
export async function restartHaltedEpisode(db: Db, token: BureauToken, effects: Effects, input: { episode_id: string }) {
  requireApprover(token, 'episode_restart');
  const { data: ep, error } = await db.from('episodes').select('id, status, updated_at, channel_id').eq('id', input.episode_id).maybeSingle();
  if (error) throw dbError(error.message);
  if (!ep || ep.channel_id !== token.channelId) throw new Error('No such episode on this channel.');
  // 'failed' too: a crash after a fix (S001's render, 07-Oct) needs the same way back as a refusal.
  // And a stalled run (see running.ts): the worker ended without writing a status.
  // And a rejected cut (S003, 07-Oct): restarting it re-cuts with scene stills in place of the
  // overlays, keeping the script and the paid voice. Without the re-plan a re-run rebuilds the
  // exact cut that was rejected — planShots keeps existing shots (recut.ts).
  const rejected = ep.status === 'cut_rejected';
  if (ep.status !== 'halted' && ep.status !== 'failed' && !rejected && !stalled(ep.status, ep.updated_at)) {
    throw new Error(`Episode is ${ep.status}, not halted, failed, stalled or sent back — nothing to restart.`);
  }
  if (rejected) {
    const plan = await stillsForRecut(db, ep.id);
    if (!plan.ok) throw new Error(`Not re-cut: ${plan.reason}. Re-running now would rebuild the cut you sent back.`);
    // The voice track is rebuilt too (paid takes re-used), so the current pace and voices apply.
    await db.from('episodes').update({ voice_detail: null }).eq('id', ep.id);
  }
  try {
    const runId = await effects.startEpisode(ep.id, `restart:${new Date(ep.updated_at).getTime()}`);
    // Back to 'queued' with the new run: a second click now finds it not halted and is refused,
    // rather than deriving a fresh key from the updated_at this write changes. (verify:episode
    // §7b caught exactly that: leaving it 'halted' let a double click start two runs.)
    await db.from('episodes').update({ status: 'queued', run_id: runId, status_detail: null, updated_at: new Date().toISOString() }).eq('id', ep.id);
    return { ok: true as const, episode_id: ep.id, run_id: runId, start_error: null };
  } catch (err) {
    const startError = err instanceof Error ? err.message : String(err);
    return { ok: false as const, episode_id: ep.id, run_id: null, start_error: startError };
  }
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
  await effects.notify?.(token.channelId, 'kill_switch', input.on ? `Kill switch on — every job for this channel stopped, and spend with it${input.reason ? ` (${input.reason})` : ''}. Turn it off on Home to resume.` : 'Kill switch off. Jobs for this channel can run again.');
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
