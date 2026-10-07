import { randomUUID } from 'node:crypto';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { getBible } from './bible';
import { requireApprover } from './control';
import { assembleEpisode, pictureSpansFor, type AssembleDeps } from './episode-steps';
import { generateStillForShot, stillsByPart, type StillDeps } from './stills';
import { redrawInFlight, redrawsOf, type RedrawEntry } from './redraw-state';
import type { BureauToken } from './tokens';


/**
 * "Redraw this picture" (Cuts, 07-Oct-2026). An illustrated shot carries one picture per
 * ~6 s of narration (formats.ts); the approver can have one of them — or all of a shot's —
 * drawn again, with an optional one-line note, while the cut waits for a decision.
 *
 *   requestRedraw   approver only (the web action and shot_regenerate on a still shot); writes
 *                   the request onto the episode (`qc.redraws`), logs it, starts `25-redraw`.
 *   runRedraw       the task's body: a new still for each asked part (generateStillForShot —
 *                   the same rules 5 and 6 path as the episode run, attempts counted per part),
 *                   then ONLY the composite re-rendered, `final_render_id` moved to it, the
 *                   loudness measured again. The episode stays `awaiting_cut` on the SAME cut
 *                   wait token throughout: approving later wakes the run that is already
 *                   parked, and its clean master and caption layer draw from `stillsByPart`,
 *                   which is the newest picture per part.
 *
 * ── Why the cut cannot be decided while a redraw runs ─────────────────────────
 *
 * The cut being watched is about to change. Approving it would approve a composite nobody
 * saw, and the master rendered after approval would carry a picture nobody approved. So
 * decideCut refuses (`redrawRefusal`) and so does `bureau_cut_decide` (0050), for any caller
 * — the MCP connector included. A redraw that never finishes would hold the cut for ever, so
 * an entry older than REDRAW_STALE_MS no longer counts as in flight, in both places.
 *
 * ── Where it is recorded, and the one race it has ─────────────────────────────
 *
 * `episodes.qc.redraws` — a jsonb list, so this works before any migration is pasted. Each
 * write re-reads qc and replaces only its own entry. Two writers of one episode's qc can
 * still interleave in the milliseconds between that read and the write; only one redraw per
 * episode may be in flight (requestRedraw refuses a second) and the parked episode run does
 * not write qc, which is what keeps the window to the request write against the task's.
 *
 * A failed redraw keeps the previous picture: stillsByPart only reads succeeded generations,
 * so nothing the failure wrote can be drawn. The entry says why.
 */

async function patchRedraw(db: Db, episodeId: string, id: string, patch: Partial<RedrawEntry>, extra: Record<string, unknown> = {}) {
  const { data } = await db.from('episodes').select('qc').eq('id', episodeId).single();
  const qc = (data?.qc ?? {}) as Record<string, unknown>;
  const list = redrawsOf(qc).map((r) => (r.id === id ? { ...r, ...patch } : r));
  await db.from('episodes').update({ qc: { ...qc, ...extra, redraws: list } as unknown as Json, updated_at: new Date().toISOString() }).eq('id', episodeId);
}

export interface RedrawRequest {
  episode_id: string;
  shot: number | string;
  /** Absent → every picture of the shot. */
  part?: number;
  note?: string;
}

export interface RedrawEffects {
  /** Start `25-redraw`; returns the run id. */
  startRedraw?(input: { episodeId: string; shotId: string; parts: number[]; note: string | null; redrawId: string }): Promise<string | null>;
}

