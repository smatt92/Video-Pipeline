import 'server-only';

import { priceLlmCall, writeLlmCost } from '../cost/llm';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import {
  PROPOSE_ENDPOINT,
  PROPOSE_MODEL,
  ProposeError,
  proposeConcepts,
} from './propose';
import { scoreTotal, validateConcepts } from './schema';

/**
 * Stage 2 — concept generation, end to end.
 *
 * Separated from the Trigger task for the reason every other stage is: the task is a
 * wrapper, and this is the thing a harness can drive with a different transport. Same
 * arrangement as `src/lib/script/run.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this stage exists before stage 1
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Trend intake without concept generation produces a table nobody reads. Concept generation
 * without trend intake still works — from the operator's seed, or from the model's own
 * knowledge of the niche — so building this first makes stage 1 immediately useful, and
 * building stage 1 first does not.
 *
 * That is why `signals` may be empty and why the prompt says so in words rather than
 * sending an empty array and hoping. An empty list of signals is a normal state for months,
 * not an error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Concepts land as drafts, always
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here approves anything. `status = 'draft'` on every row, and the human gate in
 * ARCHITECTURE.md §4 stays a human gate — `approveConcept` is the only thing that moves a
 * concept out of draft, and it is a compare-and-set precisely so this stage cannot race it.
 *
 * A high score is not an approval. It is an ordering.
 */

export interface ConceptRunPayload {
  readonly channelId: string;
  /** How many to propose. Small by default: a queue of thirty drafts is not a queue. */
  readonly count?: number;
  /** Optional operator seed, used when there are no signals or to steer a batch. */
  readonly seed?: string;
}

