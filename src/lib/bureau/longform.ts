import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { captionCues } from '../review/timeline';
import { shiftBy, type WordTiming } from '../voice/timings';
import { normaliseOverlay, type OverlaySpec } from '../../remotion/bureau/overlay-scene';
import type { BureauShot, BureauVideoProps } from '../../remotion/bureau/bureau-video';
import { getBible } from './bible';
import { estimateEpisode, fitToCap, PlannedShotSchema } from './estimate';
import { bindShotsToLines, setStatus, shotFrames, toSrt, type AssembleDeps } from './episode-steps';
import { parseScript, type Cast, type ScriptLine } from './script-lines';
import { takeWords } from './take-words';

const run = promisify(execFile);

/**
 * Long-form: 8–12 minutes from aired Shorts plus NEW connective scenes, approved as one brief.
 *
 * "Never raw re-stitching" is enforced here, not hoped for: two aired Shorts may not sit back
 * to back, there must be a cold-open scene, the new scenes must carry at least a fifth of the
 * runtime, and the generated character beats across all scenes stay within 90 s.
 *
 * The aired Shorts are replayed from their CLEAN MASTERS (no burned text) — the long-form has
 * its own captions — pillarboxed onto the blueprint paper at 16:9.
 */

export const LF_WIDTH = 1920;
export const LF_HEIGHT = 1080;
export const LF_FPS = 30;

export const SegmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('short'), slot_id: z.string().regex(/^S\d{3}$/) }),
  z.object({
    type: z.literal('scene'),
    purpose: z.string().min(3),
    lines: z.string().min(5),
    shots: z.array(PlannedShotSchema).min(1),
  }),
]);
export type Segment = z.infer<typeof SegmentSchema>;

/** Pure. Every rule that makes a long-form a new episode rather than a compilation. */
export function validateSegments(segments: Segment[], airedShortS: Record<string, number | null>, cast: Cast): string[] {
  const problems: string[] = [];
  if (!segments.length) return ['no segments'];
  if (segments[0].type !== 'scene') problems.push('it must open on a new scene (the cold open), not an aired Short');
  segments.forEach((s, i) => {
    if (s.type === 'short' && segments[i + 1]?.type === 'short') problems.push(`segments ${i} and ${i + 1} are two aired Shorts back to back — that is re-stitching`);
    if (s.type === 'short' && airedShortS[s.slot_id] === undefined) problems.push(`${s.slot_id} has no aired master to replay`);
    if (s.type === 'short' && airedShortS[s.slot_id] === null) problems.push(`${s.slot_id}'s master has no measured duration`);
  });
  const scenes = segments.filter((s): s is Extract<Segment, { type: 'scene' }> => s.type === 'scene');
  if (!scenes.some((s) => /complaint/i.test(s.purpose) && /complaint box:/i.test(s.lines))) {
    problems.push('no mid-episode Complaint Box moment (a scene whose purpose names it, with a Complaint Box line)');
  }
  const sceneS = scenes.reduce((n, s) => n + s.shots.reduce((m, x) => m + x.duration_s, 0), 0);
  const shortS = segments.reduce((n, s) => n + (s.type === 'short' ? airedShortS[s.slot_id] ?? 0 : 0), 0);
  const total = sceneS + shortS;
  if (total < 480 || total > 720) problems.push(`estimated runtime ${Math.round(total)} s; long-form is 8–12 minutes (480–720 s)`);
  if (total > 0 && sceneS / total < 0.2) problems.push(`new scenes are ${Math.round((100 * sceneS) / total)}% of the runtime; at least 20% must be new`);
  const beats = scenes.flatMap((s) => s.shots).filter((x) => x.route === 'character_beat').reduce((n, x) => n + x.duration_s, 0);
  if (beats > 90) problems.push(`${beats} s of generated character beats; the long-form limit is 90 s`);
  for (const [i, s] of scenes.entries()) {
    const p = parseScript(s.lines, cast);
    if (!p.ok) problems.push(`scene ${i}: ${p.problems.join('; ')}`);
  }
  return problems;
}

