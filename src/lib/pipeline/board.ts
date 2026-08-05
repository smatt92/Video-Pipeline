import 'server-only';

import { serverClient, type Db } from '../db/server';

/**
 * The pipeline board, from the database.
 *
 * Replaces `src/lib/fixtures/pipeline.ts` on the board itself. The fixtures stay — they
 * are what `/studio` and the design-system screens render, and deleting them would take
 * Gate 1's artefacts with them — but nothing on the real board reads them any more.
 *
 * ── Empty and broken are different answers ───────────────────────────────────
 *
 * The one property that matters here. A board with no rows can mean the database is empty,
 * which is the correct state on day one, or that the query failed, which is a bug — and
 * rendering the same "nothing here" for both makes the second one invisible for as long as
 * it takes somebody to independently suspect it.
 *
 * So the read returns a discriminated result and the screen renders three things: rows,
 * "nothing yet, here is what would put something here", or "this query failed and here is
 * the error". Never a blank that could be either.
 */

export type ConceptState =
  | 'draft'
  | 'scripted'
  | 'shot_listed'
  | 'generating'
  | 'needs_review'
  | 'blocked'
  /**
   * Nothing failed, and nothing will happen.
   *
   * Deliberately distinct from `blocked`, which means something errored and left a row
   * saying so. A stalled concept has no error anywhere: an approved concept with a script
   * and a shotlist, waiting on a stage that cannot run — because the channel has no host
   * voice, or no library recipe matched, or the durations are still estimates.
   *
   * The distinction is the whole reason this state exists. Before it, that concept read as
   * `shot_listed` — a normal intermediate state — for ever. See STATE.md §8.
   */
  | 'stalled'
  | 'ready'
  | 'published';

export interface BoardRow {
  id: string;
  title: string;
  state: ConceptState;
  /** Null when nothing has been priced yet — distinct from zero, which means free. */
  costInr: number | null;
  /** Rates that could not be priced, so the total is knowingly incomplete. */
  unpricedCalls: number;
  scripts: number;
  shots: number;
  generations: number;
  /**
   * Why this concept cannot progress, from `v_pipeline_blockers`. Null when nothing is
   * stopping it — including on a concept that has simply not been approved yet.
   */
  blocker: string | null;
  createdAt: string;
}

export type BoardResult =
  | {
      ok: true;
      rows: BoardRow[];
      /**
       * True when more concepts exist than this read returned.
       *
       * The board renders `rows.length` as a state count and sums their cost into a total,
       * so a silent cap makes both a floor that reads as a total. Same defect found in the
       * review queue and the Studio list within an hour of each other — a reader caps for
       * safety, a page renders the length, and the cap becomes invisible exactly when the
       * list gets interesting.
       */
      truncated: boolean;
      limit: number;
      /**
       * The first blocker that belongs to the workspace rather than to any script — no
       * verified video integration, or an empty prompt library. Null when neither holds.
       *
       * Surfaced separately because it is identical on every row, and a hundred rows all
       * saying the same thing reads as a hundred problems when it is one. It also sends a
       * person to Settings rather than to a shot list. `v_pipeline_blockers` grew these
       * gates in 0028; before that it reported an ungeneratable workspace as having
       * nothing wrong with it, and the board rendered those scripts as ready.
       */
      workspaceBlocker: string | null;
    }
  | { ok: false; error: string; hint: string };

/**
 * Derive a board state from what actually exists.
 *
 * Deliberately computed from row counts rather than read from `concepts.status`: the
 * status column is what a human sets, and on a database where stages 3 and 4 ran from a
 * script rather than through the UI it will still say `draft` while a script and six shots
 * sit beside it. Counting what exists tells the truth about where the concept is; the
 * status column tells you what somebody last claimed.
 */
function deriveState(row: {
  status: string | null;
  scripts: number;
  shots: number;
  generations: number;
  failed: number;
  blocker: string | null;
}): ConceptState {
  if (row.status === 'published') return 'published';
  if (row.failed > 0) return 'blocked';
  if (row.generations > 0) return 'generating';
  // Checked after `generating` and before the progress states. A concept that has started
  // generating is moving, whatever a blocker view says about the shots that have not; a
  // concept that has not, and has a named reason it never will, is stalled rather than
  // partway. Putting this before `generating` would relabel a working run.
  if (row.blocker) return 'stalled';
  if (row.shots > 0) return 'shot_listed';
  if (row.scripts > 0) return 'scripted';
  return 'draft';
}

/**
 * @param client - the database to read. Defaults to the server client, which is what every
 * caller in the app passes (i.e. nothing). Present so a harness can drive this function
 * rather than a reimplementation of it — the same reason `handleCallback` takes its db, and
 * the reason this screen's state derivation is now checked at all: it had no harness,
 * because it built its own client at call time.
 */
/** How many concepts the board shows. Truncation is reported, never silent. */
const BOARD_LIMIT = 100;

