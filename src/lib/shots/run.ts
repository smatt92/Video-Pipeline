import { llmCostRows, priceLlmCall, writeLlmCost, type LlmPricing } from '../cost/llm';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { compileShot, type LibraryPrompt } from './compile';
import { SHOTLIST_ENDPOINT, SHOTLIST_MODEL, ShotlistError, draftShotlist } from './draft';
import type { ResolvedShot } from './schema';

/**
 * Stage 4, as a plain function. Same split as stage 3: the Trigger task is a wrapper.
 *
 * Two phases with different failure semantics, and keeping them apart is the point.
 *
 *   Authoring the shotlist is a billed LLM call. It can refuse, truncate, or produce a
 *   shotlist that does not cover the voiceover. All three are failures, all three are
 *   charged, and all three write a ledger row.
 *
 *   Compiling driver params is a *lookup*. Finding nothing is not a failure — on a fresh
 *   install the prompt library is empty and every shot comes back unresolved, because
 *   production reads the library and never improvises. The shots are still written, with a
 *   note saying what is missing, and stage 5 declines to submit them.
 */

/**
 * `numeric` crosses PostgREST as a string, and a recipe with no performance row yields
 * `undefined` rather than a row of nulls. Both mean "there is no number here" and both
 * must become `null`, not `0` and not `NaN`: `compileShot` ranks nulls into their own tier
 * on purpose, and a `0` would claim the recipe was tried and failed.
 *
 * `Number()` is a decision, not a conversion, and it is safe here — a ratio and a
 * percentage are both far inside what a double holds exactly.
 */
