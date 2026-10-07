import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { stillsAvailability } from './stills';

/**
 * A rejected cut, made again with scene stills.
 *
 * S003 (07-Oct) was planned before 0047 reached the hosted project, so every shot is an
 * overlay; Sahil rejected the cut because the pictures did not show the topic. A plain re-run
 * could not fix that: `planShots` keeps an episode's existing shots (it returns early when
 * any exist), so the run would rebuild exactly the cut that was rejected. And
 * `shot_regenerate` refuses overlays — there is nothing generated to re-roll.
 *
 * So before the run restarts, every overlay shot becomes a still — the illustrated format's rule
 * (`routesForFormat`); a money shot keeps its clip. The overlay spec stays on the row:
 * it is the still's camera move and its fallback, exactly as for a freshly planned still.
 * The voice, the script and the timings are untouched; the run re-uses all three.
 *
 * Nothing here spends. The stills are made by the run, one at a time, each behind the spend
 * cap and with its ledger row written before the call (rule 5).
 */
export type RecutPlan =
  | { ok: true; converted: number; stills: 'available' }
  | { ok: false; converted: 0; reason: string };

export async function stillsForRecut(db: Db, episodeId: string): Promise<RecutPlan> {
  const { data: e, error } = await db.from('episodes').select('id, channel_id, script_id, qc').eq('id', episodeId).single();
  if (error || !e) return { ok: false, converted: 0, reason: `episode ${episodeId} could not be read` };
  if (!e.script_id) return { ok: false, converted: 0, reason: 'the episode has no script, so no shots to re-plan' };

  const stills = await stillsAvailability(db, e.channel_id);
  if (!stills.available) return { ok: false, converted: 0, reason: stills.reason };

  const { data: rows, error: uErr } = await db
    .from('shots')
    .update({ render_route: 'still' })
    .eq('script_id', e.script_id)
    .eq('render_route', 'overlay')
    .select('idx');
  if (uErr) return { ok: false, converted: 0, reason: `the shots could not be re-planned: ${uErr.message}` };
  const converted = rows?.length ?? 0;

  const qc = (e.qc ?? {}) as { plan?: Record<string, unknown> };
  const plan = { ...(qc.plan ?? {}), stills: 'available', recut: { at: new Date().toISOString(), to_still: (rows ?? []).map((r) => r.idx).sort((a, b) => a - b) } };
  await db.from('episodes').update({ qc: { ...qc, plan } as unknown as Json }).eq('id', episodeId);
  return { ok: true, converted, stills: 'available' };
}
