import { z } from 'zod';

/**
 * Visual formats — the template an episode is made in, chosen at the start (07-Oct-2026).
 *
 * S003's cut was sent back because its drawn diagrams did not show the topic. Fixing the
 * picture after the cut is the expensive place to decide what kind of video it is; the brief
 * is the cheap one. So every series has a default format, and the approver can override it
 * per episode on Approvals, before anything is spent. The format decides how `planShots`
 * routes every shot, and the estimate on Approvals is priced on that routing.
 *
 *   illustrated  a generated picture of the topic for every shot, a new one about every
 *                seconds_per_picture seconds (Settings → Generation; default SECONDS_PER_PICTURE) of narration — the default
 *   diagram      the in-house chalk diagrams only: nothing generated but the voice
 *   cinematic    generated video where a usable recipe exists; pictures everywhere else
 *   characters   pictures like illustrated, with the cast IN them — each drawn from its locked
 *                character sheet (character-sheets.ts), so a character looks the same in
 *                every picture. A character with no locked sheet is left out of the picture,
 *                and an episode with none at all is planned as illustrated (07-Oct-2026)
 *   engineered   "3D explainer" (0052): a clean photoreal 3D-render picture per beat, fast cuts,
 *                the hero objects drawn from per-episode reference sheets, clips animated from
 *                the picture on the action beats (`motion`), and a graphics layer we draw —
 *                stage badges, verdicts, callouts, meters, keyword captions (engineered.ts)
 *
 * ── Where the choice lives ───────────────────────────────────────────────────
 *
 * A series' default is `visual_format` in its bible document (absent → illustrated). The
 * approver's override is `briefs.approved_edits.visual_format`: the approve function already
 * stores the edits jsonb and writes it to the authorship log, so the choice is recorded with
 * the decision it belongs to, and no migration was needed to ship it.
 */

export const VISUAL_FORMATS = ['illustrated', 'diagram', 'cinematic', 'characters', 'engineered'] as const;
export type VisualFormat = (typeof VISUAL_FORMATS)[number];
export const VisualFormatSchema = z.enum(VISUAL_FORMATS);
export const DEFAULT_VISUAL_FORMAT: VisualFormat = 'illustrated';

export const FORMAT_INFO: Record<VisualFormat, { label: string; blurb: string }> = {
  illustrated: { label: 'Illustrated', blurb: 'Cartoon pictures of the topic, a new one every ~6 s of narration' },
  diagram: { label: 'Chalk diagrams', blurb: 'In-house drawn diagrams; only the voice is generated' },
  cinematic: { label: 'Cinematic', blurb: 'Generated video where a recipe is active; pictures elsewhere' },
  characters: { label: 'Cartoon characters', blurb: 'The cast appears as consistent cartoon characters, a new picture every ~6 s' },
  engineered: { label: '3D explainer', blurb: 'Realistic 3D renders, cutaways, badges and meters — how a thing works, attempt by attempt' },
};

/** Formats whose every shot is a picture (routesForFormat). They price identically. */
export const PICTURE_FORMATS: readonly VisualFormat[] = ['illustrated', 'characters'];

/**
 * Narration seconds each picture covers in an illustrated shot — the DEFAULT. A channel's own
 * value is `channel_policy.seconds_per_picture` (0049), read through `readTuning`
 * (src/lib/settings/tuning.ts); this constant applies only before 0049 is pasted.
 */
export const SECONDS_PER_PICTURE = 6;
/** A shot never gets more than this many pictures, however long it runs — the default, as above. */
export const MAX_PICTURES_PER_SHOT = 4;

/**
 * How many pictures a still shot of this length gets. Pure; shared by the estimate, the stills
 * step and the assembler. The tuning is required, not defaulted: every caller passes the
 * channel's values from `pictureTuning`, so none of them can quietly use the constant while
 * another uses the setting.
 */
export function picturesFor(durationS: number, t: { secondsPerPicture: number; maxPicturesPerShot: number }): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return 1;
  return Math.min(t.maxPicturesPerShot, Math.max(1, Math.round(durationS / t.secondsPerPicture)));
}

