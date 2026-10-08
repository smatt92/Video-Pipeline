import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { TTS_PRESET_IDS, voiceRouteFor } from '../drivers/voice-route';
import { getBible, voiceOverrides } from './bible';
import { paceOf, VoicePaceSchema, type VoicePace } from './formats';
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

  // A shot that was PLANNED as a picture clip and only fell back to an overlay because its
  // picture failed goes back to being a clip, not a still: B26 (08-Oct) was approved with
  // full motion, every picture was refused, and the re-cut flattened its clip shots to stills —
  // the motion Sahil picked, lost by the path meant to repair the cut. The plan's own swap
  // record says which shots those were.
  const qc = (e.qc ?? {}) as { plan?: Record<string, unknown> };
  const swaps = ((qc.plan?.swaps as { idx: number; from: string; to: string }[] | undefined) ?? []);
  const wasClip = new Set(swaps.filter((w) => w.to === 'overlay' && w.from === 'picture_clip').map((w) => w.idx));
  const { data: overlays, error: rErr } = await db.from('shots').select('id, idx').eq('script_id', e.script_id).eq('render_route', 'overlay');
  if (rErr) return { ok: false, converted: 0, reason: `the shots could not be read: ${rErr.message}` };
  const toClip = (overlays ?? []).filter((r) => wasClip.has(r.idx));
  const toStill = (overlays ?? []).filter((r) => !wasClip.has(r.idx));
  for (const [route, list] of [['picture_clip', toClip], ['still', toStill]] as const) {
    if (!list.length) continue;
    const { error: uErr } = await db.from('shots').update({ render_route: route }).in('id', list.map((r) => r.id));
    if (uErr) return { ok: false, converted: 0, reason: `the shots could not be re-planned: ${uErr.message}` };
  }
  const converted = toClip.length + toStill.length;
  const sorted = (l: { idx: number }[]) => l.map((r) => r.idx).sort((a, b) => a - b);
  const plan = { ...(qc.plan ?? {}), stills: 'available', recut: { at: new Date().toISOString(), to_still: sorted(toStill), to_clip: sorted(toClip) } };
  await db.from('episodes').update({ qc: { ...qc, plan } as unknown as Json }).eq('id', episodeId);
  return { ok: true, converted, stills: 'available' };
}

/**
 * What a re-cut changes, from the approver's notes on the cut they sent back (S003, 07-Oct:
 * "the voice is too laggy … the pace is very very slow"). Before this, the re-cut button only
 * redrew pictures, and on an episode that already had them it rebuilt the rejected cut.
 *
 * The pace is stored with the approval (`briefs.approved_edits.voice_pace`, where Approvals
 * puts it) and logged; voices are locked per character by the caller through `lockVoice`,
 * which is a channel-level decision and says so. Then the episode's voice track is cleared, so
 * the run rebuilds it: lines whose speaker's voice is unchanged are re-used (paid once), a
 * changed voice re-speaks only that character's lines, and the pace is applied to all of them.
 */
export async function applyRecutNotes(
  db: Db,
  actor: { channelId: string; tokenId: string | null; profileId: string | null },
  episodeId: string,
  notes: { pace?: string; voicesChanged?: string[] },
): Promise<{ ok: true; summary: string[] } | { ok: false; reason: string }> {
  const { data: e } = await db.from('episodes').select('id, status, brief_id, channel_id').eq('id', episodeId).maybeSingle();
  if (!e || e.channel_id !== actor.channelId) return { ok: false, reason: 'No such episode on this channel.' };
  if (e.status !== 'cut_rejected') return { ok: false, reason: `Episode is ${e.status}; only a cut you sent back can be re-cut.` };
  const summary: string[] = [];

  if (notes.pace !== undefined) {
    const pace = VoicePaceSchema.safeParse(notes.pace);
    if (!pace.success) return { ok: false, reason: `"${notes.pace}" is not a pace (normal, brisk or fast).` };
    const { data: b } = await db.from('briefs').select('approved_edits').eq('id', e.brief_id).single();
    const edits = { ...((b?.approved_edits ?? {}) as Record<string, unknown>), voice_pace: pace.data };
    const { error } = await db.from('briefs').update({ approved_edits: edits as Json }).eq('id', e.brief_id);
    if (error) return { ok: false, reason: `The pace could not be saved: ${error.message}` };
    summary.push(`pace ${pace.data}`);
  }
  if (notes.voicesChanged?.length) summary.push(`new voice for ${notes.voicesChanged.join(', ')}`);

  // The voice track is rebuilt on the re-run (voiceStep returns early while one is recorded).
  const { error: vErr } = await db.from('episodes').update({ voice_detail: null }).eq('id', episodeId);
  if (vErr) return { ok: false, reason: `The voice track could not be reset: ${vErr.message}` };

  await db.from('authorship_log').insert({
    channel_id: e.channel_id,
    actor_scope: 'approver',
    token_id: actor.tokenId,
    profile_id: actor.profileId,
    action: 'cut_recut',
    subject_type: 'episode',
    subject_id: episodeId,
    exact_text: summary.length ? summary.join('; ') : 'pictures only',
    payload: notes as unknown as Json,
  });
  return { ok: true, summary };
}

export interface RecutOptions {
  /** The note the cut was sent back with, so the form sits beside what it answers. */
  note: string | null;
  pace: VoicePace;
  speakers: { slug: string; name: string; voice: string | null }[];
  presets: readonly string[];
}

/** What the re-cut form offers for one episode: its speakers with their current voices, and its pace. */
export async function recutOptions(db: Db, channelId: string, ep: { script_id: string | null; brief_id: string; status_detail: string | null }): Promise<RecutOptions> {
  const cb = await getBible(db, channelId);
  const overrides = await voiceOverrides(db, channelId);
  const { data: script } = ep.script_id ? await db.from('scripts').select('beats').eq('id', ep.script_id).maybeSingle() : { data: null };
  const lines = ((script?.beats ?? {}) as { lines?: { speaker: string }[] }).lines ?? [];
  const slugs = [...new Set(lines.map((l) => l.speaker))];
  const speakers = slugs.map((slug) => {
    const c = cb.characterBySlug(slug);
    if (!c) return { slug, name: slug, voice: null };
    const r = voiceRouteFor(c, overrides.get(slug));
    return { slug, name: c.name, voice: r.ok ? r.voiceId : null };
  });
  const { data: b } = await db.from('briefs').select('approved_edits, series').eq('id', ep.brief_id).maybeSingle();
  const pace = paceOf({ approvedEdits: b?.approved_edits, seriesPace: b ? cb.seriesFor(b.series as never)?.voice_pace : undefined }).pace;
  const note = ep.status_detail?.replace(/^rejected:\s*/, '').replace(/\s*—\s*queue a re-roll[\s\S]*$/, '').trim() || null;
  return { note, pace, speakers, presets: TTS_PRESET_IDS };
}
