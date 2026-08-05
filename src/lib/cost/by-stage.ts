import 'server-only';

import { serverClient, type Db } from '../db/server';

/**
 * Spend per pipeline stage.
 *
 * ── The inverse test, applied before the screen was written ──────────────────
 *
 * A cost-by-stage panel's obvious shape is a bar per stage. That looks identical after one
 * video and after a hundred: the bars grow. It cannot distinguish "stage 5 is expensive per
 * video" from "stage 5 ran a lot", which is the only question a cost breakdown is for. So
 * every row carries `scripts` — how many distinct scripts the stage charged — and
 * `inrPerScript` is derived from it and null when it is zero.
 *
 * ── The stage vocabulary lives here, not in SQL ──────────────────────────────
 *
 * `v_cost_by_stage` returns only stages that have ledger rows. A screen showing two rows
 * would read as a two-stage pipeline, so the never-ran stages have to be filled in — and
 * that is exactly the absent-versus-zero distinction: **a stage that has never run must not
 * render as costing ₹0.** "Assembly is free" and "assembly has never been built" are
 * different claims and only one of them is true here.
 *
 * The list is filled in *here* rather than in the view because `PipelineStage` already
 * exists in `cost/llm.ts` and the CHECK-constraint vocabulary already exists in the
 * database; a third copy in a view definition is how the two would silently diverge. SQL
 * reports facts about rows. The module that owns the vocabulary says what is missing.
 */

/**
 * Every stage that can charge, in pipeline order, with what it spends money on.
 *
 * `01-trends` is absent deliberately: it reads public feeds, writes no `cost_ledger` row,
 * and listing it as "never run, ₹0" would imply a charge that will one day appear. Assembly
 * (07) and review (08) are absent for the same reason — they cost Trigger compute, not a
 * per-call vendor charge, and there is no ledger row for them to be missing.
 */
export const CHARGING_STAGES: readonly { stage: string; label: string; what: string }[] = [
  { stage: '02-concept', label: 'Concepts', what: 'one Anthropic call proposing N concepts' },
  { stage: '03-script', label: 'Script', what: 'one Anthropic call per draft' },
  { stage: '04-shotlist', label: 'Shotlist', what: 'one Anthropic call per script' },
  { stage: '06-voice', label: 'Voice', what: 'characters of speech, per take' },
  { stage: '05-generate', label: 'Generate', what: 'vendor credits, per shot' },
  { stage: '09-metadata', label: 'Metadata', what: 'one Anthropic call per render' },
  { stage: 'studio', label: 'Studio', what: 'tokens, per turn of an operator session' },
];

export interface StageCostRow {
  stage: string;
  label: string;
  what: string;
  /** False when the stage has no ledger row at all. Never render this as ₹0. */
  hasRun: boolean;
  entries: number;
  /** The denominator. Zero when the stage has never charged a script. */
  scripts: number;
  /** Null when any contributing row is unpriced — unknown, not smaller. */
  settledInr: number | null;
  openEstimateInr: number | null;
  unpricedRows: number;
  /** Null when `scripts` is zero. There is nothing to divide by. */
  inrPerScript: number | null;
  lastAt: string | null;
}

export type StageCostResult =
  | { ok: true; rows: StageCostRow[]; stagesRun: number }
  | { ok: false; error: string; hint: string };

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function readCostByStage(client?: Db): Promise<StageCostResult> {
  const db = client ?? serverClient();

  const { data, error } = await db.from('v_cost_by_stage').select('*');

  if (error) {
    return {
      ok: false,
      error: error.message,
      hint: /does not exist|schema cache/i.test(error.message)
        ? 'v_cost_by_stage is missing, so migration 0030 has not been applied. Run `pnpm db:doctor`.'
        : 'The read failed. This is not an empty ledger — an empty ledger returns every stage with hasRun false.',
    };
  }

  const byStage = new Map<string, Record<string, unknown>>();
  for (const r of data ?? []) byStage.set(String(r.stage), r as Record<string, unknown>);

  const rows: StageCostRow[] = CHARGING_STAGES.map(({ stage, label, what }) => {
    const r = byStage.get(stage);
    if (!r) {
      return {
        stage,
        label,
        what,
        hasRun: false,
        entries: 0,
        scripts: 0,
        settledInr: null,
        openEstimateInr: null,
        unpricedRows: 0,
        inrPerScript: null,
        lastAt: null,
      };
    }
    return {
      stage,
      label,
      what,
      hasRun: true,
      entries: Number(r.entries ?? 0),
      scripts: Number(r.scripts ?? 0),
      settledInr: num(r.settled_inr),
      openEstimateInr: num(r.open_estimate_inr),
      unpricedRows: Number(r.unpriced_rows ?? 0),
      inrPerScript: num(r.inr_per_script),
      lastAt: r.last_at ? String(r.last_at) : null,
    };
  });

  // A stage in the ledger that this module does not know about. Reported rather than
  // dropped: it means somebody added a stage and did not add it here, and silently
  // omitting it from a cost breakdown is how a stage's spend goes unnoticed.
  for (const [stage, r] of byStage) {
    if (CHARGING_STAGES.some((s) => s.stage === stage)) continue;
    rows.push({
      stage,
      label: stage,
      what: 'unknown stage — present in the ledger, absent from CHARGING_STAGES',
      hasRun: true,
      entries: Number(r.entries ?? 0),
      scripts: Number(r.scripts ?? 0),
      settledInr: num(r.settled_inr),
      openEstimateInr: num(r.open_estimate_inr),
      unpricedRows: Number(r.unpriced_rows ?? 0),
      inrPerScript: num(r.inr_per_script),
      lastAt: r.last_at ? String(r.last_at) : null,
    });
  }

  return { ok: true, rows, stagesRun: rows.filter((r) => r.hasRun).length };
}