export type FormatSource = 'episode' | 'series' | 'default';

/** The format an episode is made in, and where that came from. Never throws on a bad stored value. */
export function formatOf(input: { approvedEdits?: unknown; seriesFormat?: unknown }): { format: VisualFormat; source: FormatSource } {
  const edits = input.approvedEdits && typeof input.approvedEdits === 'object' ? (input.approvedEdits as Record<string, unknown>) : {};
  const fromEpisode = VisualFormatSchema.safeParse(edits.visual_format);
  if (fromEpisode.success) return { format: fromEpisode.data, source: 'episode' };
  const fromSeries = VisualFormatSchema.safeParse(input.seriesFormat);
  if (fromSeries.success) return { format: fromSeries.data, source: 'series' };
  return { format: DEFAULT_VISUAL_FORMAT, source: 'default' };
}

/**
 * The routes a planned shot list takes in a format, before the planner's own refusals (no
 * reference frame, no recipe, the cap). Pure; shared by the planner and every estimate, so a
 * brief is priced on the routes its episode will actually take.
 *
 * `stillsAvailable` false (0047 not pasted, switched off, integration unverified) degrades
 * illustrated and cinematic to what the planner did before stills existed.
 */
export function routesForFormat<T extends { route: string; action?: boolean; view?: string }>(
  shots: readonly T[],
  format: VisualFormat,
  stillsAvailable: boolean,
  /** The engineered format's motion level (ignored by every other format). */
  motion: MotionLevel = DEFAULT_MOTION,
): { shots: T[]; swaps: { idx: number; from: string; to: string; reason: string }[] } {
  if (format === 'engineered') return engineeredRoutes(shots, motion, stillsAvailable);
  const swaps: { idx: number; from: string; to: string; reason: string }[] = [];
  const out = shots.map((s, idx) => {
    if (format === 'diagram') {
      if (s.route === 'overlay') return s;
      swaps.push({ idx, from: s.route, to: 'overlay', reason: 'chalk diagram format — nothing but the voice is generated' });
      return { ...s, route: 'overlay' };
    }
    if (!stillsAvailable) return s;
    if (PICTURE_FORMATS.includes(format)) {
      // 'characters' routes exactly as illustrated: the difference is inside the still prompt
      // (picture-cast.ts), so the estimate and the plan cannot disagree about its price.
      if (s.route === 'still') return s;
      if (s.route !== 'overlay') swaps.push({ idx, from: s.route, to: 'still', reason: format === 'characters' ? 'cartoon characters format — a picture with the cast drawn from their sheets instead' : 'illustrated format — a picture of the topic instead' });
      return { ...s, route: 'still' };
    }
    // cinematic: generated routes stay (the planner swaps any it cannot make); drawn ones become pictures.
    if (s.route === 'overlay') return { ...s, route: 'still' };
    return s;
  });
  return { shots: out, swaps };
}

/** The smallest stretch a picture may hold the screen, in seconds — shorter reads as a flicker. */
export const MIN_PICTURE_S = 2;

export interface PictureSpan {
  /** Frame offset inside the shot. */
  from: number;
  frames: number;
  /** The narration spoken under this picture — what the picture is drawn to show. */
  narration: string;
  /**
   * Who is speaking under this picture, longest-speaking first (character slugs). Filled by
   * `pictureSpansFor` from the timed takes; absent from the pure split. The 'characters'
   * format draws the first one in the foreground.
   */
  speakers?: string[];
}

/**
 * Where an illustrated shot changes picture, and what is said under each one. Pure and
 * deterministic, so the stills step (which draws each picture from its narration) and the
 * assembler (which cuts between them) agree without storing the split.
 *
 * `pictures` equal stretches of the shot, each boundary moved to the nearest word start within
 * a second, so a picture changes between words rather than through one. A boundary that would
 * leave a picture shorter than MIN_PICTURE_S is dropped, and the count shrinks with it.
 * Words are absolute seconds on the episode's VO timeline (`shiftBy(takeWords(...))`).
 */
