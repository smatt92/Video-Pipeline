import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { z } from 'zod';

import { DEFAULT_TTS_MODEL } from '../drivers/voice-route';
import { SAFE_AREAS } from '../assemble/composition';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { billedSeconds, REFERENCE_FRAME_PARAM, type RenderRoute } from '../drivers/generation';
import { routed } from '../llm/router';
import { POLISH_SYSTEM, PROMPT_REF } from '../prompts/20-bureau.v1';
import { captionCues, type CaptionCue } from '../review/timeline';
import { takeWords } from './take-words';
import { shiftBy, type WordTiming } from '../voice/timings';
import { normaliseOverlay, type OverlaySpec } from '../../remotion/bureau/overlay-scene';
import type { BureauShot, BureauVideoProps } from '../../remotion/bureau/bureau-video';
import { getBible, STORAGE_REF_PREFIX, syncCast, voiceOverrides, type ChannelBible, type Series } from './bible';
import { estimateEpisode, fitToCap, isVideoRoute, PlannedShotSchema, recipeForRoute, type PlannedShot } from './estimate';
import { formatOf, paceOf, pictureSpans, picturesFor, routesForFormat, type PictureSpan } from './formats';
import { fallBackToOverlay, generateStillForShot, stillsAvailability, stillsByPart, type StillDeps } from './stills';
import { pictureTuning, readTuning, syntheticFlag, type PictureTuning } from '../settings/tuning';
import { castAvailability, episodeCastSlugs, pictureCast, plannedFormat, wantedFor, type PlannedFormat } from './picture-cast';
import { parseScript, punchlineTurns, type Cast, type ScriptLine } from './script-lines';

/**
 * The episode run's steps, each a function of (db, episode) plus injected effects, each
 * replayable: a step that finds its output already written returns it instead of redoing
 * (and re-paying for) the work. `src/trigger/20-episode.ts` sequences them and owns the two
 * waits; `verify:episode` drives them directly with recording fakes for the vendors.
 *
 * Order, and why it is not the prompt's: script polish → shotlist → estimate & fit to cap →
 * VOICE → generation → QC → assembly → cut gate → bundle. Voice runs before generation
 * because word timings set shot durations (CLAUDE.md conventions; Addendum 02 §1) — a
 * character beat generated before its line is spoken is generated at a guessed length.
 */

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

export interface StepLog {
  info(m: string, d?: unknown): void;
  error(m: string, d?: unknown): void;
}
const quiet: StepLog = { info() {}, error() {} };

export async function setStatus(db: Db, episodeId: string, status: string, detail: string | null = null) {
  await db.from('episodes').update({ status, status_detail: detail, updated_at: new Date().toISOString() }).eq('id', episodeId);
}

async function loadEpisode(db: Db, episodeId: string) {
  const { data: e } = await db.from('episodes').select('*').eq('id', episodeId).single();
  if (!e) throw new Error(`episode ${episodeId} not found`);
  const { data: b } = await db.from('briefs').select('*').eq('id', e.brief_id).single();
  if (!b) throw new Error(`brief ${e.brief_id} not found`);
  // The episode's own channel decides the cast, series and world — never a constant.
  const cb = await getBible(db, e.channel_id);
  return { e, b, cb };
}

