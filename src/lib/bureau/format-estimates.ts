import { readUsdInrRate } from '../cost/fx';
import type { Db } from '../db/server';
import { getBible } from './bible';
import { estimateEpisode, PlannedShotSchema } from './estimate';
import { FORMAT_INFO, formatOf, paceOf, routesForFormat, VISUAL_FORMATS, type VisualFormat, type VoicePace } from './formats';
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
 * The format choice on Approvals: each format priced on THIS brief's shot list, with the
 * series default marked. The same routing (`routesForFormat`) and estimator the planner uses,
 * so the figure beside a format is the figure the run will check against the cap. It omits
 * what the cap fitter may still swap — the planner records that on the episode.
 */
export async function formatOptions(
  db: Db,
  channelId: string,
  brief: { series: string; shot_list: unknown; script_text: string; lead_character?: string | null },
): Promise<{ options: FormatOption[]; seriesDefault: VisualFormat; seriesPace: VoicePace }> {
  const cb = await getBible(db, channelId);
  const series = cb.seriesFor(brief.series as never);
  const seriesDefault = formatOf({ seriesFormat: series?.visual_format }).format;
  const seriesPace = paceOf({ seriesPace: series?.voice_pace }).pace;
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
    const disabled = format === 'characters' && !cast.available ? cast.reason : null;
    if (format !== 'diagram' && !stills.available) note = `Pictures unavailable — ${stills.reason}; this would be drawn as diagrams.`;
    if (!shots.success || !shots.data.length) {
      options.push({ format, ...info, inr: null, note: 'The brief has no shot list to price.', disabled });
      continue;
    }
    if (!fx.ok) {
      options.push({ format, ...info, inr: null, note: 'No USD→INR rate is set, so nothing can be priced.', disabled });
      continue;
    }
    const routed = routesForFormat(shots.data, format, stills.available).shots;
    const est = await estimateEpisode(db, { shots: routed, voChars, usdInrRate: fx.rate, channelId });
    if (est.total_inr === null && !note) note = `Unpriced: ${est.unpriced.join('; ')}`;
    if (format === 'characters' && cast.available && cast.unlocked.length && !note) note = `No locked sheet yet for ${cast.unlocked.join(', ')} — left out of the pictures.`;
    options.push({ format, ...info, inr: est.total_inr, note, disabled });
  }
  return { options, seriesDefault, seriesPace };
}
