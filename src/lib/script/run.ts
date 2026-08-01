import { priceLlmCall, writeLlmCost } from '../cost/llm';
import type { Db } from '../db/server';
import { DRAFT_ENDPOINT, DRAFT_MODEL, DraftError, draftScript, type DraftResult } from './draft';
import { structureHash } from './structure-hash';

/**
 * Stage 3, as a plain function.
 *
 * The Trigger task in `src/trigger/03-script.ts` is a wrapper around this and contains no
 * logic of its own. The split exists so the leg can be run for real from a script — against
 * the same database, through the same code — without a Trigger deployment. CLAUDE.md rule 8
 * says a feature is done when it has run against real APIs; a verification path that
 * reimplements the thing it verifies proves only that two pieces of code agree.
 */

export interface ScriptDraftPayload {
  conceptId: string;
  targetSeconds: number;
}

export interface ScriptDraftDeps {
  db: Db;
  apiKey: string;
  usdInrRate: number;
  /** Stable across retries of one logical attempt. The Trigger run id; anything stable
   *  otherwise. Used to keep a failed draft from being charged twice. */
  runId: string;
  log?: { info(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
}

export type ScriptDraftResult =
  | {
      ok: true;
      scriptId: string;
      version: number;
      structureHash: string;
      costUsd: number;
      costInr: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { ok: false; code: string; detail: string; costInr: number | null };

const noop = { info: () => {}, error: () => {} };

/**
 * The scripts row, as data.
 *
 * Pure and exported so a verification harness writes the same row production writes rather
 * than its own approximation of it. The provenance fields are the point: `drafted_by` names
 * the model, `draft_raw` is the model's untouched output — not the reserialised object,
 * because provenance that has been through a round trip is provenance you edited — and
 * `human_edit_count` stays 0 until a human touches it, which the publish gate requires to
 * be non-zero (ARCHITECTURE.md §0.2).
 */
export function scriptRowFor(p: {
  conceptId: string;
  version: number;
  draft: DraftResult;
  structureHash: string;
}) {
  return {
    concept_id: p.conceptId,
    version: p.version,
    hook: p.draft.script.hook,
    beats: p.draft.script.beats,
    cta: p.draft.script.cta,
    vo_text: p.draft.script.vo_text,
    drafted_by: p.draft.model,
    draft_raw: p.draft.raw,
    structure_hash: p.structureHash,
  };
}

export async function runScriptDraft(
  payload: ScriptDraftPayload,
  deps: ScriptDraftDeps,
): Promise<ScriptDraftResult> {
  const { db, apiKey, usdInrRate, runId } = deps;
  const log = deps.log ?? noop;

  const price = (usage: { inputTokens: number; outputTokens: number }) =>
    priceLlmCall(db, {
      model: DRAFT_MODEL,
      endpoint: DRAFT_ENDPOINT,
      usage,
      usdInrRate,
    });

  // ── 1. The concept and its channel ─────────────────────────────────────────
  const { data: concept, error: conceptError } = await db
    .from('concepts')
    .select('id, title, angle, status, channels(name, platform, niche)')
    .eq('id', payload.conceptId)
    .single();

  if (conceptError || !concept) {
    throw new Error(`Concept ${payload.conceptId} not found: ${conceptError?.message}`);
  }
  if (!concept.channels) {
    throw new Error(`Concept ${payload.conceptId} has no channel; nothing sets the register.`);
  }

  // ── 2. Refuse to spend before the spend can be recorded ────────────────────
  //
  // Rule 5 in its strongest form. A zero-token probe costs nothing and establishes that
  // both rates exist and are verified. Discovering afterwards that the call cannot be
  // priced leaves money spent and unaccounted, and cost-per-video cannot be backfilled.
  const probe = await price({ inputTokens: 0, outputTokens: 0 });
  if (!probe.priced) {
    throw new Error(
      `Refusing to draft: the call cannot be priced (${probe.reason}). ${probe.detail}\n\n` +
        'Every call that costs money writes a ledger row at the time it is made, and a ' +
        'row that cannot be written is a call that must not be made.',
    );
  }

  // ── 3. The call ────────────────────────────────────────────────────────────
  const started = Date.now();
  let draft;
  try {
    draft = await draftScript(
      {
        channel: concept.channels,
        title: concept.title,
        angle: concept.angle,
        targetSeconds: payload.targetSeconds,
      },
      { apiKey },
    );
  } catch (err) {
    if (!(err instanceof DraftError)) throw err;

    // Billed on a refusal and on a truncation exactly as on a success. The row goes in
    // before anything else, keyed on the run id so a retried attempt does not add a second
    // charge for the same call.
    let costInr: number | null = null;
    if (err.usage) {
      const pricing = await price(err.usage);
      if (pricing.priced) {
        await writeLlmCost(
          db,
          { kind: 'failed_draft', conceptId: concept.id, idempotencyKey: `03-script:${runId}` },
          pricing,
        );
        costInr = pricing.totalInr;
      }
    }

    log.error('draft failed', { code: err.code, conceptId: concept.id, costInr });

    // A failure state is a row. `killed_reason` carries it on the concept, where someone
    // is looking, rather than only in a task log nobody opens.
    await db
      .from('concepts')
      .update({ killed_reason: `03-script ${err.code}: ${err.message}`.slice(0, 2000) })
      .eq('id', concept.id);

    return { ok: false, code: err.code, detail: err.message, costInr };
  }

  log.info('drafted', {
    ms: Date.now() - started,
    inputTokens: draft.usage.inputTokens,
    outputTokens: draft.usage.outputTokens,
    estimatedSeconds: Math.round(draft.estimatedSeconds),
  });

  // ── 4. The script row ──────────────────────────────────────────────────────
  //
  // Version is computed rather than defaulted so a replay produces v2 instead of colliding
  // on the (concept_id, version) unique constraint. Racy in principle — two concurrent
  // drafts of one concept could read the same max — and the constraint is what catches it,
  // which is the right place for it to be caught.
  const { data: latest } = await db
    .from('scripts')
    .select('version')
    .eq('concept_id', concept.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const version = (latest?.version ?? 0) + 1;
  const hash = structureHash(draft.script);

  const { data: script, error: scriptError } = await db
    .from('scripts')
    .insert(scriptRowFor({ conceptId: concept.id, version, draft, structureHash: hash }))
    .select('id, version')
    .single();

  if (scriptError || !script) {
    // The call has already been billed and the charge has nowhere to go but the concept.
    // Recording it there is worth more than a clean-looking failure.
    const pricing = await price(draft.usage);
    if (pricing.priced) {
      await writeLlmCost(
        db,
        { kind: 'failed_draft', conceptId: concept.id, idempotencyKey: `03-script:${runId}` },
        pricing,
      );
    }
    throw new Error(`Script insert failed after a billed call: ${scriptError?.message}`);
  }

  // ── 5. The cost row ────────────────────────────────────────────────────────
  const pricing = await price(draft.usage);
  if (!pricing.priced) {
    // Cannot happen: step 2 established both rates before the call, and rates are
    // superseded by insert rather than UPDATE. Throwing rather than logging, because if it
    // does happen the ledger is wrong and everything downstream is a number nobody can
    // trust.
    throw new Error(`Priced before the call and not after (${pricing.reason}): ${pricing.detail}`);
  }

  await writeLlmCost(db, { kind: 'script', scriptId: script.id, conceptId: concept.id }, pricing);

  return {
    ok: true,
    scriptId: script.id,
    version: script.version,
    structureHash: hash,
    costUsd: pricing.totalUsd,
    costInr: pricing.totalInr,
    inputTokens: draft.usage.inputTokens,
    outputTokens: draft.usage.outputTokens,
  };
}
