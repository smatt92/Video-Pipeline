import { z } from 'zod';

import { SHOT_KIND_KEYS } from './kinds';

/**
 * The shape a shotlist must arrive in, and the rules a decode constraint cannot express.
 *
 * The interesting validation here is coverage. Each shot claims a verbatim stretch of
 * `vo_text`, and those stretches must reconstruct the whole thing in order — no gap, no
 * overlap, nothing invented. That is not a stylistic preference: the ranges become
 * `shots.vo_char_start/end`, which is what stage 6 uses to turn word timings into real
 * durations. A gap is speech no shot is on screen for; an overlap is two shots claiming the
 * same seconds. Both produce a timeline that is wrong in a way nobody notices until the
 * assembled video is out of sync.
 */

export const ShotDraftSchema = z.object({
  kind: z
    .enum(SHOT_KIND_KEYS as [string, ...string[]])
    .describe('What kind of frame this is. The signal a generation recipe is selected on.'),
  covers: z
    .string()
    .min(1)
    .describe('The exact stretch of vo_text spoken over this shot, copied verbatim.'),
  description: z
    .string()
    .min(1)
    .describe('What is on screen. Written for a person to picture, not for a model to parse.'),
  intent: z.string().min(1).describe('Why this shot rather than another. A short phrase.'),
});

/**
 * The real ceiling on a shotlist, exported rather than inlined.
 *
 * The Guardrails screen used to display 12 for this, sourced from a fixture, while the
 * decode constraint below rejected anything over 8. A guardrails screen exists to answer
 * "is this on, and at what number?" without grepping — a screen that answers it wrongly is
 * worse than no screen, because it is believed. The registry in
 * `src/lib/settings/guardrails.ts` imports these two, so the displayed number and the
 * enforced number cannot drift: there is only one of them.
 */
export const MIN_SHOTS_PER_SHOTLIST = 2;
export const MAX_SHOTS_PER_SHOTLIST = 8;

export const ShotlistSchema = z.object({
  shots: z.array(ShotDraftSchema).min(MIN_SHOTS_PER_SHOTLIST).max(MAX_SHOTS_PER_SHOTLIST),
});

export type ShotDraft = z.infer<typeof ShotDraftSchema>;
export type Shotlist = z.infer<typeof ShotlistSchema>;

/** A shot with its span resolved against the real vo_text. */
export interface ResolvedShot {
  idx: number;
  description: string;
  intent: string;
  /** From the closed vocabulary. Enforced by the decode constraint, so never invalid. */
  shotKind: string;
  covers: string;
  voCharStart: number;
  voCharEnd: number;
  /** Provisional. Stage 6 replaces it from word timings and flips duration_source. */
  authoredDurationS: number;
}

export type ResolveResult =
  | { ok: true; shots: ResolvedShot[] }
  | { ok: false; problems: string[] };

/** Rough spoken rate, for the provisional duration only. */
const WORDS_PER_SECOND = 2.5;

/**
 * Turn verbatim quotes into character offsets, and check they tile the voiceover.
 *
 * Offsets are searched for rather than asked for. A model emitting exact character indices
 * is unreliable in a way that fails silently — an index off by four still parses, still
 * validates, and mistimes the video. A quote that cannot be found in `vo_text` is loud.
 *
 * Searching forward from the end of the previous match, not from zero: a phrase can
 * legitimately repeat, and matching the first occurrence would fold the timeline back on
 * itself.
 */
export function resolveShotSpans(shotlist: Shotlist, voText: string): ResolveResult {
  const problems: string[] = [];
  const shots: ResolvedShot[] = [];
  let cursor = 0;

  shotlist.shots.forEach((shot, idx) => {
    const covers = shot.covers.trim();
    const at = voText.indexOf(covers, cursor);

    if (at === -1) {
      // Distinguish "not in the script at all" from "out of order", because they mean
      // different things about what the model did.
      const anywhere = voText.indexOf(covers);
      problems.push(
        anywhere === -1
          ? `shot ${idx}: its covers text is not in vo_text — the model paraphrased instead of copying: "${covers.slice(0, 60)}…"`
          : `shot ${idx}: its covers text appears at ${anywhere}, before the end of shot ${idx - 1} at ${cursor} — the shots are out of order or overlap`,
      );
      return;
    }

    if (at > cursor) {
      const skipped = voText.slice(cursor, at).trim();
      if (skipped) {
        problems.push(
          `between shots ${idx - 1} and ${idx}: ${skipped.length} characters of speech no shot is on screen for — "${skipped.slice(0, 60)}"`,
        );
      }
    }

    const end = at + covers.length;
    const words = covers.split(/\s+/).filter(Boolean).length;

    shots.push({
      idx,
      description: shot.description,
      intent: shot.intent,
      shotKind: shot.kind,
      covers,
      voCharStart: at,
      voCharEnd: end,
      // Provisional and known to be approximate. Stage 6 overwrites it from real word
      // timings and sets duration_source to 'derived_from_vo'.
      authoredDurationS: Math.max(1, Math.round((words / WORDS_PER_SECOND) * 10) / 10),
    });

    cursor = end;
  });

  const trailing = voText.slice(cursor).trim();
  if (trailing) {
    problems.push(
      `after the last shot: ${trailing.length} characters of speech no shot covers — "${trailing.slice(0, 60)}"`,
    );
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, shots };
}