function numOrNull(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export interface ShotlistPayload {
  scriptId: string;
  targetSeconds: number;
}

export interface ShotlistDeps {
  db: Db;
  apiKey: string;
  usdInrRate: number;
  /** Which driver's recipes to compile against. */
  videoDriver: string;
  runId: string;
  log?: { info(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
}

export type ShotlistRunResult =
  | {
      ok: true;
      scriptId: string;
      shotIds: string[];
      shotCount: number;
      compiled: number;
      unresolved: number;
      costUsd: number;
      costInr: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { ok: false; code: string; detail: string; costInr: number | null };

const noop = { info: () => {}, error: () => {} };

/** The shots rows, as data. Exported so a verification harness writes what production writes. */
export function shotRowsFor(p: {
  scriptId: string;
  shots: ResolvedShot[];
  compiled: Map<number, ReturnType<typeof compileShot>>;
}) {
  return p.shots.map((s) => {
    const outcome = p.compiled.get(s.idx);
    const resolved = outcome?.resolved === true ? outcome : null;

    return {
      script_id: p.scriptId,
      idx: s.idx,
      description: s.description,
      shot_kind: s.shotKind,
      // Provisional and labelled as such. Stage 6 overwrites it from real word timings and
      // flips duration_source, which is the audio-first inversion 0004 exists for: the
      // cheap artifact defines the timeline the expensive one satisfies.
      duration_s: s.authoredDurationS,
      duration_source: 'authored' as const,
      vo_char_start: s.voCharStart,
      vo_char_end: s.voCharEnd,
      prompt_id: resolved?.promptId ?? null,
      // Round-tripped rather than cast. `compiled_params` is the exact payload a driver
      // will be handed and jsonb is what it has to survive as; a value that does not
      // serialise would be stored as `{}` and the shot would generate something nobody
      // asked for.
      compiled_params: resolved ? (JSON.parse(JSON.stringify(resolved.compiledParams)) as Json) : null,
      compiled_at: resolved ? new Date().toISOString() : null,
      compile_note: outcome?.note ?? null,
      status: 'pending' as const,
    };
  });
}

export async function runShotlist(
  payload: ShotlistPayload,
  deps: ShotlistDeps,
): Promise<ShotlistRunResult> {
  const { db, apiKey, usdInrRate, videoDriver, runId } = deps;
  const log = deps.log ?? noop;

  const price = (usage: { inputTokens: number; outputTokens: number }): Promise<LlmPricing> =>
    priceLlmCall(db, {
      model: SHOTLIST_MODEL,
      endpoint: SHOTLIST_ENDPOINT,
      usage,
      usdInrRate,
    });

  // ── 1. The script, and the concept it came from ────────────────────────────
  const { data: script, error: scriptError } = await db
    .from('scripts')
    .select('id, concept_id, hook, beats, cta, vo_text, concepts(title, angle, channels(name, platform, niche))')
    .eq('id', payload.scriptId)
    .single();

  if (scriptError || !script) {
    throw new Error(`Script ${payload.scriptId} not found: ${scriptError?.message}`);
  }
  if (!script.concepts?.channels) {
    throw new Error(`Script ${payload.scriptId} has no channel; nothing sets the register.`);
  }

  const conceptId = script.concept_id;

  // ── 2. Refuse to spend before the spend can be recorded ────────────────────
  const probe = await price({ inputTokens: 0, outputTokens: 0 });
  if (!probe.priced) {
    throw new Error(
      `Refusing to shot-list: the call cannot be priced (${probe.reason}). ${probe.detail}`,
    );
  }

  // ── 3. The call ────────────────────────────────────────────────────────────
  const started = Date.now();
  let shotlist;
  try {
    shotlist = await draftShotlist(
      {
        channel: script.concepts.channels,
        title: script.concepts.title,
        angle: script.concepts.angle,
        hook: script.hook,
        // `beats` is jsonb. Parsed defensively rather than asserted: it crossed a boundary
        // on the way in and it is crossing one on the way out.
        beats: Array.isArray(script.beats)
          ? (script.beats as { t: number; text: string; intent: string }[])
          : [],
        cta: script.cta,
        voText: script.vo_text,
        targetSeconds: payload.targetSeconds,
      },
      { apiKey },
    );
  } catch (err) {
    if (!(err instanceof ShotlistError)) throw err;

    let costInr: number | null = null;
    if (err.usage) {
      const pricing = await price(err.usage);
      if (pricing.priced) {
        await writeLlmCost(
          db,
          { kind: 'failed_draft', conceptId, idempotencyKey: `04-shotlist:${runId}`, stage: '04-shotlist' },
          pricing,
        );
        costInr = pricing.totalInr;
      }
    }

    log.error('shotlist failed', { code: err.code, scriptId: script.id, costInr });
    return { ok: false, code: err.code, detail: err.message, costInr };
  }

  log.info('shot-listed', {
    ms: Date.now() - started,
    shots: shotlist.shots.length,
    inputTokens: shotlist.usage.inputTokens,
    outputTokens: shotlist.usage.outputTokens,
  });

  // ── 4. Compile against the library ─────────────────────────────────────────
  //
  // A lookup, not a generation. An empty library is the expected state on a fresh install
  // and produces unresolved shots with a note, not an error.
  //
  // Performance comes from `v_recipe_performance` rather than from columns on `prompts`.
  // This is the read that made the defect matter: `compile.ts` weights the tier ordering by
  // a performance figure, and the column it used was never written by anything, so every
  // recipe scored null and the weighting was inert. See migration 0025.
  //
  // Two figures since 0034, not one. `ship_rate` is what `win_rate` used to be; the new
  // `median_retention_3s_pct` is the outcome half, and `compileShot` decides which of them
  // a given shot kind is ranked on — see the note there for why that cannot be a column.
  const [{ data: libraryRows }, { data: perfRows }] = await Promise.all([
    db
      .from('prompts')
      .select('id, name, driver, model, template, params, tags, version, is_active, accepts_character_ref'),
    db
      .from('v_recipe_performance')
      .select('prompt_id, times_compiled, last_compiled_at, ship_rate, median_retention_3s_pct'),
  ]);

  const perf = new Map((perfRows ?? []).map((r) => [r.prompt_id, r]));

  const library: LibraryPrompt[] = (libraryRows ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    driver: p.driver,
    model: p.model,
    template: p.template,
    params:
      p.params && typeof p.params === 'object' && !Array.isArray(p.params)
        ? (p.params as Record<string, unknown>)
        : {},
    tags: p.tags ?? [],
    version: p.version,
    isActive: p.is_active,
    shipRate: numOrNull(perf.get(p.id)?.ship_rate),
    // 0–100 in the view (the column is a percentage and its CHECK says so), 0–1 here so
    // the two scores compare like for like inside compileShot. Divided at the boundary,
    // in the mapper, never at the point of use.
    retentionScore: (() => {
      const pct = numOrNull(perf.get(p.id)?.median_retention_3s_pct);
      return pct === null ? null : pct / 100;
    })(),
    // bigint over the wire is a string — see the note in prompts/library.ts.
    timesCompiled: Number(perf.get(p.id)?.times_compiled ?? 0),
    lastCompiledAt: perf.get(p.id)?.last_compiled_at ?? null,
    acceptsCharacterRef: p.accepts_character_ref,
  }));

  // Sequential, not a map — each shot's choice depends on what the previous ones took, so
  // that one recipe cannot compile a whole video and cannot appear twice running. Rotation
  // is a property of the shotlist, not of any single shot.
  const compiled = new Map<number, ReturnType<typeof compileShot>>();
  const chosen: string[] = [];

  for (const s of shotlist.shots) {
    const outcome = compileShot(
      {
        description: s.description,
        intent: s.intent,
        durationS: s.authoredDurationS,
        shotKind: s.shotKind,
      },
      library,
      videoDriver,
      chosen,
    );
    compiled.set(s.idx, outcome);
    if (outcome.resolved) chosen.push(outcome.promptId);
  }

  // ── 5. The rows ────────────────────────────────────────────────────────────
  //
  // Replacing any previous shotlist for this script. A re-run is a re-plan, and leaving
  // the old rows would collide on (script_id, idx) and half-merge two shotlists into a
  // video nobody designed.
  await db.from('shots').delete().eq('script_id', script.id);

  const { data: inserted, error: insertError } = await db
    .from('shots')
    .insert(shotRowsFor({ scriptId: script.id, shots: shotlist.shots, compiled }))
    .select('id, idx');

  if (insertError || !inserted) {
    const pricing = await price(shotlist.usage);
    if (pricing.priced) {
      await writeLlmCost(
        db,
        { kind: 'failed_draft', conceptId, idempotencyKey: `04-shotlist:${runId}`, stage: '04-shotlist' },
        pricing,
      );
    }
    throw new Error(`Shot insert failed after a billed call: ${insertError?.message}`);
  }

  // Record the draws. After the insert, so a failed write does not inflate an exposure
  // counter for shots that do not exist — the counter drives rotation, and a phantom draw
  // pushes a recipe down the queue for a video that was never made.
  for (const promptId of chosen) {
    const { error } = await db.rpc('record_recipe_compile', { p_prompt_id: promptId });
    // Logged, not thrown. The shots are written and generatable; a missed counter degrades
    // rotation slightly and is not worth failing a whole shotlist over.
    if (error) log.error('recipe counter not recorded', { promptId, error: error.message });
  }

  // ── 6. The cost row ────────────────────────────────────────────────────────
  //
  // Charged to the script under this stage's name. 0009 put `stage` in the key precisely
  // for this: stage 3 already charged this script, and without that dimension the two
  // collide. A *re-run* of stage 4 against the same script is still rejected, which is
  // right — it is a re-plan of the same shots, and the ledger keeps the first charge.
  const pricing = await price(shotlist.usage);
  if (!pricing.priced) {
    throw new Error(`Priced before the call and not after (${pricing.reason}): ${pricing.detail}`);
  }

  await writeLlmCost(
    db,
    { kind: 'script', scriptId: script.id, conceptId, stage: '04-shotlist' },
    pricing,
  );

  const resolvedCount = [...compiled.values()].filter((c) => c.resolved).length;

  return {
    ok: true,
    scriptId: script.id,
    shotIds: inserted.map((r) => r.id),
    shotCount: inserted.length,
    compiled: resolvedCount,
    unresolved: inserted.length - resolvedCount,
    costUsd: pricing.totalUsd,
    costInr: pricing.totalInr,
    inputTokens: shotlist.usage.inputTokens,
    outputTokens: shotlist.usage.outputTokens,
  };
}

export { llmCostRows };