/** The brief's lead in the episode's channel's cast, or a refusal naming both. */
function leadOf(cb: ChannelBible, slug: string) {
  const c = cb.characterBySlug(slug);
  if (!c) throw new Error(`Lead "${slug}" is not in the ${cb.slug} cast.`);
  return c;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ═════════════════════════════════════════════════════════════════════════════
// 1. Script polish
// ═════════════════════════════════════════════════════════════════════════════

const PolishSchema = z.object({ script_text: z.string() });

export function scriptAcceptable(text: string, punchline: string, maxWords: number, cast: Cast): { ok: true; lines: ScriptLine[]; voText: string } | { ok: false; why: string } {
  const p = parseScript(text, cast);
  if (!p.ok) return { ok: false, why: p.problems.join('; ') };
  const words = p.voText.split(/\s+/).length;
  if (words > maxWords) return { ok: false, why: `${words} words > ${maxWords}` };
  // Every spoken turn of the punchline, in order — not the raw string, which carries speaker
  // names and stage directions nobody says (S003, 07-Oct).
  const spoken = norm(p.voText);
  let at = 0;
  for (const t of punchlineTurns(punchline, p.lines[p.lines.length - 1]?.speaker ?? '', cast)) {
    const i = spoken.indexOf(norm(t.text), at);
    if (i < 0) return { ok: false, why: 'the approved punchline is not in the script' };
    at = i + norm(t.text).length;
  }
  return { ok: true, lines: p.lines, voText: p.voText };
}

export async function prepareScript(
  db: Db,
  episodeId: string,
  deps: { apiKey: string | null; usdInrRate: number; log?: StepLog },
): Promise<{ scriptId: string; polished: boolean; reason: string | null }> {
  const log = deps.log ?? quiet;
  const { e, b, cb } = await loadEpisode(db, episodeId);
  if (e.script_id) return { scriptId: e.script_id, polished: false, reason: 'already scripted' };
  await setStatus(db, episodeId, 'scripting');
  await syncCast(db, e.channel_id, cb, await voiceOverrides(db, e.channel_id));

  const punchline = b.chosen_punchline!;
  const maxWords = b.series === 'long_form' ? 2000 : 150;
  const lead = leadOf(cb, b.lead_character);
  const base = scriptAcceptable(b.script_text, punchline, maxWords, cb).ok
    ? b.script_text
    : `${b.script_text.trim()}\n${punchlineTurns(punchline, lead.id, cb).map((t) => `${cb.characterBySlug(t.speaker)?.name ?? lead.name}: ${t.text}`).join('\n')}`;

  // Concept first: the script's cost rows hang off it.
  const titles = (b.titles as { text: string }[]) ?? [];
  const { data: concept, error: cErr } = await db
    .from('concepts')
    .insert({
      channel_id: e.channel_id,
      title: titles[0]?.text ?? b.premise.slice(0, 80),
      angle: b.premise,
      rubric_version: 'bureau-v1',
      status: 'in_production',
      approved_at: b.approved_at,
      scores: { variation: b.variation, policy: b.policy } as Json,
    })
    .select('id')
    .single();
  if (cErr || !concept) throw new Error(`concept insert failed: ${cErr?.message}`);

  let text = base;
  let polished = false;
  let reason: string | null = null;
  let draftedBy = `brief:${b.created_by}`;
  if (deps.apiKey) {
    try {
      const r = await routed(
        {
          task: 'script_polish',
          system: POLISH_SYSTEM,
          user: `SERIES: ${b.series}\nAPPROVED PUNCHLINE (keep verbatim, land it in the button beat): ${punchline}\nAPPROVED EDITS: ${JSON.stringify(b.approved_edits ?? {})}\nFACT: ${JSON.stringify(b.fact)}\n\nSCRIPT:\n${base}`,
          schema: PolishSchema,
          maxTokens: 1500,
        },
        { db, apiKey: deps.apiKey, usdInrRate: deps.usdInrRate, subject: { kind: 'channel', channelId: e.channel_id, idempotencyKey: `polish:${episodeId}`, stage: '20-script-polish' } },
      );
      const ok = scriptAcceptable(r.data.script_text, punchline, maxWords, cb);
      if (ok.ok) {
        text = r.data.script_text;
        polished = true;
        draftedBy = `${r.model} (${PROMPT_REF})`;
      } else reason = `polish rejected: ${ok.why}`;
    } catch (err) {
      reason = `polish unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else reason = 'no model key; the approved script is used as written';
  if (reason) log.info('script polish skipped', { reason });

  const parsed = scriptAcceptable(text, punchline, maxWords, cb);
  if (!parsed.ok) throw new Error(`the approved script is not speakable: ${parsed.why}`);
  const structureHash = createHash('sha256')
    .update(`${b.structure_variant}|${parsed.lines.map((l) => l.speaker).join(',')}`)
    .digest('hex')
    .slice(0, 16);

  const { data: script, error: sErr } = await db
    .from('scripts')
    .insert({
      concept_id: concept.id,
      hook: parsed.lines[0].text,
      beats: { lines: parsed.lines, beat_sheet: b.beat_sheet, punchline } as unknown as Json,
      vo_text: parsed.voText,
      drafted_by: draftedBy,
      draft_raw: text,
      structure_hash: structureHash,
      hook_pattern: b.hook_archetype,
      hook_pattern_version: 'bureau-v1',
    })
    .select('id')
    .single();
  if (sErr || !script) throw new Error(`script insert failed: ${sErr?.message}`);
  await db.from('episodes').update({ script_id: script.id, concept_id: concept.id, updated_at: new Date().toISOString() }).eq('id', episodeId);
  return { scriptId: script.id, polished, reason };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Shot list → lines → cap
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Give each planned shot a contiguous run of lines, in order, every line covered once.
 * Lines are distributed by the shots' estimated durations against the lines' lengths.
 * More shots than lines → the surplus is dropped (shortest first), never a shot with no line.
 */
export function bindShotsToLines(shots: PlannedShot[], lines: ScriptLine[]): { shot: PlannedShot; first: number; last: number }[] {
  if (!lines.length) return [];
  let planned = shots.length ? [...shots] : [];
  while (planned.length > lines.length) {
    const i = planned.reduce((m, s, k, a) => (s.duration_s < a[m].duration_s ? k : m), 0);
    planned = planned.filter((_, k) => k !== i);
  }
  const totalD = planned.reduce((n, s) => n + s.duration_s, 0);
  const totalC = lines.reduce((n, l) => n + l.text.length, 0);
  const out: { shot: PlannedShot; first: number; last: number }[] = [];
  let line = 0;
  let accD = 0;
  for (const [i, s] of planned.entries()) {
    accD += s.duration_s;
    const remainingShots = planned.length - i - 1;
    const target = (accD / totalD) * totalC;
    let last = line;
    let accC = lines.slice(0, line + 1).reduce((n, l) => n + l.text.length, 0);
    while (last + 1 < lines.length - remainingShots && accC < target) {
      last++;
      accC += lines[last].text.length;
    }
    if (i === planned.length - 1) last = lines.length - 1;
    out.push({ shot: s, first: line, last });
    line = last + 1;
  }
  return out;
}

/** No shot list on the brief: one overlay per line group, from the series beat templates. */
function defaultShots(series: Series, lines: number): PlannedShot[] {
  const beats = series.beat_sheet.slice(0, Math.max(1, Math.min(lines, series.beat_sheet.length)));
  return beats.map((b) => PlannedShotSchema.parse({ beat_id: b.id, route: 'overlay', description: b.purpose, duration_s: b.end_s - b.start_s, overlay: b.overlay ?? {} }));
}

export async function planShots(
  db: Db,
  episodeId: string,
  deps: { usdInrRate: number; actedBeatAvailable: boolean; log?: StepLog },
): Promise<{ shots: number; swaps: { idx: number; from: string; reason: string }[]; estimateInr: number | null }> {
  const { e, b, cb } = await loadEpisode(db, episodeId);
  if (!e.script_id) throw new Error('planShots before prepareScript');
  const { count } = await db.from('shots').select('id', { count: 'exact', head: true }).eq('script_id', e.script_id);
  if ((count ?? 0) > 0) return { shots: count ?? 0, swaps: [], estimateInr: e.estimate_inr === null ? null : Number(e.estimate_inr) };
  await setStatus(db, episodeId, 'shotlisting');

  const { data: script } = await db.from('scripts').select('beats, vo_text').eq('id', e.script_id).single();
  const lines = (script!.beats as unknown as { lines: ScriptLine[] }).lines;
  const series = cb.seriesFor(b.series);
  const fromBrief = z.array(PlannedShotSchema).safeParse(b.shot_list);
  const planned = fromBrief.success && fromBrief.data.length ? fromBrief.data : defaultShots(series, lines.length);

  // The episode's visual format (formats.ts): the approver's pick on Approvals, else the
  // series default. It routes every shot before the planner's own refusals below. Stills
  // (0021) are only offered when the channel can have them; otherwise the reason is recorded
  // and the plan is what it was before stills existed.
  const stills = await stillsAvailability(db, e.channel_id);
  const asked = formatOf({ approvedEdits: b.approved_edits, seriesFormat: series.visual_format });
  // Cartoon characters needs at least one locked sheet among the episode's cast; with none
  // every picture would have nobody in it, so it is planned as illustrated and says why
  // (picture-cast.ts — the same predicate Approvals disables the option with).
  let fmt: PlannedFormat = asked;
  if (asked.format === 'characters') {
    const avail = castAvailability(cb, episodeCastSlugs({ lead: b.lead_character, speakers: lines.map((l) => l.speaker), shotCharacters: planned.map((s) => s.characters) }));
    if (!avail.available) fmt = { format: 'illustrated', source: asked.source, requested: 'characters', fallback_reason: avail.reason };
  }
  const routed = routesForFormat(planned, fmt.format, stills.available);

  // Pre-swaps the cap fitter cannot know about. A shot the planner cannot make falls back to
  // a picture when the format draws pictures, and to the chalk overlay otherwise.
  const fallback = stills.available && fmt.format !== 'diagram' ? ('still' as const) : ('overlay' as const);
  const pre: { idx: number; from: string; reason: string; to?: string }[] = [...routed.swaps];
  const { data: chars } = await db.from('characters').select('slug, external_ref_id, reference_urls').eq('channel_id', e.channel_id);
  const withRef = new Set((chars ?? []).filter((c) => c.external_ref_id).map((c) => c.slug));
  const adjusted = routed.shots.map((s, idx) => {
    if (s.route === 'character_beat' && !(s.characters.length && s.characters.every((c) => withRef.has(c)))) {
      pre.push({ idx, from: s.route, to: fallback, reason: 'no locked reference frame for the character — it would generate a different-looking person' });
      return { ...s, route: fallback };
    }
    if (s.route === 'acted_beat' && !deps.actedBeatAvailable) {
      pre.push({ idx, from: s.route, to: fallback, reason: 'performance transfer is not configured' });
      return { ...s, route: fallback };
    }
    if (s.route === 'money_shot' && !series.money_shot_allowed) {
      pre.push({ idx, from: s.route, to: fallback, reason: `${series.name} does not allow a money shot` });
      return { ...s, route: fallback, realistic: false };
    }
    return s;
  });

  await setStatus(db, episodeId, 'estimating');
  const est = await estimateEpisode(db, { shots: adjusted, voChars: script!.vo_text.length, usdInrRate: deps.usdInrRate, channelId: e.channel_id });
  const { data: pol } = await db.from('channel_policy').select('*').eq('channel_id', e.channel_id).single();
  const fit = fitToCap(adjusted, est, {
    capInr: Number(e.kind === 'long_form' ? pol!.daily_longform_cap_inr : pol!.per_short_cap_inr),
    overlayMinShare: Number(pol!.overlay_min_share),
    characterBeatMaxS: Number(pol!.character_beat_max_s),
    moneyShotMax: pol!.money_shot_max,
  });
  const finalEst = await estimateEpisode(db, { shots: fit.shots, voChars: script!.vo_text.length, usdInrRate: deps.usdInrRate, channelId: e.channel_id });

  const lead = leadOf(cb, b.lead_character);
  const bound = bindShotsToLines(fit.shots, lines);
  const rows = bound.map(({ shot, first, last }, idx) => {
    const beat = series.beat_sheet.find((x) => x.id === shot.beat_id);
    // A still carries its overlay too: it is the shot's fallback, and its camera move.
    const overlay: OverlaySpec | null = shot.route === 'overlay' || shot.route === 'still' ? normaliseOverlay(shot.overlay ?? beat?.overlay, lead.accent_hex, idx + 1) : null;
    return {
      script_id: e.script_id!,
      idx,
      duration_s: shot.duration_s,
      description: shot.description,
      render_route: shot.route,
      character_slugs: shot.characters,
      overlay_spec: overlay as unknown as Json,
      realistic: shot.route === 'money_shot' && shot.realistic,
      beat_id: shot.beat_id ?? null,
      vo_char_start: lines[first].voStart,
      vo_char_end: lines[last].voEnd,
      status: 'pending',
    };
  });
  const { error } = await db.from('shots').insert(rows);
  if (error) throw new Error(`shots insert failed: ${error.message}`);

  const swaps = [...pre, ...fit.swaps];
  await db
    .from('episodes')
    .update({
      estimate_inr: finalEst.total_inr,
      qc: { ...(e.qc as object), plan: { swaps, unpriced: finalEst.unpriced, estimate: finalEst, stills: stills.available ? 'available' : stills.reason, format: fmt } } as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq('id', episodeId);
  return { shots: rows.length, swaps, estimateInr: finalEst.total_inr };
}

// ═════════════════════════════════════════════════════════════════════════════
// 4a. Scene stills (0021)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every `still` shot of the episode gets its image, or becomes its overlay with the reason
 * recorded. Replayable: a shot that already has a stored still is skipped, not re-paid.
 * Sequential on purpose — each still re-reads the cap after the previous one's ledger row.
 */
export async function generateStills(
  db: Db,
  episodeId: string,
  deps: StillDeps,
): Promise<{ made: number; reused: number; pictures: number; fellBack: { idx: number; reason: string }[]; partial: { idx: number; missing: number[] }[]; costInr: number }> {
  const log = deps.log ?? quiet;
  const { e, b, cb } = await loadEpisode(db, episodeId);
  const { data: shots } = await db.from('shots').select('id, idx, description, script_id, character_slugs').eq('script_id', e.script_id!).eq('render_route', 'still').order('idx');
  const spans = await pictureSpansFor(db, e.script_id!, await pictureTuning(db, e.channel_id));
  const lead = leadOf(cb, b.lead_character);
  const cast = cb.bible.characters.map((c) => ({ id: c.id, name: c.name }));
  // 'characters' format: who is drawn in each picture, from their locked sheets (picture-cast.ts).
  const withCast = plannedFormat(e.qc, { approvedEdits: b.approved_edits, seriesFormat: cb.seriesFor(b.series as never)?.visual_format }).format === 'characters';
  const castLog: { idx: number; part: number; drawn: string[]; excluded: { slug: string; reason: string }[] }[] = [];
  const total = (shots ?? []).reduce((n, s) => n + (spans.get(s.id)?.length ?? 1), 0);
  let made = 0;
  let reused = 0;
  let done = 0;
  let costInr = 0;
  const fellBack: { idx: number; reason: string }[] = [];
  const partial: { idx: number; missing: number[] }[] = [];
  for (const s of shots ?? []) {
    const parts = spans.get(s.id) ?? [{ from: 0, frames: 0, narration: '' }];
    const have = await stillsByPart(db, s.id);
    const missing: number[] = [];
    let lastReason = '';
    const prompts: string[] = [];
    for (const [k, span] of parts.entries()) {
      done++;
      if (have.has(k)) {
        reused++;
        continue;
      }
      // Progress on the board: the stills step is the longest silent stretch of a run otherwise.
      await setStatus(db, episodeId, 'generating', `drawing picture ${done} of ${total}`);
      const pc = withCast ? pictureCast(cb.bible.characters, wantedFor(span.speakers, s.character_slugs)) : undefined;
      const r = await generateStillForShot(
        db,
        { shot: s, channelId: e.channel_id, premise: b.premise, cast, world: cb.bible.world, accent: lead.accent_hex, kind: e.kind === 'long_form' ? 'long_form' : 'short', part: parts.length > 1 || span.narration ? { index: k, of: parts.length, narration: span.narration } : undefined, pictureCast: pc },
        deps,
      );
      if (r.ok && withCast) castLog.push({ idx: s.idx, part: k, drawn: r.drawn, excluded: r.excluded });
      if (r.ok) {
        made++;
        costInr += r.costInr;
        prompts.push(r.prompt);
        continue;
      }
      log.error('picture not made', { idx: s.idx, part: k, reason: r.reason });
      missing.push(k);
      lastReason = r.reason;
    }
    if (missing.length === parts.length && !have.size) {
      // Not one picture for this shot: it is drawn as its overlay, and Cuts says why.
      fellBack.push({ idx: s.idx, reason: lastReason });
      await fallBackToOverlay(db, episodeId, s, lead.accent_hex, lastReason);
      continue;
    }
    // Some pictures missing: the ones that exist stretch to cover the shot (assembleEpisode).
    if (missing.length) partial.push({ idx: s.idx, missing });
    await db.from('shots').update({ status: 'ready', compiled_params: { still_prompts: prompts, pictures: parts.length } as Json, compiled_at: new Date().toISOString() }).eq('id', s.id);
  }
  if (castLog.length) {
    // Who was drawn in each picture and who was left out, where Cuts reads the plan.
    const { data: cur } = await db.from('episodes').select('qc').eq('id', episodeId).single();
    const qc = (cur?.qc ?? {}) as { plan?: Record<string, unknown> } & Record<string, unknown>;
    const prev = ((qc.plan?.cast as typeof castLog | undefined) ?? []).filter((x) => !castLog.some((y) => y.idx === x.idx && y.part === x.part));
    await db.from('episodes').update({ qc: { ...qc, plan: { ...(qc.plan ?? {}), cast: [...prev, ...castLog].sort((a, b2) => a.idx - b2.idx || a.part - b2.part) } } as unknown as Json }).eq('id', episodeId);
  }
  return { made, reused, pictures: total, fellBack, partial, costInr: Math.round(costInr * 100) / 100 };
}

/**
 * Every still shot's picture spans (formats.ts), from the timed shot list and the VO words —
 * the one computation the stills step and the assembler share, so they cannot disagree about
 * where a picture changes. A shot whose duration is still an estimate gets one picture.
 * `pictures` is the channel's setting (`pictureTuning`); both callers read it the same way.
 */
export async function pictureSpansFor(db: Db, scriptId: string, pictures: PictureTuning): Promise<Map<string, PictureSpan[]>> {
  const { data: shots } = await db.from('shots').select('id, idx, render_route, duration_s, duration_source, vo_char_start, vo_char_end').eq('script_id', scriptId).order('idx');
  const out = new Map<string, PictureSpan[]>();
  if (!shots?.length) return out;
  const { data: takes } = await db.from('vo_takes').select('chunk_idx, word_timings, offset_s, text_in, duration_s').eq('script_id', scriptId).eq('language', 'en').order('chunk_idx');
  const { data: script } = await db.from('scripts').select('beats').eq('id', scriptId).maybeSingle();
  const lines = ((script?.beats ?? {}) as { lines?: ScriptLine[] }).lines ?? [];
  const speakerOf = new Map(lines.map((l) => [l.idx, l.speaker]));
  const words: WordTiming[] = (takes ?? []).flatMap((t) => shiftBy(takeWords(t), Number(t.offset_s)));
  const timed = shots.every((s) => s.duration_source === 'derived_from_vo');
  const frames = shotFrames(shots.map((s) => Number(s.duration_s)));
  let start = 0;
  for (const [i, s] of shots.entries()) {
    if (s.render_route === 'still') {
      const spans = timed ? pictureSpans({ startFrame: start, frames: frames[i] }, picturesFor(Number(s.duration_s), pictures), words, FPS) : [{ from: 0, frames: frames[i], narration: '' }];
      out.set(
        s.id,
        spans.map((sp) => ({
          ...sp,
          speakers: timed
            ? speakersByTime((start + sp.from) / FPS, (start + sp.from + sp.frames) / FPS, takes ?? [], speakerOf)
            : speakersByText(s.vo_char_start, s.vo_char_end, lines),
        })),
      );
    }
    start += frames[i];
  }
  return out;
}

/** Speakers whose take overlaps [a, b) seconds by at least a quarter second, longest first. */
function speakersByTime(a: number, b: number, takes: readonly { chunk_idx: number; offset_s: number | string; duration_s: number | string | null }[], speakerOf: ReadonlyMap<number, string>): string[] {
  const total = new Map<string, number>();
  for (const t of takes) {
    const who = speakerOf.get(t.chunk_idx);
    const off = Number(t.offset_s);
    const dur = t.duration_s === null ? null : Number(t.duration_s);
    if (!who || dur === null || !Number.isFinite(off) || !Number.isFinite(dur)) continue;
    const overlap = Math.min(b, off + dur) - Math.max(a, off);
    if (overlap > 0) total.set(who, (total.get(who) ?? 0) + overlap);
  }
  return [...total.entries()].filter(([, s]) => s >= 0.25).sort((x, y) => y[1] - x[1]).map(([w]) => w);
}

/** Before the voice is timed: the speakers of the lines the shot covers, by character offset. */
function speakersByText(from: number | null, to: number | null, lines: readonly ScriptLine[]): string[] {
  if (from === null || to === null) return [];
  const total = new Map<string, number>();
  for (const l of lines) {
    const overlap = Math.min(to, l.voEnd) - Math.max(from, l.voStart);
    if (overlap > 0) total.set(l.speaker, (total.get(l.speaker) ?? 0) + overlap);
  }
  return [...total.entries()].sort((x, y) => y[1] - x[1]).map(([w]) => w);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Generation fan-out
// ═════════════════════════════════════════════════════════════════════════════

export function fillTemplate(template: string, vars: { description: string; intent: string; duration: number }): string {
  return template
    .replace(/\{\{?\s*description\s*\}?\}/g, vars.description)
    .replace(/\{\{?\s*intent\s*\}?\}/g, vars.intent)
    .replace(/\{\{?\s*duration\s*\}?\}/g, String(vars.duration));
}

export async function enqueueGeneration(db: Db, episodeId: string, deps: { usdInrRate: number }): Promise<{ queued: number; refused: string[] }> {
  const { e, b, cb } = await loadEpisode(db, episodeId);
  const { data: shots } = await db
    .from('shots')
    .select('id, idx, render_route, duration_s, duration_source, description, character_slugs, realistic')
    .eq('script_id', e.script_id!)
    .order('idx');
  const generated = (shots ?? []).filter((s) => isVideoRoute(s.render_route));
  const refused: string[] = [];
  let queued = 0;
  const { data: chars } = await db.from('characters').select('slug, reference_urls, external_ref_id').eq('channel_id', e.channel_id);
  for (const s of generated) {
    if (s.duration_source !== 'derived_from_vo') {
      // The same refusal stage 5 makes: never generate at a guessed duration.
      refused.push(`shot ${s.idx}: duration is still an estimate`);
      continue;
    }
    const route = s.render_route as Exclude<RenderRoute, 'overlay'>;

    const recipe = await recipeForRoute(db, route);
    if (!recipe) {
      refused.push(`shot ${s.idx}: no active recipe for ${route}`);
      continue;
    }
    const duration = Number(s.duration_s);
    const est = await estimateEpisode(db, { shots: [{ route, description: s.description, duration_s: duration, characters: s.character_slugs, realistic: s.realistic }], voChars: 0, usdInrRate: deps.usdInrRate, channelId: e.channel_id });
    if (est.shots[0].inr === null) {
      refused.push(`shot ${s.idx}: unpriced (${est.shots[0].basis})`);
      continue;
    }
    const ref = (chars ?? []).find((c) => c.slug !== null && s.character_slugs.includes(c.slug));
    if (route === 'character_beat' && !ref?.external_ref_id) {
      // planShots already swaps these to overlays; this is the same refusal at the consumer,
      // so a shot that reached here some other way cannot generate a stranger and bill for it.
      refused.push(`shot ${s.idx}: no locked reference frame for ${s.character_slugs.join(', ') || 'its character'}`);
      continue;
    }
    // The billed length — the same arithmetic the estimate above priced (drivers/generation).
    const billed = billedSeconds(recipe.driver, recipe.model, duration, Number(recipe.params.max_duration_s) || undefined);
    const params: Record<string, unknown> = {
      ...recipe.params,
      prompt: `${fillTemplate(recipe.template, { description: s.description, intent: b.premise, duration })}. ${cb.bible.world.style_rules[0]}`,
      negative_prompt: cb.bible.world.negative_prompt,
      duration_s: billed,
      aspect_ratio: '9:16',
      // Stored as the bible wrote it (`storage:<key>` or https); the dispatcher resolves it to
      // a short-lived URL at submit time and never writes the resolved URL back.
      ...(route === 'character_beat' ? { [REFERENCE_FRAME_PARAM]: ref!.external_ref_id } : {}),
    };
    const { error } = await db.from('gen_jobs').insert({
      episode_id: e.id,
      shot_id: s.id,
      render_route: route,
      provider: recipe.driver,
      model: recipe.model,
      endpoint: (recipe.params.endpoint as string | undefined) ?? null,
      params: params as Json,
      prompt_id: recipe.id,
      duration_s: duration,
      estimate_inr: est.shots[0].inr,
      idempotency_key: `ep:${e.id}:${s.id}:0`,
    });
    if (error && !/duplicate key|unique/i.test(error.message)) throw new Error(`gen_job insert failed: ${error.message}`);
    if (!error) queued++;
    await db.from('shots').update({ status: 'generating', compiled_params: params as Json, prompt_id: recipe.id, compiled_at: new Date().toISOString() }).eq('id', s.id);
  }
  return { queued, refused };
}

/** True when every job of the episode is terminal (none queued, claimed, submitted, throttled). */
export async function generationSettled(db: Db, episodeId: string): Promise<{ settled: boolean; open: number; failed: number }> {
  const { data } = await db.from('gen_jobs').select('status').eq('episode_id', episodeId);
  const open = (data ?? []).filter((j) => ['queued', 'claimed', 'submitted', 'throttled'].includes(j.status)).length;
  const failed = (data ?? []).filter((j) => j.status === 'failed').length;
  return { settled: open === 0, open, failed };
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Assembly — three layers
// ═════════════════════════════════════════════════════════════════════════════

export interface AssembleDeps {
  usdInrRate: number;
  presign(key: string): Promise<string>;
  putBytes(key: string, body: Readable): Promise<number>;
  render(input: { props: BureauVideoProps; durationInFrames: number; outputPath: string; serveUrl?: string; onProgress?: (done: number, total: number) => void }): Promise<{ ok: true; frames: number; serveUrl: string } | { ok: false; code: string; detail: string }>;
  /** `targetLufs` is the channel's Settings → Assembly value (readTuning). */
  normaliseAudio(input: string, output: string, targetLufs: number): Promise<void>;
  download(url: string, out: string): Promise<void>;
  log?: StepLog;
}

/** Frames per shot, so the shots tile the track exactly and the total equals round(total × fps). */
export function shotFrames(durations: number[], fps = FPS): number[] {
  const total = Math.round(durations.reduce((n, d) => n + d, 0) * fps);
  const out: number[] = [];
  let acc = 0;
  let accFrames = 0;
  for (const d of durations) {
    acc += d;
    const upto = Math.round(acc * fps);
    out.push(upto - accFrames);
    accFrames = upto;
  }
  out[out.length - 1] += total - accFrames;
  return out;
}

export function toSrt(cues: CaptionCue[]): string {
  const ts = (s: number) => {
    const ms = Math.round(s * 1000);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.startS)} --> ${ts(c.endS)}\n${c.text}\n`).join('\n');
}

/**
 * `layers` picks which of the three to render. The run renders only the composite before the cut
 * gate — it is what the reviewer watches — and the clean master and caption layer after approval,
 * for the bundle. S001's first full render (07-Oct) spent ~16 min on the first two layers and
 * over 40 on the ProRes caption layer, holding the cut back the whole time. Default: all three.
 */
export async function assembleEpisode(
  db: Db,
  episodeId: string,
  deps: AssembleDeps,
  opts: {
    layers?: readonly ('composite' | 'clean_master' | 'caption_layer')[];
    /** A redraw (redraw.ts) re-renders while the episode stays awaiting_cut: progress goes to status_detail only. */
    keepStatus?: boolean;
    /** Appended to the render keys, so a re-render never overwrites the bytes an earlier render row points at. */
    keyTag?: string;
  } = {},
): Promise<{ ok: true; compositeRenderId: string | null; masterRenderId: string | null; captionRenderId: string | null; frames: number } | { ok: false; code: string; detail: string }> {
  const layers = opts.layers ?? (['composite', 'clean_master', 'caption_layer'] as const);
  const log = deps.log ?? quiet;
  const { e, b, cb } = await loadEpisode(db, episodeId);
  if (!opts.keepStatus) await setStatus(db, episodeId, 'assembling');
  const { data: shots } = await db.from('shots').select('id, idx, render_route, duration_s, duration_source, overlay_spec').eq('script_id', e.script_id!).order('idx');
  if (!shots?.length) return { ok: false, code: 'no_shots', detail: 'nothing to assemble' };
  if (shots.some((s) => s.duration_source !== 'derived_from_vo')) {
    return { ok: false, code: 'durations_unmeasured', detail: 'shot durations are still estimates — the voice stage has not timed them' };
  }

  const { data: takes } = await db.from('vo_takes').select('chunk_idx, word_timings, offset_s, text_in, duration_s').eq('script_id', e.script_id!).eq('language', 'en').order('chunk_idx');
  const words: WordTiming[] = (takes ?? []).flatMap((t) => shiftBy(takeWords(t), Number(t.offset_s)));
  const voice = e.voice_detail as { vo_asset_id?: string } | null;
  if (!voice?.vo_asset_id) return { ok: false, code: 'no_vo', detail: 'the episode has no VO track' };
  const { data: voAsset } = await db.from('assets').select('storage_key').eq('id', voice.vo_asset_id).single();

  const durations = shots.map((s) => Number(s.duration_s));
  const frames = shotFrames(durations);
  const total = frames.reduce((n, f) => n + f, 0);
  // Settings → Generation (pictures) and → Assembly (loudness, text, hook): read once, at the
  // render, so a change applies to the next render and never to one in flight.
  const tuning = (await readTuning(db, e.channel_id)).values;
  const spans = await pictureSpansFor(db, e.script_id!, tuning);

  const bureauShots: BureauShot[] = [];
  const lead = leadOf(cb, b.lead_character);
  for (const [i, s] of shots.entries()) {
    if (s.render_route === 'overlay' || !s.render_route) {
      bureauShots.push({ type: 'overlay', overlay: s.overlay_spec as unknown as OverlaySpec, frames: frames[i] });
      continue;
    }
    if (s.render_route === 'still') {
      const spec = (s.overlay_spec as unknown as OverlaySpec | null) ?? normaliseOverlay({}, lead.accent_hex, i + 1);
      const have = await stillsByPart(db, s.id);
      if (!have.size) {
        // Never made (or lost): drawn as its overlay, and the swap is recorded for Cuts.
        log.error('still shot has no image; drawing its overlay', { idx: s.idx });
        await fallBackToOverlay(db, episodeId, s, lead.accent_hex, 'no still was stored for this shot at assembly');
        bureauShots.push({ type: 'overlay', overlay: spec, frames: frames[i] });
        continue;
      }
      // One sequence per picture, cut where the stills step drew them (pictureSpansFor). A
      // missing picture's stretch goes to the one before it (or after, for the first), so the
      // shot's frame count — and with it the sync to the voice — never changes.
      const parts = spans.get(s.id) ?? [{ from: 0, frames: frames[i], narration: '' }];
      const runs: { part: number; frames: number }[] = [];
      for (const [k, span] of parts.entries()) {
        if (have.has(k)) runs.push({ part: k, frames: span.frames });
        else if (runs.length) runs[runs.length - 1].frames += span.frames;
        else runs.push({ part: [...have.keys()].sort((x, y) => x - y)[0], frames: span.frames });
      }
      for (const [j, r] of runs.entries()) {
        bureauShots.push({ type: 'still', url: await deps.presign(have.get(r.part)!.storageKey), camera: spec.camera, accent: spec.accent, seed: spec.seed + j * 3, frames: r.frames });
      }
      continue;
    }
    const { data: gen } = await db.from('generations').select('id').eq('shot_id', s.id).eq('status', 'succeeded').order('completed_at', { ascending: false }).limit(1).maybeSingle();
    const { data: asset } = gen ? await db.from('assets').select('storage_key').eq('generation_id', gen.id).not('normalized_at', 'is', null).limit(1).maybeSingle() : { data: null };
    if (!asset) {
      // A generated shot that never produced a clip is drawn as its overlay rather than holding
      // the episode; the swap is recorded and shown on the Cuts page.
      log.error('generated shot has no clip; drawing an overlay in its place', { idx: s.idx });
      bureauShots.push({ type: 'overlay', overlay: normaliseOverlay({}, lead.accent_hex, i + 1), frames: frames[i] });
      continue;
    }
    bureauShots.push({ type: 'clip', url: await deps.presign(asset.storage_key), frames: frames[i] });
  }

  const work = await mkdtemp(join(tmpdir(), 'kiln-bureau-asm-'));
  try {
    // Loudness to the channel's target (default −14 LUFS) before the render, not after: the
    // composite is the cut Sahil hears.
    const lufs = tuning.loudnessLufs;
    const lufsTag = String(Math.abs(lufs)).replace('.', '_');
    const rawVo = join(work, 'vo.m4a');
    const loudVo = join(work, `vo-${lufsTag}.m4a`);
    await deps.download(await deps.presign(voAsset!.storage_key), rawVo);
    await deps.normaliseAudio(rawVo, loudVo, lufs);
    const loudKey = `vo/${e.script_id}/en/track-${lufsTag}lufs.m4a`;
    await deps.putBytes(loudKey, createReadStream(loudVo));
    const audioUrl = await deps.presign(loudKey);

    const safe = SAFE_AREAS.shorts_9x16;
    const safeBox = { x: Math.round(WIDTH * safe.left), y: Math.round(HEIGHT * safe.top), width: Math.round(WIDTH * (1 - safe.left - safe.right)), height: Math.round(HEIGHT * (1 - safe.top - safe.bottom)) };
    const cues = captionCues(words);
    const titles = (b.titles as { text: string }[]) ?? [];
    const hook = { text: (titles[0]?.text ?? b.premise).toUpperCase(), startS: 0, endS: Math.min(tuning.hookS, total / FPS) };
    const base: Omit<BureauVideoProps, 'layer'> = {
      shots: bureauShots,
      audioUrl,
      musicUrl: null,
      cues,
      hook,
      safeBox,
      textScale: { caption: tuning.captionScale, hook: tuning.hookScale },
    };

    const variantGroup = randomUUID();
    const ids: Record<string, string> = {};
    let serveUrl: string | undefined;
    for (const layer of layers) {
      const ext = layer === 'caption_layer' ? 'webm' : 'mp4';
      const out = join(work, `${layer}.${ext}`);
      // Progress the screens can read: rendering is the longest step (minutes per layer), and a
      // status that says only "assembling" for twenty minutes cannot be told from a hung run.
      // Throttled to one write per ~5 s; a failed write never fails the render.
      const label = { composite: 'video', clean_master: 'clean copy', caption_layer: 'caption layer' }[layer];
      const n = layers.indexOf(layer) + 1;
      let lastWrite = 0;
      const onProgress = (done: number, of: number) => {
        const now = Date.now();
        if (now - lastWrite < 5_000 && done < of) return;
        lastWrite = now;
        void db
          .from('episodes')
          .update({ status_detail: `rendering ${label} (${n} of ${layers.length}) · ${Math.round((done / Math.max(1, of)) * 100)}% · ${done}/${of} frames`, updated_at: new Date().toISOString() })
          .eq('id', episodeId)
          .then(() => undefined, () => undefined);
      };
      onProgress(0, total);
      const r = await deps.render({ props: { ...base, layer }, durationInFrames: total, outputPath: out, serveUrl, onProgress });
      if (!r.ok) return r;
      serveUrl = r.serveUrl;
      const key = `renders/${episodeId}/${layer}-en${opts.keyTag ? `-${opts.keyTag}` : ''}.${ext}`;
      const bytes = await deps.putBytes(key, createReadStream(out));
      const { data: asset } = await db.from('assets').insert({ kind: 'video', storage_key: key, bytes, duration_s: total / FPS, width: WIDTH, height: HEIGHT, meta: { layer, language: 'en' } as Json }).select('id').single();
      const { data: render } = await db
        .from('renders')
        .insert({ script_id: e.script_id!, variant_group_id: variantGroup, variant_label: layer, format: 'shorts_9x16', width: WIDTH, height: HEIGHT, duration_s: total / FPS, asset_id: asset!.id, status: 'ready', kind: 'final', layer, language: 'en' })
        .select('id')
        .single();
      ids[layer] = render!.id;
    }
    const srtKey = `renders/${episodeId}/captions-en.srt`;
    const srtPath = join(work, 'captions-en.srt');
    await writeFile(srtPath, toSrt(cues));
    await deps.putBytes(srtKey, createReadStream(srtPath));
    await db.from('assets').insert({ kind: 'caption', storage_key: srtKey, meta: { language: 'en', format: 'srt' } as Json });

    await db
      .from('episodes')
      .update({ ...(ids.composite ? { final_render_id: ids.composite } : {}), ...(ids.clean_master ? { master_render_id: ids.clean_master } : {}), updated_at: new Date().toISOString(), voice_detail: { ...(voice as object), loud_key: loudKey, srt_key: srtKey } as unknown as Json })
      .eq('id', episodeId);
    return { ok: true, compositeRenderId: ids.composite ?? null, masterRenderId: ids.clean_master ?? null, captionRenderId: ids.caption_layer ?? null, frames: total };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. The publish bundle
// ═════════════════════════════════════════════════════════════════════════════

export async function bundleEpisode(db: Db, episodeId: string): Promise<{ publicationId: string; slotTime: string | null }> {
  const { e, b, cb } = await loadEpisode(db, episodeId);
  if (e.publication_id) return { publicationId: e.publication_id, slotTime: null };
  if (!e.review_id || !e.final_render_id) throw new Error('bundle before the cut was approved');

  const { data: render } = await db.from('renders').select('asset_id').eq('id', e.final_render_id).single();
  const { data: asset } = await db.from('assets').select('storage_key').eq('id', render!.asset_id!).single();
  const { data: master } = e.master_render_id ? await db.from('renders').select('asset_id').eq('id', e.master_render_id).single() : { data: null };
  const { data: masterAsset } = master?.asset_id ? await db.from('assets').select('storage_key').eq('id', master.asset_id).single() : { data: null };
  const { data: shots } = await db.from('shots').select('realistic').eq('script_id', e.script_id!);
  const realistic = (shots ?? []).some((s) => s.realistic);
  // Settings → Publishing (0049): madeForKids and when the altered/synthetic flag is set.
  const { values: disclosure } = await readTuning(db, e.channel_id);
  const synthetic = syntheticFlag(disclosure.syntheticDisclosure, realistic);
  const { data: slot } = e.slot_id ? await db.from('v_slot_status').select('publish_at').eq('id', e.slot_id).maybeSingle() : { data: null };
  const titles = (b.titles as { text: string; hook_archetype: string }[]) ?? [];
  const fact = b.fact as { claim: string; source_url: string; source_title?: string };
  const series = cb.seriesFor(b.series);
  const voice = (e.voice_detail ?? {}) as { srt_key?: string };
  const { data: ch } = await db.from('channels').select('name').eq('id', e.channel_id).single();
  const channelName = ch?.name ?? cb.bible.world.name;
  const publishing = cb.bible.publishing;
  const hashtags = (publishing?.hashtags ?? []).slice(0, 2).map((h) => `#${h}`).join(' ');

  const description = [
    b.premise,
    '',
    `The real bit: ${fact.claim}`,
    `Source: ${fact.source_url}`,
    '',
    `${series.name} · ${channelName}`,
    e.kind === 'long_form' ? hashtags : `#Shorts ${hashtags}`.trim(),
  ].join('\n');
  const tags = [...new Set([channelName.toLowerCase(), series.name.toLowerCase(), ...(publishing?.tags ?? []), ...((b.tags as string[]) ?? []).filter((t) => !t.includes(':'))])].slice(0, 15);

  const bundle = {
    video_key: asset!.storage_key,
    files: { clean_master: masterAsset?.storage_key ?? null, captions_srt: voice.srt_key ?? null },
    title: titles[0]?.text ?? b.premise.slice(0, 90),
    alternate_titles: titles.slice(1).map((t) => t.text),
    description,
    tags,
    made_for_kids: disclosure.madeForKids,
    contains_synthetic_media: synthetic,
    pinned_comment: b.pinned_comment,
    category: publishing?.category ?? 'Entertainment',
    slot_id: e.slot_id,
    slot_time: slot?.publish_at ?? null,
    note: 'Upload API unaudited: schedule in YouTube Studio, then call mark_scheduled with the time.',
  };
  const { data: pub, error } = await db
    .from('publications')
    .insert({
      render_id: e.final_render_id,
      channel_id: e.channel_id,
      review_id: e.review_id,
      title: bundle.title,
      description,
      tags,
      made_for_kids: disclosure.madeForKids,
      altered_content_disclosed: synthetic,
      platform: 'youtube',
      bundle: bundle as unknown as Json,
      episode_id: e.id,
      slot_id: e.slot_id,
      status: 'draft',
      idempotency_key: `bundle:${e.id}`,
    })
    .select('id')
    .single();
  if (error || !pub) throw new Error(`publication insert failed: ${error?.message}`);
  await db.from('episodes').update({ publication_id: pub.id, status: 'bundled', updated_at: new Date().toISOString() }).eq('id', episodeId);
  return { publicationId: pub.id, slotTime: bundle.slot_time };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Voice — the step wrapper (the stage itself is ./voice.ts)
// ═════════════════════════════════════════════════════════════════════════════

export async function voiceStep(
  db: Db,
  episodeId: string,
  deps: Omit<import('./voice').VoiceDeps, 'db' | 'bible' | 'overrides'> & {
    /** Set when this pass is the voice overflow (O5): why the episode left the main model. */
    overflowReason?: string;
  },
): Promise<import('./voice').VoiceOutcome> {
  const { e, b, cb } = await loadEpisode(db, episodeId);
  const existing = e.voice_detail as { vo_asset_id?: string; total_s?: number; lines?: number; chars?: number; cost_inr?: number; unaligned?: number; model?: string } | null;
  const pace = paceOf({ approvedEdits: b.approved_edits, seriesPace: cb.seriesFor(b.series as Series['id']).voice_pace });
  if (existing?.vo_asset_id) {
    // Replayed: the stage already ran and paid. Its own figures, not zeros.
    return { ok: true, lines: existing.lines ?? 0, totalS: existing.total_s ?? 0, voAssetId: existing.vo_asset_id, chars: existing.chars ?? 0, costInr: existing.cost_inr ?? 0, shotsTimed: 0, reused: existing.lines ?? 0, unaligned: existing.unaligned ?? null, model: existing.model ?? DEFAULT_TTS_MODEL, respoken: 0 };
  }
  await setStatus(db, episodeId, 'voicing');
  const { runEpisodeVoice } = await import('./voice');
  const { values: tuning } = await readTuning(db, e.channel_id);
  const { overflowReason, ...voiceDeps } = deps;
  const r = await runEpisodeVoice(e.script_id!, {
    db,
    bible: cb,
    overrides: await voiceOverrides(db, e.channel_id),
    tempo: pace.tempo,
    gaps: { lineGapS: tuning.lineGapS, tailS: tuning.tailS },
    ...voiceDeps,
  });
  if (r.ok) {
    // `model` always, `overflow` only when this pass was the overflow — Cuts says "voiced on
    // the second model — main model's daily limit" from these two fields and nothing else.
    const overflow = overflowReason ? { overflow: true, overflow_reason: overflowReason, respoken_lines: r.respoken } : { overflow: false };
    await db
      .from('episodes')
      .update({ voice_detail: { vo_asset_id: r.voAssetId, total_s: r.totalS, lines: r.lines, chars: r.chars, cost_inr: r.costInr, unaligned: r.unaligned, pace: pace.pace, tempo: pace.tempo, pace_source: pace.source, model: r.model, ...overflow } as unknown as Json, updated_at: new Date().toISOString() })
      .eq('id', episodeId);
  }
  return r;
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. QC on generated clips
// ═════════════════════════════════════════════════════════════════════════════

export interface QcDeps {
  presign(key: string): Promise<string>;
  download(url: string, out: string): Promise<void>;
  signal(path: string, durationS: number): Promise<{ passed: boolean; reasons: string[] }>;
  /** Absent → the clip is "unscored" and flagged for the human, never passed silently. */
  vision?(input: { path: string; referenceUrl: string | null; description: string }): Promise<{ passed: boolean; reasons: string[]; scores: unknown }>;
  log?: StepLog;
}

export async function qcClips(db: Db, episodeId: string, deps: QcDeps): Promise<{ checked: number; rerolled: number; flagged: number }> {
  const { insertReroll } = await import('./episodes');
  const { e } = await loadEpisode(db, episodeId);
  await setStatus(db, episodeId, 'qc');
  const qc = { ...((e.qc ?? {}) as Record<string, unknown>) };
  const clips = { ...((qc.clips ?? {}) as Record<string, unknown>) };
  const { data: jobs } = await db.from('gen_jobs').select('id, shot_id, generation_id, status, reroll_index').eq('episode_id', episodeId).eq('status', 'succeeded');
  const { data: chars } = await db.from('characters').select('slug, reference_urls, external_ref_id').eq('channel_id', e.channel_id);
  let checked = 0;
  let rerolled = 0;
  let flagged = 0;
  const work = await mkdtemp(join(tmpdir(), 'kiln-qc-'));
  try {
    for (const job of jobs ?? []) {
      if (clips[job.id]) continue; // already judged
      const { data: asset } = await db.from('assets').select('storage_key, duration_s').eq('generation_id', job.generation_id!).not('normalized_at', 'is', null).limit(1).maybeSingle();
      if (!asset) continue;
      const { data: shot } = await db.from('shots').select('id, idx, description, character_slugs').eq('id', job.shot_id!).single();
      const local = join(work, `${job.id}.mp4`);
      await deps.download(await deps.presign(asset.storage_key), local);
      const signal = await deps.signal(local, Number(asset.duration_s));
      const frame = (chars ?? []).find((c) => c.slug !== null && shot!.character_slugs.includes(c.slug))?.external_ref_id ?? null;
      const ref = frame === null ? null : frame.startsWith(STORAGE_REF_PREFIX) ? await deps.presign(frame.slice(STORAGE_REF_PREFIX.length)) : frame;
      const vision = deps.vision ? await deps.vision({ path: local, referenceUrl: ref, description: shot!.description }).catch((err) => ({ passed: false, reasons: [`vision unavailable: ${err instanceof Error ? err.message : String(err)}`], scores: null })) : null;
      const reasons = [...signal.reasons, ...(vision ? vision.reasons : ['unscored: no vision QC configured'])];
      const passed = signal.passed && (vision?.passed ?? false);
      checked++;
      let action: string = passed ? 'pass' : 'flag';
      if (!passed && vision !== null) {
        try {
          await insertReroll(db, { channelId: e.channel_id, episodeId, shotId: shot!.id, shotIdx: shot!.idx, note: `QC: ${reasons.join('; ')}` });
          action = 'reroll';
          rerolled++;
        } catch {
          action = 'flag'; // re-rolls exhausted: to the cut as it is, flagged
        }
      }
      if (action === 'flag') flagged++;
      clips[job.id] = { shot_idx: shot!.idx, reroll_index: job.reroll_index, signal, vision: vision?.scores ?? null, passed, reasons, action };
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await db.from('episodes').update({ qc: { ...qc, clips } as unknown as Json, updated_at: new Date().toISOString() }).eq('id', episodeId);
  return { checked, rerolled, flagged };
}
