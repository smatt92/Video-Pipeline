import { randomUUID } from 'node:crypto';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import type { BureauToken } from './tokens';

/**
 * Agent-scope writes on an episode: re-rolling a shot, queueing dubs. Neither decides
 * anything — a re-roll produces a new candidate the approver still has to pass at the cut,
 * and a dub produces a language track nobody publishes without a human — so both are open
 * to the agent scope. Both are logged with the token that asked.
 */

export const DUB_LANGUAGES = ['hi', 'es', 'pt-BR'] as const;
export type DubLanguage = (typeof DUB_LANGUAGES)[number];

async function log(db: Db, token: BureauToken, action: string, subjectType: string, subjectId: string, text: string | null, payload: Record<string, unknown>) {
  await db.from('authorship_log').insert({
    channel_id: token.channelId,
    actor_scope: token.scope,
    token_id: token.id,
    profile_id: token.profileId,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    exact_text: text,
    payload: payload as Json,
  });
}

export async function regenerateShot(
  db: Db,
  token: BureauToken,
  input: { episode_id: string; shot: number | string; note: string },
) {
  const { data: ep } = await db.from('episodes').select('id, channel_id, script_id, status').eq('id', input.episode_id).maybeSingle();
  if (!ep || ep.channel_id !== token.channelId) throw new Error(`Episode ${input.episode_id} does not exist on this channel.`);
  if (!ep.script_id) throw new Error('This episode has no shots yet.');
  if (!['qc', 'awaiting_cut', 'cut_rejected', 'generating'].includes(ep.status)) {
    throw new Error(`Episode is ${ep.status}; shots can be re-rolled from generating through cut review.`);
  }

  const q = db.from('shots').select('id, idx, render_route, status').eq('script_id', ep.script_id);
  const { data: shot } = await (typeof input.shot === 'number' ? q.eq('idx', input.shot) : q.eq('id', input.shot)).maybeSingle();
  if (!shot) throw new Error(`No shot ${input.shot} on this episode.`);
  if (!shot.render_route || shot.render_route === 'overlay') {
    throw new Error('Overlay shots are rendered in-house and re-render with the cut; there is nothing to re-roll.');
  }
  if (shot.render_route === 'still') {
    // Not wired yet (0021): a still is made once by the episode's still step. Said plainly
    // rather than queued as a video job that would generate the wrong thing.
    throw new Error('Scene stills cannot be re-rolled from here yet. Reject the cut with a note; a re-run makes a new still for any shot whose still is missing.');
  }

  const r = await insertReroll(db, { channelId: token.channelId, episodeId: ep.id, shotId: shot.id, shotIdx: shot.idx, note: input.note });
  await log(db, token, 'shot_regenerate', 'shot', shot.id, input.note, { episode_id: ep.id, job_id: r.jobId, reroll_index: r.rerollIndex });
  return { ok: true as const, job_id: r.jobId, shot_idx: shot.idx, reroll_index: r.rerollIndex, rerolls_max: r.max };
}

/**
 * Queue one re-roll of a generated shot: same provider, model and params as its latest job,
 * `reroll_of` pointing back, `reroll_index` + 1, capped at `channel_policy.rerolls_max`. The
 * one implementation behind both shot_regenerate (a person or agent asked) and QC (a clip
 * failed its checks) — two copies of this would drift on the cap.
 */
export async function insertReroll(
  db: Db,
  input: { channelId: string; episodeId: string; shotId: string; shotIdx: number; note: string },
): Promise<{ jobId: string; rerollIndex: number; max: number }> {
  const { data: last } = await db
    .from('gen_jobs')
    .select('id, render_route, provider, model, endpoint, params, prompt_id, duration_s, estimate_inr, reroll_index')
    .eq('shot_id', input.shotId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!last) throw new Error('This shot has never been generated, so there is nothing to re-roll from.');

  const { data: pol } = await db.from('channel_policy').select('rerolls_max').eq('channel_id', input.channelId).single();
  const max = pol?.rerolls_max ?? 2;
  if (last.reroll_index >= max) {
    throw new Error(`Shot ${input.shotIdx} has used its ${max} re-rolls. It goes to the approver as it is, or is swapped to an overlay.`);
  }

  const { data: job, error } = await db
    .from('gen_jobs')
    .insert({
      episode_id: input.episodeId,
      shot_id: input.shotId,
      render_route: last.render_route,
      provider: last.provider,
      model: last.model,
      endpoint: last.endpoint,
      params: last.params,
      prompt_id: last.prompt_id,
      duration_s: last.duration_s,
      estimate_inr: last.estimate_inr,
      idempotency_key: `reroll:${input.shotId}:${last.reroll_index + 1}:${randomUUID()}`,
      reroll_of: last.id,
      reroll_index: last.reroll_index + 1,
      note: input.note,
    })
    .select('id')
    .single();
  if (error || !job) throw new Error(`Queueing the re-roll failed: ${error?.message}`);
  await db.from('shots').update({ status: 'reshoot' }).eq('id', input.shotId);
  return { jobId: job.id, rerollIndex: last.reroll_index + 1, max };
}

export async function queueDubs(db: Db, token: BureauToken, input: { episode_id: string; languages: DubLanguage[] }) {
  const { data: ep } = await db.from('episodes').select('id, channel_id, status').eq('id', input.episode_id).maybeSingle();
  if (!ep || ep.channel_id !== token.channelId) throw new Error(`Episode ${input.episode_id} does not exist on this channel.`);
  if (!['bundled', 'scheduled', 'live', 'cut_approved'].includes(ep.status)) {
    throw new Error(`Episode is ${ep.status}; only an approved cut can be dubbed.`);
  }
  const rows = input.languages.map((language) => ({
    episode_id: ep.id,
    language,
    requested_by: token.scope,
    token_id: token.id,
  }));
  const { data, error } = await db
    .from('dub_jobs')
    .upsert(rows, { onConflict: 'episode_id,language', ignoreDuplicates: true })
    .select('id, language, status');
  if (error) throw new Error(error.message);
  await log(db, token, 'dub_queue_add', 'episode', ep.id, input.languages.join(','), {});
  return { ok: true as const, queued: data ?? [], note: 'Dub cost shows as "rate unverified": the vendor publishes no dubbing rate.' };
}

export async function listDubs(db: Db, channelId: string) {
  const { data: eps } = await db.from('episodes').select('id, slot_id').eq('channel_id', channelId);
  const ids = (eps ?? []).map((e) => e.id);
  if (!ids.length) return { jobs: [] };
  const { data, error } = await db
    .from('dub_jobs')
    .select('id, episode_id, language, status, credits_estimated, estimate_inr, error, created_at, updated_at')
    .in('episode_id', ids)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return {
    jobs: (data ?? []).map((j) => ({
      ...j,
      slot_id: eps?.find((e) => e.id === j.episode_id)?.slot_id ?? null,
      cost_label: j.estimate_inr === null ? 'not yet submitted' : 'rate unverified (vendor estimate, upper bound)',
    })),
  };
}
