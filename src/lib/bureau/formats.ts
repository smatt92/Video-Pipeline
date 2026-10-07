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
 *
 * ── Where the choice lives ───────────────────────────────────────────────────
 *
 * A series' default is `visual_format` in its bible document (absent → illustrated). The
 * approver's override is `briefs.approved_edits.visual_format`: the approve function already
 * stores the edits jsonb and writes it to the authorship log, so the choice is recorded with
 * the decision it belongs to, and no migration was needed to ship it.
 */

export const VISUAL_FORMATS = ['illustrated', 'diagram', 'cinematic'] as const;
export type VisualFormat = (typeof VISUAL_FORMATS)[number];
export const VisualFormatSchema = z.enum(VISUAL_FORMATS);
export const DEFAULT_VISUAL_FORMAT: VisualFormat = 'illustrated';

export const FORMAT_INFO: Record<VisualFormat, { label: string; blurb: string }> = {
  illustrated: { label: 'Illustrated', blurb: 'Cartoon pictures of the topic, a new one every ~6 s of narration' },
  diagram: { label: 'Chalk diagrams', blurb: 'In-house drawn diagrams; only the voice is generated' },
  cinematic: { label: 'Cinematic', blurb: 'Generated video where a recipe is active; pictures elsewhere' },
};

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
export function routesForFormat<T extends { route: string }>(
  shots: readonly T[],
  format: VisualFormat,
  stillsAvailable: boolean,
): { shots: T[]; swaps: { idx: number; from: string; to: string; reason: string }[] } {
  const swaps: { idx: number; from: string; to: string; reason: string }[] = [];
  const out = shots.map((s, idx) => {
    if (format === 'diagram') {
      if (s.route === 'overlay') return s;
      swaps.push({ idx, from: s.route, to: 'overlay', reason: 'chalk diagram format — nothing but the voice is generated' });
      return { ...s, route: 'overlay' };
    }
    if (!stillsAvailable) return s;
    if (format === 'illustrated') {
      if (s.route === 'still') return s;
      if (s.route !== 'overlay') swaps.push({ idx, from: s.route, to: 'still', reason: 'illustrated format — a picture of the topic instead' });
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
