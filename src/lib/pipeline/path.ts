import 'server-only';

import { serverClient, type Db } from '../db/server';

/**
 * Where a concept is on the path, and what is stopping it.
 *
 * ── Why a path and not another board ─────────────────────────────────────────
 *
 * The board answers "is everything okay?" across concepts. It does not answer "where am I?"
 * for one — and this app has assumed throughout that you already know which stage you are
 * in, which is true for whoever built it and false for everybody else.
 *
 * The order below is the operator's own framing: prompt → script → workflow → videos →
 * check first → stitch → export → upload. The labels are theirs and the stage numbers are
 * ours, because a path exists to be recognised rather than to be technically complete.
 *
 * ── The one place the path must contradict intuition ─────────────────────────
 *
 * **Voice sits between the workflow and the videos.** It reads backwards — surely you make
 * the pictures and then narrate them — and the entire pipeline depends on the reverse: word
 * timings from real speech set `shots.duration_s`, and stage 5 refuses any shot whose
 * duration is still an estimate. Generating video against a word-count guess spends the
 * expensive artifact's budget on the cheap one's uncertainty.
 *
 * That ordering is why the 03 → 04 → 05 chain was provably inert for a week with fifteen
 * harnesses green, and it has been invisible on every screen until now. So the path is
 * drawn in the order stages **run**, not sorted by stage number — which would put 05 before
 * 06 and teach exactly the mistake the audio-first inversion exists to prevent.
 */

export type StageKey =
  | 'trend' | 'concept' | 'script' | 'workflow'
  | 'voice' | 'videos' | 'check' | 'stitch' | 'export' | 'upload';

export interface PathStage {
  readonly key: StageKey;
  /** The operator's word for it. */
  readonly label: string;
  /** Ours, so a label can be traced to a task. */
  readonly stage: string;
  readonly what: string;
  /** Set only where the order is counterintuitive and the reason is load-bearing. */
  readonly whyHere?: string;
}

export const PATH: readonly PathStage[] = [
  { key: 'trend', label: 'Prompt', stage: '01-trends', what: 'A signal worth making something about.' },
  { key: 'concept', label: 'Concept', stage: '02-concept', what: 'An angle, scored and approved.' },
  { key: 'script', label: 'Script', stage: '03-script', what: 'The hook, the beats, the words spoken.' },
  { key: 'workflow', label: 'Workflow', stage: '04-shotlist', what: 'Shots, each matched to a library recipe.' },
  {
    key: 'voice',
    label: 'Voice',
    stage: '06-voice',
    what: 'Real speech, and the word timings that set every shot’s length.',
    whyHere:
      'Before the videos, not after — the one part of this order that reads backwards. Word '
      + 'timings set shot durations and stage 5 refuses any shot still carrying an estimate. '
      + 'Generating video against a word-count guess spends the expensive artifact on the '
      + 'cheap one’s uncertainty. This ordering is why the chain was inert for a week.',
  },
  {
    key: 'videos',
    label: 'Videos',
    stage: '05-generate',
    what: 'One pilot shot first, then the rest once you have seen it.',
    whyHere:
      'The pilot is this stage’s cost control: otherwise six clips are committed in one call '
      + 'and the first thing you learn about a recipe is learned six charges in.',
  },
  { key: 'check', label: 'Check first', stage: '08-review', what: 'Watch it before anything else happens to it.' },
  { key: 'stitch', label: 'Stitch', stage: '07-assemble', what: 'Clips and voice into one file.' },
  { key: 'export', label: 'Export', stage: '09-metadata', what: 'Title, description, tags — and the file.' },
  { key: 'upload', label: 'Upload', stage: '10-publish', what: 'Manual in phase 1: download, paste, post.' },
];

/**
 * `waiting_on_you` is deliberately not `blocked`.
 *
 * A pilot awaiting approval has nothing wrong with it. Rendering it as a problem sends a
 * person hunting a misconfiguration that does not exist — and `v_pipeline_blockers` has
 * already twice reported an invented state as something it was not: as readiness in 0028,
 * and as a blocker that was not blocking in 0029. A pending pilot shown as stalled would be
 * the third, so the distinction is carried from the view's own column rather than inferred
 * from the blocker string.
 */
export type StageState = 'done' | 'current' | 'blocked' | 'waiting_on_you' | 'ahead';