export function pictureSpans(
  shot: { startFrame: number; frames: number },
  pictures: number,
  words: readonly { w: string; start: number; end: number }[],
  fps: number,
): PictureSpan[] {
  const n = Math.max(1, Math.floor(pictures));
  const minFrames = Math.round(MIN_PICTURE_S * fps);
  const startS = shot.startFrame / fps;
  const endS = (shot.startFrame + shot.frames) / fps;
  const inShot = words.filter((w) => (w.start + w.end) / 2 >= startS && (w.start + w.end) / 2 < endS);

  const cuts: number[] = [];
  for (let k = 1; k < n; k++) {
    const ideal = Math.round((shot.frames * k) / n);
    let best = ideal;
    let bestGap = fps; // within one second
    for (const w of inShot) {
      const f = Math.round(w.start * fps) - shot.startFrame;
      const gap = Math.abs(f - ideal);
      if (gap < bestGap) {
        bestGap = gap;
        best = f;
      }
    }
    const prev = cuts.length ? cuts[cuts.length - 1] : 0;
    if (best - prev >= minFrames && shot.frames - best >= minFrames) cuts.push(best);
  }

  const edges = [0, ...cuts, shot.frames];
  return edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1];
    const a = startS + from / fps;
    const b = startS + to / fps;
    const narration = inShot
      .filter((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 < b)
      .map((w) => w.w)
      .join(' ')
      .trim();
    return { from, frames: to - from, narration };
  });
}

/**
 * Voice pace — the speed the narration is heard at, part of the same template as the format
 * (Sahil, 07-Oct: S003's voice was "very very slow"). Applied to every take with ffmpeg
 * `atempo` (pitch kept) when the VO track is built, so changing it re-buys nothing.
 */
export const VOICE_PACES = { normal: 1, brisk: 1.15, fast: 1.3 } as const;
export type VoicePace = keyof typeof VOICE_PACES;
export const VoicePaceSchema = z.enum(['normal', 'brisk', 'fast']);
export const DEFAULT_VOICE_PACE: VoicePace = 'brisk';
export const PACE_INFO: Record<VoicePace, { label: string; blurb: string }> = {
  normal: { label: 'Normal', blurb: 'As the voice speaks it' },
  brisk: { label: 'Brisk', blurb: '15% faster — the Shorts default' },
  fast: { label: 'Fast', blurb: '30% faster — for dense, punchy scripts' },
};

/** The pace an episode is voiced at, and where that came from. Same precedence as formatOf. */
export function paceOf(input: { approvedEdits?: unknown; seriesPace?: unknown }): { pace: VoicePace; tempo: number; source: FormatSource } {
  const edits = input.approvedEdits && typeof input.approvedEdits === 'object' ? (input.approvedEdits as Record<string, unknown>) : {};
  const e = VoicePaceSchema.safeParse(edits.voice_pace);
  if (e.success) return { pace: e.data, tempo: VOICE_PACES[e.data], source: 'episode' };
  const s = VoicePaceSchema.safeParse(input.seriesPace);
  if (s.success) return { pace: s.data, tempo: VOICE_PACES[s.data], source: 'series' };
  return { pace: DEFAULT_VOICE_PACE, tempo: VOICE_PACES[DEFAULT_VOICE_PACE], source: 'default' };
}

// ═════════════════════════════════════════════════════════════════════════════
// Motion — the engineered format's second choice (0052)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * How much of an engineered episode moves. Sahil (08-Oct) asked for "a combination of both":
 * pictures with our camera moves everywhere, and clips — animated from the beat's own picture
 * — where something happens.
 *
 *   key   clips only on the action beats (at most KEY_MAX_CLIPS), pictures everywhere else.
 *         The default: the motion lands where the story moves, at a fraction of the price.
 *   full  a clip on every scene beat; pictures only for cutaways and diagram beats, which are
 *         explanations and read better held still under the graphics.
 *
 * Stored like the voice pace: `briefs.approved_edits.motion`, the series default in its bible
 * (`motion`), else `key`. Changing it re-routes the plan; it is priced on Approvals by the
 * same `routesForFormat` the planner calls, so the two cannot disagree.
 */
