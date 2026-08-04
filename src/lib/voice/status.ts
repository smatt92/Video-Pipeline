import 'server-only';

import { serverClient, type Db } from '../db/server';

/**
 * Where the voice chain stops, per script.
 *
 * ── The inverse test, applied before the screen was written ──────────────────
 *
 * A voice panel's obvious shape is a list of scripts with take counts and total seconds.
 * That looks identical after one script and after a hundred — the list gets longer. It
 * cannot answer the only question the voice stage raises, which is *where does it stop*.
 *
 * So the primary artifact is the distribution of `vo_state`, and the list is the evidence.
 * A workspace where every script is `stitched_untimed` has a specific, fixable problem; a
 * workspace where every script is `not_started` has a different one; and a total number of
 * takes distinguishes neither.
 *
 * ── Why this screen exists at all ────────────────────────────────────────────
 *
 * `shots_timed` versus `shots` is the pair that made 03 → 04 → 05 provably inert for a week
 * with fifteen harnesses green. Stage 5 refuses any shot whose duration is still an
 * estimate; only stage 6 flips `duration_source`. Every stage was individually correct and
 * nothing came out, and no error was raised anywhere, because "nothing came out" is not an
 * error — it is the absence of one.
 *
 * `stitched_untimed` is that exact state, named, on a screen. It is the reason this is not
 * merely a nicer rendering of the same counts.
 */

export type VoState =
  | 'no_shots'
  | 'not_started'
  | 'takes_unstitched'
  | 'stitched_untimed'
  | 'partially_timed'
  | 'timed';

/** What each state means and what moves it forward. Ordered by how early it sits. */
export const VO_STATES: readonly { state: VoState; label: string; means: string }[] = [
  {
    state: 'no_shots',
    label: 'No shots',
    means: 'Stage 4 has not run, so there is nothing for the voice to time.',
  },
  {
    state: 'not_started',
    label: 'Not started',
    means: 'No takes. Stage 6 has not run on this script.',
  },
  {
    state: 'takes_unstitched',
    label: 'Takes unstitched',
    means: 'Speech was generated and billed, and the takes were never joined. Money moved.',
  },
  {
    state: 'stitched_untimed',
    label: 'Stitched, untimed',
    means:
      'The voice exists and no shot has a measured duration. Stage 5 will refuse every ' +
      'shot on this script — this is the state that made the chain inert.',
  },
  {
    state: 'partially_timed',
    label: 'Partly timed',
    means: 'Some shots have measured durations; stage 5 will submit those and skip the rest.',
  },
  { state: 'timed', label: 'Timed', means: 'Every shot has a duration derived from real speech.' },
];

export interface VoScriptRow {
  scriptId: string;
  conceptId: string;
  title: string;
  voChars: number;
  takes: number;
  unstitchedTakes: number;
  /** Null when there are no takes. No measured speech is not silence. */
  totalDurationS: number | null;
  charactersBilled: number | null;
  costInr: number | null;
  unmeasuredTakes: number;
  unbilledTakes: number;
  shots: number;
  shotsTimed: number;
  voState: VoState;
}

export type VoStatusResult =
  | {
      ok: true;
      rows: VoScriptRow[];
      /** Count per state, in pipeline order. The primary artifact, not the list. */
      distribution: { state: VoState; label: string; means: string; n: number }[];
      /** True when there are no scripts at all — different from every script being stuck. */
      noScripts: boolean;
    }
  | { ok: false; error: string; hint: string };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function readVoiceStatus(client?: Db): Promise<VoStatusResult> {
  const db = client ?? serverClient();

  const { data, error } = await db
    .from('v_script_vo_status')
    .select('*')
    .limit(200);

  if (error) {
    return {
      ok: false,
      error: error.message,
      hint: /does not exist|schema cache/i.test(error.message)
        ? 'v_script_vo_status is missing, so migration 0030 has not been applied. Run `pnpm doctor`.'
        : 'The read failed. This is not an empty workspace — that returns rows: [] and noScripts true.',
    };
  }

  const raw = (data ?? []) as Record<string, unknown>[];

  // Titles come from the concept. A second query rather than an embed, for the same reason
  // stage 9 uses two: the `pg` shim the harnesses drive has no embed support, and a stage
  // with a harness is worth more than a stage with one fewer query.
  const conceptIds = [...new Set(raw.map((r) => String(r.concept_id)))];
  const titles = new Map<string, string>();
  if (conceptIds.length > 0) {
    const { data: concepts } = await db.from('concepts').select('id, title').in('id', conceptIds);
    for (const c of concepts ?? []) titles.set(c.id, c.title);
  }

  const rows: VoScriptRow[] = raw.map((r) => ({
    scriptId: String(r.script_id),
    conceptId: String(r.concept_id),
    title: titles.get(String(r.concept_id)) ?? '—',
    voChars: Number(r.vo_chars ?? 0),
    takes: Number(r.takes ?? 0),
    unstitchedTakes: Number(r.unstitched_takes ?? 0),
    totalDurationS: num(r.total_duration_s),
    charactersBilled: num(r.characters_billed),
    costInr: num(r.cost_inr),
    unmeasuredTakes: Number(r.unmeasured_takes ?? 0),
    unbilledTakes: Number(r.unbilled_takes ?? 0),
    shots: Number(r.shots ?? 0),
    shotsTimed: Number(r.shots_timed ?? 0),
    voState: r.vo_state as VoState,
  }));

  return {
    ok: true,
    rows,
    distribution: VO_STATES.map((s) => ({
      ...s,
      n: rows.filter((r) => r.voState === s.state).length,
    })),
    noScripts: rows.length === 0,
  };
}
