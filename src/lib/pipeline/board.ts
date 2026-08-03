import 'server-only';

import { serverClient } from '../db/server';

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
  createdAt: string;
}

export type BoardResult =
  | { ok: true; rows: BoardRow[] }
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
}): ConceptState {
  if (row.status === 'published') return 'published';
  if (row.failed > 0) return 'blocked';
  if (row.generations > 0) return 'generating';
  if (row.shots > 0) return 'shot_listed';
  if (row.scripts > 0) return 'scripted';
  return 'draft';
}

export async function readBoard(): Promise<BoardResult> {
  try {
    const db = serverClient();

    const { data: concepts, error } = await db
      .from('concepts')
      .select('id, title, status, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      return {
        ok: false,
        error: error.message,
        hint:
          /does not exist|schema cache/i.test(error.message)
            ? 'The concepts table is missing, which means the migrations have not been applied to this database. Run `pnpm doctor`.'
            : 'The query itself failed. This is not an empty database — something is wrong with the read.',
      };
    }

    if (!concepts || concepts.length === 0) return { ok: true, rows: [] };

    const ids = concepts.map((c) => c.id);

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

    const [shots, generations, costs] = await Promise.all([
      scriptIds.length
        ? db.from('shots').select('id, script_id, status').in('script_id', scriptIds)
        : Promise.resolve({ data: [] as { id: string; script_id: string; status: string }[] }),
      db.from('generations').select('id, shot_id, status').limit(2000),
      db.from('cost_ledger').select('concept_id, cost_inr').in('concept_id', ids),
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

    const rows: BoardRow[] = concepts.map((c) => {
      const t = tally.get(c.id) ?? { scripts: 0, shots: 0, generations: 0, failed: 0 };
      const money = cost.get(c.id);
      return {
        id: c.id,
        title: c.title,
        state: deriveState({ status: c.status, ...t }),
        costInr: money && money.total > 0 ? money.total : null,
        unpricedCalls: money?.unpriced ?? 0,
        scripts: t.scripts,
        shots: t.shots,
        generations: t.generations,
        createdAt: c.created_at,
      };
    });

    return { ok: true, rows };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hint: 'The read threw before reaching the database. Usually a missing environment variable.',
    };
  }
}