export async function requestRedraw(db: Db, token: BureauToken, effects: RedrawEffects, input: RedrawRequest) {
  requireApprover(token, 'redraw');
  const { data: ep } = await db.from('episodes').select('id, channel_id, script_id, status, qc, final_render_id').eq('id', input.episode_id).maybeSingle();
  if (!ep || ep.channel_id !== token.channelId) throw new Error(`Episode ${input.episode_id} does not exist on this channel.`);
  if (ep.status !== 'awaiting_cut') throw new Error(`Episode is ${ep.status}; a picture can be redrawn while its cut is awaiting your call.`);
  if (!ep.script_id || !ep.final_render_id) throw new Error('This episode has no cut to redraw a picture in.');
  const busy = redrawInFlight(ep.qc);
  if (busy) throw new Error(`Shot ${busy.shot_idx} is already being redrawn. One redraw at a time — this one starts once it is in.`);

  const q = db.from('shots').select('id, idx, render_route').eq('script_id', ep.script_id);
  const { data: shot } = await (typeof input.shot === 'number' ? q.eq('idx', input.shot) : q.eq('id', input.shot)).maybeSingle();
  if (!shot) throw new Error(`No shot ${input.shot} on this episode.`);
  if (shot.render_route !== 'still') throw new Error(`Shot ${shot.idx} is ${shot.render_route ?? 'an overlay'}, not a picture; only illustrated shots are redrawn.`);
  const spans = (await pictureSpansFor(db, ep.script_id)).get(shot.id) ?? [];
  const count = Math.max(1, spans.length);
  if (input.part !== undefined && (!Number.isInteger(input.part) || input.part < 0 || input.part >= count)) {
    throw new Error(`Shot ${shot.idx} has ${count} picture${count === 1 ? '' : 's'} (0–${count - 1}); there is no picture ${input.part}.`);
  }
  const parts = input.part === undefined ? [...Array(count).keys()] : [input.part];
  if (!effects.startRedraw) throw new Error('This deployment cannot start a redraw (no Trigger.dev secret key).');
  const note = input.note?.trim() ? input.note.trim().replace(/\s+/g, ' ').slice(0, 200) : null;

  const entry: RedrawEntry = { id: randomUUID(), shot_id: shot.id, shot_idx: shot.idx, parts, note, state: 'queued', reason: null, requested_at: new Date().toISOString(), finished_at: null, run_id: null, token_id: token.id };
  const qc = (ep.qc ?? {}) as Record<string, unknown>;
  const { error } = await db.from('episodes').update({ qc: { ...qc, redraws: [...redrawsOf(qc), entry] } as unknown as Json, updated_at: new Date().toISOString() }).eq('id', ep.id);
  if (error) throw new Error(`The redraw could not be recorded: ${error.message}`);
  await db.from('authorship_log').insert({
    channel_id: token.channelId,
    actor_scope: token.scope,
    token_id: token.id,
    profile_id: token.profileId,
    action: 'still_redraw',
    subject_type: 'shot',
    subject_id: shot.id,
    exact_text: note,
    payload: { episode_id: ep.id, redraw_id: entry.id, parts, render_id: ep.final_render_id } as Json,
  });
  try {
    const runId = await effects.startRedraw({ episodeId: ep.id, shotId: shot.id, parts, note, redrawId: entry.id });
    await patchRedraw(db, ep.id, entry.id, { run_id: runId });
    return { ok: true as const, redraw_id: entry.id, shot_idx: shot.idx, parts, run_id: runId };
  } catch (err) {
    const reason = `the redraw did not start: ${err instanceof Error ? err.message : String(err)}`;
    await patchRedraw(db, ep.id, entry.id, { state: 'failed', reason, finished_at: new Date().toISOString() });
    throw new Error(reason);
  }
}

export interface RunRedrawDeps {
  still: StillDeps;
  assemble: AssembleDeps;
  /** Loudness of a rendered composite, measured on its bytes (worker). null = not measurable. */
  measureLoudness(renderId: string): Promise<number | null>;
}

export type RedrawOutcome =
  | { ok: true; renderId: string; made: number; failed: number; costInr: number }
  | { ok: false; reason: string; made: number; costInr: number };

type RedrawInput = { episodeId: string; shotId: string; parts: number[]; note: string | null; redrawId: string };

/** A crash is a failed redraw with its reason, never an entry left in flight holding the cut. */
export async function runRedraw(db: Db, input: RedrawInput, deps: RunRedrawDeps): Promise<RedrawOutcome> {
  try {
    return await redrawOnce(db, input, deps);
  } catch (err) {
    const reason = `the redraw crashed: ${err instanceof Error ? err.message : String(err)} — the previous picture stays unless a new one was already stored`;
    await patchRedraw(db, input.episodeId, input.redrawId, { state: 'failed', reason, finished_at: new Date().toISOString() }).catch(() => undefined);
    await db.from('episodes').update({ status_detail: null }).eq('id', input.episodeId).eq('status', 'awaiting_cut');
    return { ok: false, reason, made: 0, costInr: 0 };
  }
}