export const MOTION_LEVELS = ['key', 'full'] as const;
export type MotionLevel = (typeof MOTION_LEVELS)[number];
export const MotionLevelSchema = z.enum(MOTION_LEVELS);
export const DEFAULT_MOTION: MotionLevel = 'key';
export const MOTION_INFO: Record<MotionLevel, { label: string; blurb: string }> = {
  key: { label: 'Key moments', blurb: 'Pictures with camera moves; clips only on the action beats (≈3–4)' },
  full: { label: 'Full motion', blurb: 'Clips on most beats; pictures only for cutaways and diagrams' },
};
/** The most clips `key` plans. More action beats than this → evenly spaced among them. */
export const KEY_MAX_CLIPS = 4;
/** A brief with no beat marked as action (e.g. one written for another format) → this many, evenly spaced. */
export const KEY_FALLBACK_CLIPS = 3;

/** The motion an episode is made with, and where that came from. Same precedence as formatOf. */
export function motionOf(input: { approvedEdits?: unknown; seriesMotion?: unknown }): { motion: MotionLevel; source: FormatSource } {
  const edits = input.approvedEdits && typeof input.approvedEdits === 'object' ? (input.approvedEdits as Record<string, unknown>) : {};
  const e = MotionLevelSchema.safeParse(edits.motion);
  if (e.success) return { motion: e.data, source: 'episode' };
  const s = MotionLevelSchema.safeParse(input.seriesMotion);
  if (s.success) return { motion: s.data, source: 'series' };
  return { motion: DEFAULT_MOTION, source: 'default' };
}

/** k indices spread evenly over n (first and last included when k ≥ 2). Pure, deterministic. */
export function evenlySpaced(n: number, k: number): number[] {
  if (k <= 0 || n <= 0) return [];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  if (k === 1) return [Math.floor((n - 1) / 2)];
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1))))];
}

/** A beat that explains rather than shows: held still under the graphics in every motion level. */
export const isExplainView = (view: string | undefined) => view === 'cutaway' || view === 'diagram';

/**
 * The engineered routes. Every beat is a picture; the motion level decides which pictures
 * are animated (`picture_clip`). Without pictures (stills unavailable) every beat is the chalk
 * overlay — a clip is made FROM a picture, so there is nothing to animate either.
 */
export function engineeredRoutes<T extends { route: string; action?: boolean; view?: string }>(
  shots: readonly T[],
  motion: MotionLevel,
  stillsAvailable: boolean,
): { shots: T[]; swaps: { idx: number; from: string; to: string; reason: string }[] } {
  const swaps: { idx: number; from: string; to: string; reason: string }[] = [];
  const to = (s: T, idx: number, route: string, reason: string): T => {
    if (s.route !== route) swaps.push({ idx, from: s.route, to: route, reason });
    return { ...s, route };
  };
  if (!stillsAvailable) return { shots: shots.map((s, i) => to(s, i, 'overlay', '3D explainer without pictures — drawn as a diagram')), swaps };

  const scenes = shots.map((s, i) => ({ s, i })).filter((x) => !isExplainView(x.s.view));
  let animate: Set<number>;
  let why: string;
  if (motion === 'full') {
    animate = new Set(scenes.map((x) => x.i));
    why = 'full motion — a clip animated from the picture';
  } else {
    const marked = scenes.filter((x) => x.s.action === true);
    const pool = marked.length ? marked : scenes;
    const k = marked.length ? Math.min(KEY_MAX_CLIPS, marked.length) : Math.min(KEY_FALLBACK_CLIPS, scenes.length);
    animate = new Set(evenlySpaced(pool.length, k).map((j) => pool[j].i));
    why = marked.length ? 'an action beat — a clip animated from the picture' : 'no beat is marked as action, so clips go on evenly spaced beats';
  }
  const out = shots.map((s, i) => (animate.has(i) ? to(s, i, 'picture_clip', why) : to(s, i, 'still', '3D explainer — a picture with a camera move')));
  return { shots: out, swaps };
}