export interface ConceptRunDeps {
  readonly db: Db;
  readonly apiKey: string;
  readonly usdInrRate: number;
  /** Stable across attempts of the same run — the ledger's idempotency key needs it. */
  readonly runId: string;
  readonly baseURL?: string;
  readonly log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type ConceptRunResult =
  | {
      ok: true;
      channelId: string;
      created: { id: string; title: string; scoreTotal: number; ipRisk: string }[];
      rejected: { title: string; reason: string }[];
      costInr: number | null;
    }
  | { ok: false; code: string; detail: string; costInr: number | null };

const noop = { info: () => {}, error: () => {} };

/** How many recent titles the model is shown, so it does not re-propose them. */
const RECENT_WINDOW = 40;

/** Trend signals considered. Newest first; the model is not helped by a hundred. */
const SIGNAL_WINDOW = 25;

export async function runConcepts(
  payload: ConceptRunPayload,
  deps: ConceptRunDeps,
): Promise<ConceptRunResult> {
  const { db, apiKey, usdInrRate, runId } = deps;
  const log = deps.log ?? noop;
  const count = payload.count ?? 5;

  const price = (usage: { inputTokens: number; outputTokens: number }) =>
    priceLlmCall(db, {
      model: PROPOSE_MODEL,
      endpoint: PROPOSE_ENDPOINT,
      usage,
      usdInrRate,
    });

  // ── 1. The channel ─────────────────────────────────────────────────────────
  const { data: channel, error: channelError } = await db
    .from('channels')
    .select('id, name, platform, niche')
    .eq('id', payload.channelId)
    .maybeSingle();

  if (channelError || !channel) {
    return {
      ok: false,
      code: 'no_channel',
      detail: `Channel ${payload.channelId} not found: ${channelError?.message ?? 'no row'}`,
      costInr: null,
    };
  }

  // ── 2. Refuse to spend before the spend can be recorded ────────────────────
  //
  // Rule 5, the same zero-token probe stage 3 uses. Discovering after the call that it
  // cannot be priced leaves money spent and unaccounted.
  const probe = await price({ inputTokens: 0, outputTokens: 0 });
  if (!probe.priced) {
    return {
      ok: false,
      code: 'unpriced',
      detail:
        `Refusing to propose: the call cannot be priced (${probe.reason}). ${probe.detail} ` +
        'Every call that costs money writes a ledger row at the time it is made, and a row ' +
        'that cannot be written is a call that must not be made.',
      costInr: null,
    };
  }

  // ── 3. What the model is shown ─────────────────────────────────────────────
  const { data: signals } = await db
    .from('trend_signals')
    .select('source, term, region, velocity, volume')
    .order('captured_at', { ascending: false })
    .limit(SIGNAL_WINDOW);

  // Every non-killed concept, because a killed one is a judgement that this idea is not
  // wanted — re-proposing it is exactly what the operator said no to.
  const { data: recent } = await db
    .from('concepts')
    .select('title, status')
    .eq('channel_id', channel.id)
    .neq('status', 'killed')
    .order('created_at', { ascending: false })
    .limit(RECENT_WINDOW);

  // ── 4. The call ────────────────────────────────────────────────────────────
  let result;
  try {
    result = await proposeConcepts(
      {
        channel: { name: channel.name, platform: channel.platform, niche: channel.niche },
        count,
        signals: (signals ?? []).map((s) => ({
          source: s.source,
          term: s.term,
          region: s.region,
          velocity: s.velocity,
          volume: s.volume,
        })),
        recentTitles: (recent ?? []).map((r) => r.title),
        seed: payload.seed,
      },
      { apiKey, baseURL: deps.baseURL },
    );
  } catch (err) {
    if (!(err instanceof ProposeError)) throw err;

    // Billed on a refusal and on a truncation exactly as on a success. Keyed on the run id
    // so a retried attempt does not add a second charge for the same call.
    let costInr: number | null = null;
    if (err.usage) {
      const pricing = await price(err.usage);
      if (pricing.priced) {
        await writeLlmCost(
          db,
          {
            kind: 'channel',
            channelId: channel.id,
            idempotencyKey: `02-concept:${runId}:failed`,
            stage: '02-concept',
          },
          pricing,
        );
        costInr = pricing.rows.reduce((n, r) => n + r.costInr, 0);
      }
    }

    log.error('concept proposal failed', { code: err.code, detail: err.message, costInr });
    return { ok: false, code: err.code, detail: err.message, costInr };
  }

  // ── 5. The charge, before the rows ─────────────────────────────────────────
  //
  // The call has happened and the money is gone; recording it comes before anything that
  // could fail on its own. A concept row refused by a constraint must not take the charge
  // down with it.
  const pricing = await price(result.usage);
  if (!pricing.priced) {
    // Unreachable in practice — the probe above established both rates — but a rate deleted
    // mid-run would land here, and silently dropping the charge is the one thing rule 5
    // forbids outright.
    throw new Error(
      `The call was billed and cannot now be priced (${pricing.reason}). ${pricing.detail}`,
    );
  }

  await writeLlmCost(
    db,
    {
      kind: 'channel',
      channelId: channel.id,
      idempotencyKey: `02-concept:${runId}`,
      stage: '02-concept',
    },
    pricing,
  );
  const costInr = pricing.rows.reduce((n, r) => n + r.costInr, 0);

  // ── 6. Validate, then write ────────────────────────────────────────────────
  const { kept, rejected } = validateConcepts(result.concepts);

  if (rejected.length > 0) {
    // Not silent. A batch that loses half its concepts to duplicate angles means the prompt
    // is drifting or the trend is thin, and both are worth seeing before the queue empties.
    log.info('concepts rejected in validation', { rejected });
  }

  const created: { id: string; title: string; scoreTotal: number; ipRisk: string }[] = [];

  for (const c of kept) {
    const total = scoreTotal(c.scores);

    const { data: row, error } = await db
      .from('concepts')
      .insert({
        channel_id: channel.id,
        title: c.title,
        angle: c.angle,
        source_signals: c.from_signals,
        rubric_version: result.promptRef,
        scores: { ...c.scores, rationale: c.rationale } as Json,
        score_total: total,
        ip_risk: c.ip_risk,
        // Never anything else. See the note at the top: a score is an ordering, not an
        // approval, and `approveConcept` is the only path out of draft.
        status: 'draft',
      })
      .select('id')
      .maybeSingle();

    if (error || !row) {
      // A row, not an exception, and not a reason to abandon the rest of a paid-for batch.
      rejected.push({ title: c.title, reason: `refused by the database: ${error?.message}` });
      continue;
    }

    created.push({ id: row.id, title: c.title, scoreTotal: total, ipRisk: c.ip_risk });
  }

  log.info('concepts proposed', {
    channelId: channel.id,
    created: created.length,
    rejected: rejected.length,
    costInr,
  });

  return { ok: true, channelId: channel.id, created, rejected, costInr };
}
