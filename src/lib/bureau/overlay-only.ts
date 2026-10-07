import type { Db } from '../db/server';
import { isUsableReference } from './bible';
import { recipeForRoute } from './estimate';

/**
 * Is a cut overlay-only, and why — said plainly on Board and Cuts.
 *
 * A cut is overlay-only when no shot of it reached the viewer as a generated clip: every shot
 * was planned as an overlay, or swapped to one at planning (no locked reference frame, a
 * series without money shots, the cap), or its generation never produced a clip and the
 * assembler drew the overlay in its place. Nothing is wrong with such a cut — it is the
 * pipeline refusing to generate a stranger and bill for it — but a viewer sees chalk diagrams
 * and no cast, and the screen has to say so rather than leave it to be noticed in the player.
 *
 * Two kinds of reason, kept apart: the CHANNEL's (cast without a usable reference frame, a
 * generated route with no active recipe — true for every episode until fixed) and the
 * EPISODE's (its own planning swaps, recorded in episodes.qc.plan.swaps).
 */

export interface ChannelGeneration {
  /** Cast slugs whose characters row carries no usable reference frame. */
  castWithoutFrames: string[];
  /** Generated routes with no active recipe in the prompt library. */
  routesWithoutRecipe: string[];
  /** One sentence, or null when generation could reach a viewer. */
  summary: string | null;
}

export async function channelGeneration(db: Db, channelId: string): Promise<ChannelGeneration> {
  const { data: chars } = await db.from('characters').select('slug, external_ref_id').eq('channel_id', channelId);
  const castWithoutFrames = (chars ?? []).filter((c) => !c.external_ref_id || !isUsableReference(c.external_ref_id)).map((c) => c.slug ?? '?');
  const routesWithoutRecipe: string[] = [];
  for (const route of ['character_beat', 'money_shot'] as const) {
    if (!(await recipeForRoute(db, route))) routesWithoutRecipe.push(route);
  }
  const parts: string[] = [];
  if ((chars ?? []).length === 0) parts.push('the cast has not been synced yet (it is on the first episode run)');
  else if (castWithoutFrames.length === (chars ?? []).length) parts.push('every cast reference frame is still a placeholder (pnpm frame:lock)');
  else if (castWithoutFrames.length) parts.push(`${castWithoutFrames.join(', ')} ${castWithoutFrames.length === 1 ? 'has' : 'have'} no locked reference frame`);
  if (routesWithoutRecipe.length) parts.push(`no active recipe for ${routesWithoutRecipe.join(' or ')} (Library → Prompts; activation needs a watched sample)`);
  const blocksAll = (chars ?? []).length === 0 || castWithoutFrames.length === (chars ?? []).length || routesWithoutRecipe.length === 2;
  return { castWithoutFrames, routesWithoutRecipe, summary: parts.length ? `${blocksAll ? 'Every shot renders as an overlay' : 'Some shots render as overlays'}: ${parts.join('; ')}.` : null };
}

export interface EpisodeClips {
  /** Shots planned on a generated route. */
  generatedPlanned: number;
  /** Shots with a succeeded generation whose clip was normalised (what the assembler uses). */
  clips: number;
  overlayOnly: boolean;
  /** This episode's own planning swaps, verbatim. */
  swaps: string[];
}

export async function episodeClips(db: Db, ep: { script_id: string | null; qc: unknown }): Promise<EpisodeClips | null> {
  if (!ep.script_id) return null;
  const { data: shots } = await db.from('shots').select('id, render_route').eq('script_id', ep.script_id);
  if (!shots?.length) return null;
  const generated = shots.filter((s) => s.render_route && s.render_route !== 'overlay');
  let clips = 0;
  if (generated.length) {
    const { data: gens } = await db.from('generations').select('id, shot_id').in('shot_id', generated.map((s) => s.id)).eq('status', 'succeeded');
    const ids = (gens ?? []).map((g) => g.id);
    if (ids.length) {
      const { data: assets } = await db.from('assets').select('generation_id').in('generation_id', ids).not('normalized_at', 'is', null);
      const withClip = new Set((assets ?? []).map((a) => a.generation_id));
      clips = new Set((gens ?? []).filter((g) => withClip.has(g.id)).map((g) => g.shot_id)).size;
    }
  }
  const plan = ((ep.qc ?? {}) as { plan?: { swaps?: { idx: number; from: string; reason: string }[] } }).plan;
  const swaps = (plan?.swaps ?? []).map((s) => `shot ${s.idx}: ${s.from} → overlay — ${s.reason}`);
  return { generatedPlanned: generated.length, clips, overlayOnly: clips === 0, swaps };
}