export interface PathPosition {
  conceptId: string;
  scriptId: string | null;
  title: string;
  stages: { key: StageKey; state: StageState }[];
  currentKey: StageKey;
  blocker: string | null;
  awaitingPilotApproval: boolean;
}

export type PathResult =
  | { ok: true; positions: PathPosition[] }
  | { ok: false; error: string; hint: string };

/**
 * Read every concept's position.
 *
 * Built from `v_pipeline_blockers` and `v_script_vo_status` — both of which existed with no
 * reader, and one of which was built for exactly this question and then read by nothing.
 */
export async function readPath(client?: Db): Promise<PathResult> {
  const db = client ?? serverClient();

  const [concepts, scripts, blockers, vo, shots, renders] = await Promise.all([
    db.from('concepts').select('id, title, status, created_at')
      .order('created_at', { ascending: false }).limit(50),
    db.from('scripts').select('id, concept_id'),
    db.from('v_pipeline_blockers').select('script_id, concept_id, blocker, awaiting_pilot_approval'),
    db.from('v_script_vo_status').select('script_id, vo_state, shots, shots_timed'),
    db.from('shots').select('id, script_id'),
    db.from('renders').select('script_id, status'),
  ]);

  const err = concepts.error ?? scripts.error ?? blockers.error ?? vo.error;
  if (err) {
    return {
      ok: false,
      error: err.message,
      hint: /does not exist|schema cache/i.test(err.message)
        ? 'A pipeline view is missing, so the migrations are not fully applied. Run `pnpm doctor`.'
        : 'The read failed. This is not an empty workspace — that returns positions: [].',
    };
  }

  const scriptFor = new Map<string, string>();
  for (const s of scripts.data ?? []) scriptFor.set(s.concept_id, s.id);
  const blockerFor = new Map((blockers.data ?? []).map((b) => [String(b.script_id), b]));
  const voFor = new Map((vo.data ?? []).map((v) => [String(v.script_id), v]));
  const shotCount = new Map<string, number>();
  for (const sh of shots.data ?? []) {
    shotCount.set(sh.script_id, (shotCount.get(sh.script_id) ?? 0) + 1);
  }
  const rendered = new Set(
    (renders.data ?? []).filter((r) => r.status === 'ready').map((r) => r.script_id),
  );

  const positions: PathPosition[] = (concepts.data ?? []).map((c) => {
    const scriptId = scriptFor.get(c.id) ?? null;
    const b = scriptId ? blockerFor.get(scriptId) : undefined;
    const v = scriptId ? voFor.get(scriptId) : undefined;

    // Derived from artifacts, never from a status column. A status is a claim and a row is
    // evidence — believing the claim is precisely what made the board render a permanently
    // stuck concept as `shot_listed` for ever.
    //
    // Evaluated in path order so voice is reached before videos: `shots_timed > 0` is what
    // stage 6 produces and what stage 5 consumes, so a script with timed shots has passed
    // voice whatever else is true of it.
    let current: StageKey = 'concept';
    if (c.status === 'approved' || c.status === 'in_production' || scriptId) current = 'script';
    if (scriptId && (shotCount.get(scriptId) ?? 0) > 0) current = 'workflow';
    if (v?.vo_state === 'partially_timed' || v?.vo_state === 'timed') current = 'voice';
    if (scriptId && Number(v?.shots_timed ?? 0) > 0 && b?.awaiting_pilot_approval !== undefined) {
      current = Number(v?.shots_timed ?? 0) > 0 ? 'videos' : current;
    }
    if (scriptId && rendered.has(scriptId)) current = 'check';
    if (c.status === 'published') current = 'upload';

    const idx = PATH.findIndex((p) => p.key === current);
    const awaiting = b?.awaiting_pilot_approval === true;

    return {
      conceptId: c.id,
      scriptId,
      title: c.title,
      currentKey: current,
      blocker: b?.blocker ?? null,
      awaitingPilotApproval: awaiting,
      stages: PATH.map((p, i) => ({
        key: p.key,
        state:
          i < idx ? 'done'
          : i > idx ? 'ahead'
          : awaiting ? 'waiting_on_you'
          : b?.blocker ? 'blocked'
          : 'current',
      })),
    };
  });

  return { ok: true, positions };
}