export async function readBoard(client?: Db): Promise<BoardResult> {
  try {
    const db = client ?? serverClient();

    const { data: concepts, error } = await db
      .from('concepts')
      .select('id, title, status, created_at')
      .order('created_at', { ascending: false })
      // One more than the board shows, so truncation is detectable rather than silent.
      .limit(BOARD_LIMIT + 1);

    if (error) {
      return {
        ok: false,
        error: error.message,
        hint:
          /does not exist|schema cache/i.test(error.message)
            ? 'The concepts table is missing, which means the migrations have not been applied to this database. Run `pnpm db:doctor`.'
            : 'The query itself failed. This is not an empty database — something is wrong with the read.',
      };
    }

    if (!concepts || concepts.length === 0) {
      // Null rather than a probe of its own. `v_pipeline_blockers` is per script, so with
      // no concepts it has nothing to report — and the empty state already says what would
      // put something here. A workspace gate matters once there is something it is
      // stopping.
      return { ok: true, rows: [], workspaceBlocker: null, truncated: false, limit: BOARD_LIMIT };
    }

    const truncated = concepts.length > BOARD_LIMIT;
    const page = concepts.slice(0, BOARD_LIMIT);
    const ids = page.map((c) => c.id);

    // Counted in three reads rather than per row. A hundred concepts would otherwise be
    // three hundred round trips, and the board is the first screen anybody opens.
    const { data: scriptRows } = await db
      .from('scripts')
      .select('id, concept_id')
      .in('concept_id', ids);

    // Shots hang off scripts, not concepts — `shots.script_id` is the only link, so the
    // concept has to be resolved through it. Typechecking caught the assumption that
    // `shots.concept_id` existed, which is exactly the sort of thing the generated types
    // are for; hand-written ones would have let it through to a runtime 400.
    const scriptToConcept = new Map<string, string>();
    for (const s of scriptRows ?? []) if (s.concept_id) scriptToConcept.set(s.id, s.concept_id);

    const scriptIds = [...scriptToConcept.keys()];

    const [shots, generations, costs, blockers] = await Promise.all([
      scriptIds.length
        ? db.from('shots').select('id, script_id, status').in('script_id', scriptIds)
        : Promise.resolve({ data: [] as { id: string; script_id: string; status: string }[] }),
      db.from('generations').select('id, shot_id, status').limit(2000),
      db.from('cost_ledger').select('concept_id, cost_inr').in('concept_id', ids),
      // Why nothing is happening, read rather than inferred.
      //
      // The board previously derived state purely from counts, which cannot see this: an
      // approved concept with a script and a shotlist and no host voice on its channel has
      // nothing failed, nothing generating, and will never move. It rendered as
      // `shot_listed` — a normal intermediate state — permanently.
      //
      // A view rather than a fourth count, because the *ordering* of blockers is the
      // valuable part: the first reason to fix, not a list of everything wrong. That
      // ordering is a schema-level fact and belongs next to the schema.
      scriptIds.length
        ? db
            .from('v_pipeline_blockers')
            .select('script_id, concept_id, blocker, blocker_is_workspace_wide')
            .in('script_id', scriptIds)
        : Promise.resolve({
            data: [] as {
              script_id: string;
              concept_id: string;
              blocker: string | null;
              blocker_is_workspace_wide: boolean | null;
            }[],
          }),
    ]);

    const shotToConcept = new Map<string, string>();
    for (const s of shots.data ?? []) {
      const conceptId = scriptToConcept.get(s.script_id);
      if (conceptId) shotToConcept.set(s.id, conceptId);
    }

    const tally = new Map<
      string,
      { scripts: number; shots: number; generations: number; failed: number }
    >();
    const get = (id: string) => {
      let t = tally.get(id);
      if (!t) {
        t = { scripts: 0, shots: 0, generations: 0, failed: 0 };
        tally.set(id, t);
      }
      return t;
    };

    for (const s of scriptRows ?? []) if (s.concept_id) get(s.concept_id).scripts++;
    for (const s of shots.data ?? []) {
      const conceptId = scriptToConcept.get(s.script_id);
      if (conceptId) get(conceptId).shots++;
    }
    for (const g of generations.data ?? []) {
      const conceptId = g.shot_id ? shotToConcept.get(g.shot_id) : undefined;
      if (!conceptId) continue;
      const t = get(conceptId);
      t.generations++;
      if (g.status === 'failed' || g.status === 'timeout') t.failed++;
    }

    const cost = new Map<string, { total: number; unpriced: number }>();
    for (const c of costs.data ?? []) {
      if (!c.concept_id) continue;
      const entry = cost.get(c.concept_id) ?? { total: 0, unpriced: 0 };
      // Null cost is a call that was made and could not be priced. Counted separately so
      // the total never silently absorbs it — a total that quietly excludes rows is the
      // kind of number that gets quoted.
      if (c.cost_inr === null) entry.unpriced++;
      else entry.total += Number(c.cost_inr);
      cost.set(c.concept_id, entry);
    }

    // First non-null blocker per concept. A concept with two scripts can have two, and the
    // earlier stage is the one to fix — the view is already ordered by how early the stage
    // sits, so the first is the right one.
    const blocked = new Map<string, string>();
    for (const b of blockers.data ?? []) {
      // `concept_id` is nullable in the view's type because it comes through a join; a row
      // without one cannot be attributed and is skipped rather than guessed at.
      if (b.blocker && b.concept_id && !blocked.has(b.concept_id)) {
        blocked.set(b.concept_id, b.blocker);
      }
    }

    const rows: BoardRow[] = page.map((c) => {
      const t = tally.get(c.id) ?? { scripts: 0, shots: 0, generations: 0, failed: 0 };
      const money = cost.get(c.id);
      return {
        id: c.id,
        title: c.title,
        state: deriveState({ status: c.status, ...t, blocker: blocked.get(c.id) ?? null }),
        blocker: blocked.get(c.id) ?? null,
        costInr: money && money.total > 0 ? money.total : null,
        unpricedCalls: money?.unpriced ?? 0,
        scripts: t.scripts,
        shots: t.shots,
        generations: t.generations,
        createdAt: c.created_at,
      };
    });

    const workspaceBlocker =
      (blockers.data ?? []).find((b) => b.blocker_is_workspace_wide && b.blocker)?.blocker ?? null;

    return { ok: true, rows, workspaceBlocker, truncated, limit: BOARD_LIMIT };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hint: 'The read threw before reaching the database. Usually a missing environment variable.',
    };
  }
}
