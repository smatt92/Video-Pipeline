import { readUsdInrRate } from '../cost/fx';
import type { Db } from '../db/server';
import { getBible } from './bible';
import { estimateEpisode, PlannedShotSchema } from './estimate';
import { engineeredAvailability, heroObjectsOf } from './engineered';
import { FORMAT_INFO, formatOf, MOTION_INFO, MOTION_LEVELS, motionOf, paceOf, routesForFormat, VISUAL_FORMATS, type MotionLevel, type VisualFormat, type VoicePace } from './formats';
import { fittedPlan } from './plan-price';
import { castAvailability, episodeCastSlugs } from './picture-cast';
import { parseScript } from './script-lines';
import { stillsAvailability } from './stills';

export interface FormatOption {
  format: VisualFormat;
  label: string;
  blurb: string;
  /** Planned ₹ for this brief in this format; null when any part is unpriced (never 0 for "unknown"). */
  inr: number | null;
  /** Why the figure is missing or why the format degrades, in one sentence; null when neither. */
  note: string | null;
  /**
   * Why this format cannot be picked for this brief, or null. Set for "Cartoon characters"
   * when none of the brief's cast has a locked sheet — the same predicate the planner falls
   * back on (picture-cast.ts `castAvailability`), so the screen and the run cannot disagree.
   */
  disabled: string | null;
}

/**
 * One motion level of the 3D explainer, priced on this brief (0052): the plan the run will make
 * — `routesForFormat` then the cap fit (plan-price.ts), the same two calls `planShots` makes —
 * so the price beside "Full motion" already has the clips the cap would take away taken away,
 * and the note says how many.
 */
export interface MotionOption {
  motion: MotionLevel;
  label: string;
  blurb: string;
  inr: number | null;
  /** Clips the plan makes (after the cap fit). */
  clips: number;
  /** Clips asked for before the cap fit. */
  wanted: number;
  note: string | null;
}

/**
 * The format choice on Approvals: each format priced on THIS brief's shot list, with the
 * series default marked. The same routing (`routesForFormat`) and estimator the planner uses,
 * so the figure beside a format is the figure the run will check against the cap. It omits
 * what the cap fitter may still swap — the planner records that on the episode.
 */
export async function formatOptions(
  db: Db,
  channelId: string,
  brief: { series: string; shot_list: unknown; script_text: string; lead_character?: string | null; hero_objects?: unknown },
): Promise<{ options: FormatOption[]; seriesDefault: VisualFormat; seriesPace: VoicePace; seriesMotion: MotionLevel; motions: MotionOption[] }> {
  const cb = await getBible(db, channelId);
  const series = cb.seriesFor(brief.series as never);
  const seriesDefault = formatOf({ seriesFormat: series?.visual_format }).format;
  const seriesPace = paceOf({ seriesPace: series?.voice_pace }).pace;
  const seriesMotion = motionOf({ seriesMotion: series?.motion }).motion;
  const engineered = await engineeredAvailability(db);
  const objectSheets = heroObjectsOf(brief.hero_objects).length;
  const motions: MotionOption[] = [];
  const shots = PlannedShotSchema.array().safeParse(brief.shot_list);
  const fx = await readUsdInrRate(db);
  const stills = await stillsAvailability(db, channelId);
  const parsed = parseScript(brief.script_text, cb);
  const voChars = parsed.ok ? parsed.voText.length : brief.script_text.length;
  const cast = castAvailability(
    cb,
    episodeCastSlugs({ lead: brief.lead_character ?? '', speakers: parsed.ok ? parsed.lines.map((l) => l.speaker) : [], shotCharacters: shots.success ? shots.data.map((s) => s.characters) : [] }),
  );

  const options: FormatOption[] = [];
  for (const format of VISUAL_FORMATS) {
    const info = FORMAT_INFO[format];
    let note: string | null = null;
    const disabled = format === 'characters' && !cast.available ? cast.reason : format === 'engineered' && !engineered.available ? engineered.reason : null;
    if (format !== 'diagram' && !stills.available) note = `Pictures unavailable — ${stills.reason}; this would be drawn as diagrams.`;
    if (!shots.success || !shots.data.length) {
      options.push({ format, ...info, inr: null, note: 'The brief has no shot list to price.', disabled });
      continue;
    }
    if (!fx.ok) {
      options.push({ format, ...info, inr: null, note: 'No USD→INR rate is set, so nothing can be priced.', disabled });
      continue;
    }
    if (format === 'engineered') {
      // Each motion level as the run will plan it (routes, then the cap fit); the format's own
      // figure is the series default's.
      for (const motion of MOTION_LEVELS) {
        const routed = routesForFormat(shots.data, 'engineered', stills.available, motion).shots;
        const wanted = routed.filter((x) => x.route === 'picture_clip').length;
        const plan = await fittedPlan(db, { channelId, kind: 'short', shots: routed, voChars, usdInrRate: fx.rate, objectSheets });
        const clips = plan.fit.shots.filter((x) => x.route === 'picture_clip').length;
        let mNote: string | null = null;
        if (plan.finalEst.total_inr === null) mNote = `Unpriced: ${plan.finalEst.unpriced.join('; ')}`;
        else if (clips < wanted) {
          const why = [...new Set(plan.fit.swaps.filter((x) => x.from === 'picture_clip').map((x) => x.reason.replace(/^unpriced: .*/, 'no clip recipe is active or priced')))];
          mNote = `${wanted - clips} of ${wanted} clips are planned as pictures: ${why.join('; ')}.`;
        }
        motions.push({ motion, ...MOTION_INFO[motion], inr: plan.finalEst.total_inr, clips, wanted, note: mNote });
      }
      const pick = motions.find((m) => m.motion === seriesMotion)!;
      const eNote = note ?? (objectSheets ? null : 'This brief names no hero objects, so nothing keeps an object consistent between pictures.');
      options.push({ format, ...info, inr: pick.inr, note: eNote, disabled });
      continue;
    }
    const routed = routesForFormat(shots.data, format, stills.available).shots;
    const est = await estimateEpisode(db, { shots: routed, voChars, usdInrRate: fx.rate, channelId });
    if (est.total_inr === null && !note) note = `Unpriced: ${est.unpriced.join('; ')}`;
    if (format === 'characters' && cast.available && cast.unlocked.length && !note) note = `No locked sheet yet for ${cast.unlocked.join(', ')} — left out of the pictures.`;
    options.push({ format, ...info, inr: est.total_inr, note, disabled });
  }
  return { options, seriesDefault, seriesPace, seriesMotion, motions };
}