/** The voiced script and the planned shots, scene by scene; shots tagged with their segment. */
export function longFormScript(segments: Segment[]): { script_text: string; shot_list: z.infer<typeof PlannedShotSchema>[] } {
  const scenes = segments.map((s, i) => ({ s, i })).filter((x): x is { s: Extract<Segment, { type: 'scene' }>; i: number } => x.s.type === 'scene');
  return {
    script_text: scenes.map((x) => x.s.lines.trim()).join('\n'),
    shot_list: scenes.flatMap((x) => x.s.shots.map((sh) => ({ ...sh, beat_id: `seg:${x.i}` }))),
  };
}

/** Clean-master durations of every aired Short, by slot (null = not measured). */
export async function airedMasters(db: Db, channelId: string): Promise<Record<string, { renderId: string; durationS: number | null; scriptId: string }>> {
  const { data: eps } = await db.from('episodes').select('slot_id, master_render_id, script_id').eq('channel_id', channelId).in('status', ['live', 'scheduled', 'bundled']);
  const out: Record<string, { renderId: string; durationS: number | null; scriptId: string }> = {};
  for (const e of eps ?? []) {
    if (!e.slot_id || !e.master_render_id || !e.script_id) continue;
    const { data: r } = await db.from('renders').select('duration_s').eq('id', e.master_render_id).single();
    out[e.slot_id] = { renderId: e.master_render_id, durationS: r?.duration_s === null || r?.duration_s === undefined ? null : Number(r.duration_s), scriptId: e.script_id };
  }
  return out;
}

/** Shots in running order: scene shots bound to their scene's lines, replays pointing at masters. */
export async function planLongForm(db: Db, episodeId: string, deps: { usdInrRate: number }): Promise<{ shots: number }> {
  const { data: e } = await db.from('episodes').select('*').eq('id', episodeId).single();
  const { data: b } = await db.from('briefs').select('*').eq('id', e!.brief_id).single();
  const { count } = await db.from('shots').select('id', { count: 'exact', head: true }).eq('script_id', e!.script_id!);
  if ((count ?? 0) > 0) return { shots: count ?? 0 };
  await setStatus(db, episodeId, 'shotlisting');
  const segments = z.array(SegmentSchema).parse(b!.segments);
  const masters = await airedMasters(db, e!.channel_id);
  const { data: script } = await db.from('scripts').select('beats').eq('id', e!.script_id!).single();
  const lines = (script!.beats as unknown as { lines: ScriptLine[] }).lines;
  const cb = await getBible(db, e!.channel_id);
  const lead = cb.characterBySlug(b!.lead_character);
  if (!lead) throw new Error(`Lead "${b!.lead_character}" is not in the ${cb.slug} cast.`);

  // Cost: every scene shot priced and fitted against the long-form cap at once, exactly as a
  // Short is fitted against its per-Short cap (unpriced → overlay, beats ≤ 90 s, ≥ 50% overlay).
  const sceneShots = segments.flatMap((seg, i) => (seg.type === 'scene' ? seg.shots.map((sh) => ({ i, sh })) : []));
  const est = await estimateEpisode(db, { shots: sceneShots.map((x) => x.sh), voChars: lines.reduce((n, l) => n + l.text.length, 0), usdInrRate: deps.usdInrRate });
  const { data: pol } = await db.from('channel_policy').select('*').eq('channel_id', e!.channel_id).single();
  const fit = fitToCap(sceneShots.map((x) => x.sh), est, {
    capInr: Number(pol!.daily_longform_cap_inr),
    overlayMinShare: Number(pol!.overlay_min_share),
    characterBeatMaxS: 90,
    moneyShotMax: Number(pol!.money_shot_max),
  });
  const fitted = new Map<number, typeof fit.shots>();
  sceneShots.forEach((x, k) => fitted.set(x.i, [...(fitted.get(x.i) ?? []), fit.shots[k]]));
  const finalEst = await estimateEpisode(db, { shots: fit.shots, voChars: lines.reduce((n, l) => n + l.text.length, 0), usdInrRate: deps.usdInrRate });
  await db.from('episodes').update({ estimate_inr: finalEst.total_inr, qc: { plan: { swaps: fit.swaps, unpriced: finalEst.unpriced } } as unknown as Json }).eq('id', episodeId);

  const rows: Record<string, unknown>[] = [];
  let lineCursor = 0;
  for (const [i, seg] of segments.entries()) {
    if (seg.type === 'short') {
      const m = masters[seg.slot_id];
      rows.push({ script_id: e!.script_id!, idx: rows.length, duration_s: m.durationS!, description: `Replay ${seg.slot_id}`, render_route: 'overlay', character_slugs: [], realistic: false, source_render_id: m.renderId, beat_id: `seg:${i}`, status: 'ready' });
      continue;
    }
    const sceneLines = parseScript(seg.lines, cb);
    const n = sceneLines.ok ? sceneLines.lines.length : 0;
    const mine = lines.slice(lineCursor, lineCursor + n);
    lineCursor += n;
    for (const { shot, first, last } of bindShotsToLines(fitted.get(i) ?? seg.shots, mine)) {
      rows.push({
        script_id: e!.script_id!,
        idx: rows.length,
        duration_s: shot.duration_s,
        description: shot.description,
        render_route: shot.route,
        character_slugs: shot.characters,
        overlay_spec: (shot.route === 'overlay' ? normaliseOverlay(shot.overlay, lead.accent_hex, rows.length + 1) : null) as unknown as Json,
        realistic: shot.route === 'money_shot' && shot.realistic,
        beat_id: `seg:${i}`,
        vo_char_start: mine[first].voStart,
        vo_char_end: mine[last].voEnd,
        status: 'pending',
      });
    }
  }
  const { error } = await db.from('shots').insert(rows as never);
  if (error) throw new Error(`long-form shots insert failed: ${error.message}`);
  return { shots: rows.length };
}