async function redrawOnce(db: Db, input: RedrawInput, deps: RunRedrawDeps): Promise<RedrawOutcome> {
  const fail = async (reason: string, made = 0, costInr = 0, results?: RedrawEntry['results']): Promise<RedrawOutcome> => {
    await patchRedraw(db, input.episodeId, input.redrawId, { state: 'failed', reason, finished_at: new Date().toISOString(), ...(results ? { results } : {}) });
    await db.from('episodes').update({ status_detail: null }).eq('id', input.episodeId).eq('status', 'awaiting_cut');
    return { ok: false, reason, made, costInr };
  };
  const { data: e } = await db.from('episodes').select('id, channel_id, brief_id, script_id, status, kind, qc').eq('id', input.episodeId).single();
  if (!e) return { ok: false, reason: 'episode not found', made: 0, costInr: 0 };
  const entry = redrawsOf(e.qc).find((r) => r.id === input.redrawId);
  if (!entry) return { ok: false, reason: 'no such redraw on the episode', made: 0, costInr: 0 };
  if (entry.state === 'done' || entry.state === 'failed') {
    // Replayed after it finished: nothing to do, and nothing is paid twice.
    return entry.state === 'done' && entry.render_id ? { ok: true, renderId: entry.render_id, made: 0, failed: 0, costInr: 0 } : { ok: false, reason: entry.reason ?? 'already failed', made: 0, costInr: 0 };
  }
  if (e.status !== 'awaiting_cut') return fail(`the episode moved to ${e.status} before the redraw ran`);
  const { data: b } = await db.from('briefs').select('premise, lead_character').eq('id', e.brief_id).single();
  const { data: shot } = await db.from('shots').select('id, idx, description, script_id, render_route').eq('id', input.shotId).single();
  if (!b || !shot || shot.script_id !== e.script_id || shot.render_route !== 'still') return fail('the shot is no longer a picture of this episode');
  const cb = await getBible(db, e.channel_id);
  const lead = cb.characterBySlug(b.lead_character);
  if (!lead) return fail(`lead "${b.lead_character}" is not in the ${cb.slug} cast`);
  const spans = (await pictureSpansFor(db, e.script_id!)).get(shot.id) ?? [{ from: 0, frames: 0, narration: '' }];
  const cast = cb.bible.characters.map((c) => ({ id: c.id, name: c.name }));

  await patchRedraw(db, e.id, entry.id, { state: 'drawing' });
  const results: NonNullable<RedrawEntry['results']> = [];
  let costInr = 0;
  for (const [n, k] of input.parts.entries()) {
    await db.from('episodes').update({ status_detail: `redrawing shot ${shot.idx}, picture ${k + 1}${input.parts.length > 1 ? ` (${n + 1} of ${input.parts.length})` : ''}`, updated_at: new Date().toISOString() }).eq('id', e.id);
    const span = spans[k] ?? { narration: '' };
    const r = await generateStillForShot(
      db,
      { shot, channelId: e.channel_id, premise: b.premise, cast, world: cb.bible.world, accent: lead.accent_hex, kind: e.kind === 'long_form' ? 'long_form' : 'short', part: { index: k, of: spans.length, narration: span.narration }, direction: input.note ?? undefined },
      deps.still,
    );
    if (r.ok) costInr += r.costInr;
    results.push(r.ok ? { part: k, ok: true, generation_id: r.generationId, cost_inr: Math.round(r.costInr * 100) / 100 } : { part: k, ok: false, reason: r.reason });
  }
  const made = results.filter((r) => r.ok).length;
  if (!made) return fail(`no new picture: ${results.map((r) => r.reason).join('; ')} — the previous picture stays`, 0, costInr, results);

  // Only the composite: it is what is being watched. The master and the caption layer are
  // rendered after approval by the parked run, from the newest pictures.
  await patchRedraw(db, e.id, entry.id, { state: 'rendering', results });
  const asm = await assembleEpisode(db, e.id, deps.assemble, { layers: ['composite'], keepStatus: true, keyTag: `r${entry.id.slice(0, 8)}` });
  if (!asm.ok || !asm.compositeRenderId) {
    return fail(`the new picture is drawn but the cut could not be re-rendered (${asm.ok ? 'no composite' : `${asm.code}: ${asm.detail}`}); approving now would master it with the new picture — redraw again or send the cut back`, made, costInr, results);
  }
  const lufs = await deps.measureLoudness(asm.compositeRenderId).catch(() => null);
  const have = await stillsByPart(db, shot.id);
  await patchRedraw(
    db,
    e.id,
    entry.id,
    { state: 'done', finished_at: new Date().toISOString(), render_id: asm.compositeRenderId, results, reason: made < input.parts.length ? `${input.parts.length - made} picture(s) not redrawn; the previous one stays` : null },
    { loudness_lufs: lufs },
  );
  await db.from('episodes').update({ status_detail: null }).eq('id', e.id).eq('status', 'awaiting_cut');
  deps.still.log?.info('redraw done', { renderId: asm.compositeRenderId, parts: [...have.keys()] });
  return { ok: true, renderId: asm.compositeRenderId, made, failed: input.parts.length - made, costInr: Math.round(costInr * 100) / 100 };
}