/**
 * Assemble 16:9: scene shots tile their slice of the VO track; replays carry their Short's
 * own audio. Captions: scene words and the replayed Shorts' words, each shifted to where they
 * now sit on the timeline.
 */
export async function assembleLongForm(db: Db, episodeId: string, deps: AssembleDeps): Promise<{ ok: true; renderId: string; frames: number } | { ok: false; code: string; detail: string }> {
  const { data: e } = await db.from('episodes').select('*').eq('id', episodeId).single();
  await setStatus(db, episodeId, 'assembling');
  const { data: shots } = await db.from('shots').select('id, idx, render_route, duration_s, duration_source, overlay_spec, source_render_id, vo_char_start').eq('script_id', e!.script_id!).order('idx');
  if (!shots?.length) return { ok: false, code: 'no_shots', detail: 'nothing to assemble' };
  const unmeasured = shots.filter((s) => !s.source_render_id && s.duration_source !== 'derived_from_vo');
  if (unmeasured.length) return { ok: false, code: 'durations_unmeasured', detail: `${unmeasured.length} scene shot(s) still on estimated durations` };

  const { data: script } = await db.from('scripts').select('beats').eq('id', e!.script_id!).single();
  const lines = (script!.beats as unknown as { lines: ScriptLine[] }).lines;
  const { data: takes } = await db.from('vo_takes').select('chunk_idx, word_timings, offset_s, text_in, duration_s').eq('script_id', e!.script_id!).eq('language', 'en').order('chunk_idx');
  const voice = e!.voice_detail as { vo_asset_id?: string } | null;
  const { data: voAsset } = voice?.vo_asset_id ? await db.from('assets').select('storage_key').eq('id', voice.vo_asset_id).single() : { data: null };
  if (!voAsset) return { ok: false, code: 'no_vo', detail: 'the episode has no VO track' };
  const voWords: WordTiming[] = (takes ?? []).flatMap((tk) => shiftBy(takeWords(tk), Number(tk.offset_s)));
  const lineOffset = (char: number) => {
    const i = lines.findIndex((l) => char >= l.voStart && char <= l.voEnd);
    return Number(takes?.find((t) => t.chunk_idx === i)?.offset_s ?? 0);
  };

  const work = await mkdtemp(join(tmpdir(), 'kiln-longform-'));
  try {
    const vo = join(work, 'vo.m4a');
    await deps.download(await deps.presign(voAsset.storage_key), vo);
    const durations = shots.map((s) => Number(s.duration_s));
    const frames = shotFrames(durations, LF_FPS);
    const pieces: string[] = [];
    const bureauShots: BureauShot[] = [];
    const words: WordTiming[] = [];
    let t = 0;
    for (const [i, s] of shots.entries()) {
      const piece = join(work, `a${i}.wav`);
      if (s.source_render_id) {
        const { data: r } = await db.from('renders').select('asset_id, script_id').eq('id', s.source_render_id).single();
        const { data: a } = await db.from('assets').select('storage_key').eq('id', r!.asset_id!).single();
        const url = await deps.presign(a!.storage_key);
        const local = join(work, `m${i}.mp4`);
        await deps.download(url, local);
        await run('ffmpeg', ['-v', 'error', '-y', '-i', local, '-vn', '-ac', '1', '-ar', '48000', '-t', String(durations[i]), piece]);
        bureauShots.push({ type: 'clip', url, frames: frames[i], fit: 'contain' });
        const { data: st } = await db.from('vo_takes').select('word_timings, offset_s, text_in, duration_s').eq('script_id', r!.script_id).eq('language', 'en').order('chunk_idx');
        for (const tk of st ?? []) words.push(...shiftBy(takeWords(tk), t + Number(tk.offset_s)));
      } else {
        const from = lineOffset(s.vo_char_start!);
        await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(from), '-t', String(durations[i]), '-i', vo, '-ac', '1', '-ar', '48000', '-af', `apad=whole_dur=${durations[i]}`, piece]);
        bureauShots.push({ type: 'overlay', overlay: s.overlay_spec as unknown as OverlaySpec, frames: frames[i] });
        // Every VO word that falls inside this shot's slice of the track, moved to the timeline.
        const inSlice = voWords.filter((w) => w.start >= from - 1e-6 && w.start < from + durations[i] - 1e-6);
        words.push(...shiftBy(inSlice, t - from));
      }
      pieces.push(piece);
      t += durations[i];
    }
    const list = join(work, 'list.txt');
    await writeFile(list, pieces.map((p) => `file '${p}'`).join('\n'));
    const audio = join(work, 'longform.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'aac', '-b:a', '160k', audio]);
    const loud = join(work, 'longform-14.m4a');
    await deps.normaliseAudio(audio, loud);
    const audioKey = `longform/${episodeId}/audio-14lufs.m4a`;
    await deps.putBytes(audioKey, createReadStream(loud));

    const total = frames.reduce((n, f) => n + f, 0);
    const cues = captionCues(words.sort((a, b) => a.start - b.start));
    const props: BureauVideoProps = {
      layer: 'composite',
      shots: bureauShots,
      audioUrl: await deps.presign(audioKey),
      musicUrl: null,
      cues,
      hook: null,
      safeBox: { x: Math.round(LF_WIDTH * 0.05), y: Math.round(LF_HEIGHT * 0.05), width: Math.round(LF_WIDTH * 0.9), height: Math.round(LF_HEIGHT * 0.85) },
    };
    const out = join(work, 'longform.mp4');
    const r = await deps.render({ props, durationInFrames: total, outputPath: out });
    if (!r.ok) return r;
    const key = `renders/${episodeId}/longform-en.mp4`;
    const bytes = await deps.putBytes(key, createReadStream(out));
    const { data: asset } = await db.from('assets').insert({ kind: 'video', storage_key: key, bytes, duration_s: total / LF_FPS, width: LF_WIDTH, height: LF_HEIGHT, meta: { layer: 'longform' } as Json }).select('id').single();
    const { data: render } = await db
      .from('renders')
      .insert({ script_id: e!.script_id!, variant_group_id: episodeId, variant_label: 'longform', format: 'longform_16x9', width: LF_WIDTH, height: LF_HEIGHT, duration_s: total / LF_FPS, asset_id: asset!.id, status: 'ready', kind: 'final', layer: 'longform', language: 'en' })
      .select('id')
      .single();
    const srtPath = join(work, 'captions-en.srt');
    await writeFile(srtPath, toSrt(cues));
    const srtKey = `renders/${episodeId}/longform-captions-en.srt`;
    await deps.putBytes(srtKey, createReadStream(srtPath));
    await db.from('episodes').update({ final_render_id: render!.id, master_render_id: render!.id, voice_detail: { ...(voice as object), srt_key: srtKey } as unknown as Json }).eq('id', episodeId);
    return { ok: true, renderId: render!.id, frames: total };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
