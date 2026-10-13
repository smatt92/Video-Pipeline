import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import { priceLlmCall, writeLlmCost, type LlmCostSubject } from '../cost/llm';
import type { Json } from '../db/types';
import { RouterError, modelFor, thinkingFor, type RoutedCall, type RouterDeps } from './router';

/**
 * The router's batched sibling: one routed call, sent through the Message Batches API at half
 * the price, and collected on a later tick.
 *
 * For work nobody is waiting on — a caption translation behind a dub that is already queued,
 * the nightly brief safety net. Never for a call a person is watching: a batch can take up to
 * 24 hours, and usually takes minutes to an hour.
 *
 * ── The shape ────────────────────────────────────────────────────────────────
 *
 * `routedBatch(call, deps)` is idempotent on `call.customId`, and a caller simply calls it on
 * every tick until it stops saying 'pending':
 *
 *   no row       → refuse if the batch endpoint is unpriced; record the request; create a
 *                  one-request batch; write the ESTIMATE ledger rows (rule 5: at submit).
 *                  → pending
 *   submitted    → ask the API about the batch. Still running → pending. Ended → read this
 *                  request's result, write the RECONCILE rows from its own usage, store the
 *                  output. → as below
 *   succeeded    → the stored result, checked against the call's schema. → done / failed
 *   errored, expired, canceled → failed, with the reason.
 *
 * `customId` is the batch request's custom_id, the row's primary key and the ledger's
 * idempotency key base, all the same string (rule 6): a result can only land on the call that
 * asked for it, and a second ask for the same key never pays twice.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────────
 *
 * Priced at BATCH_ENDPOINT, whose rate_card rows (0054) are the published 50%. The estimate is
 * written at submit on an estimated quantity — the prompt's characters / 4 for input, and
 * max_tokens as the output's upper bound — labelled `estimate`, never passed off as a
 * measurement. The reconcile is the API's own `usage`. A request that errored or expired is
 * not billed and gets no reconcile: its estimate stays committed-and-unknown rather than being
 * closed by a zero nobody measured.
 */

export const BATCH_ENDPOINT = '/v1/messages/batches';

export interface BatchedCall<S extends z.ZodType> extends RoutedCall<S> {
  /** The idempotency key: the batch custom_id, the row's key, the ledger key base. ≤ 64 chars, [a-zA-Z0-9_-]. */
  customId: string;
}

export type BatchOutcome<T> =
  | { state: 'pending'; customId: string }
  | { state: 'done'; customId: string; data: T; model: string }
  | { state: 'failed'; customId: string; reason: string };

/** The API's own rule for custom_id, checked here so a bad key refuses before anything is sent. */
const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export async function routedBatch<S extends z.ZodType>(
  call: BatchedCall<S>,
  deps: RouterDeps,
): Promise<BatchOutcome<z.infer<S>>> {
  if (!CUSTOM_ID.test(call.customId)) {
    throw new RouterError('upstream', `routedBatch: custom_id "${call.customId}" is not 1–64 of [a-zA-Z0-9_-].`);
  }
  const { data: row, error } = await deps.db
    .from('llm_batch_requests')
    .select('custom_id, task, model, batch_id, status, subject, usd_inr_rate, max_tokens, result, error')
    .eq('custom_id', call.customId)
    .maybeSingle();
  if (error) throw new RouterError('upstream', `routedBatch: could not read ${call.customId}: ${error.message}`);

  if (!row) return submit(call, deps);

  if (row.status === 'submitted') {
    const collected = await collectRow(row as SubmittedRow, deps);
    if (collected === 'submitted') return { state: 'pending', customId: call.customId };
    return routedBatch(call, deps); // re-read: the row now says how it ended
  }
  if (row.status === 'succeeded') return fromStored(call, row.model, row.result);
  if (row.status === 'submitting') {
    // The insert landed and the API's answer did not: the batch may or may not exist, and
    // may or may not be billed. Neither retrying (a possible second charge) nor guessing is
    // safe, so it is reported by name and left for a person.
    return { state: 'failed', customId: call.customId, reason: 'the submit was interrupted before the API answered; check the batches console before retrying under a new key' };
  }
  return { state: 'failed', customId: call.customId, reason: `${row.status}: ${row.error ?? 'no detail'}` };
}

/**
 * Collect every open batch whose custom_id starts with `prefix`, whoever asked for it.
 *
 * The reconcile must not depend on the caller still wanting the result: a dub cancelled while
 * its translation was batched, or a slot that Routine C filled while the safety net's draft
 * was out, would otherwise leave a billed call with no reconcile row for ever (rule 5). Each
 * cron runs this first; it returns what ended on this tick.
 */
export async function sweepBatches(
  prefix: string,
  deps: Pick<RouterDeps, 'db' | 'apiKey' | 'client' | 'signal'>,
): Promise<{ customId: string; status: string; subject: LlmCostSubject }[]> {
  const { data: rows, error } = await deps.db
    .from('llm_batch_requests')
    .select('custom_id, model, batch_id, subject, usd_inr_rate, max_tokens')
    .eq('status', 'submitted')
    .like('custom_id', `${prefix}%`)
    .order('submitted_at')
    .limit(50);
  if (error) throw new RouterError('upstream', `sweepBatches: ${error.message}`);
  const ended: { customId: string; status: string; subject: LlmCostSubject }[] = [];
  for (const row of rows ?? []) {
    const status = await collectRow(row as SubmittedRow, deps);
    if (status !== 'submitted') ended.push({ customId: row.custom_id, status, subject: row.subject as unknown as LlmCostSubject });
  }
  return ended;
}

interface SubmittedRow {
  custom_id: string;
  model: string;
  batch_id: string;
  subject: Json;
  usd_inr_rate: number;
  max_tokens: number;
}

function clientOf(deps: Pick<RouterDeps, 'apiKey' | 'client'>): Pick<Anthropic, 'messages'> {
  return deps.client ?? new Anthropic({ apiKey: deps.apiKey });
}

async function submit<S extends z.ZodType>(call: BatchedCall<S>, deps: RouterDeps): Promise<BatchOutcome<z.infer<S>>> {
  const model = modelFor(call.task);

  // Refuse before spending, at the BATCH rate: a batch-endpoint call priced against
  // '/v1/messages' would be ledgered at twice what it cost.
  const probe = await priceLlmCall(deps.db, { model, endpoint: BATCH_ENDPOINT, usage: { inputTokens: 0, outputTokens: 0 }, usdInrRate: deps.usdInrRate });
  if (!probe.priced) throw new RouterError('unpriced', `Refusing batched ${call.task} on ${model}: ${probe.detail}`);

  // The row first, so a crash after the API accepts the batch leaves a row that says so.
  const { error: insertError } = await deps.db.from('llm_batch_requests').insert({
    custom_id: call.customId,
    task: call.task,
    model,
    subject: deps.subject as unknown as Json,
    usd_inr_rate: deps.usdInrRate,
    max_tokens: call.maxTokens,
  });
  if (insertError) {
    // Two ticks racing on one key: the other one owns it. Nothing was sent from here.
    if (/duplicate key|unique constraint/i.test(insertError.message)) return { state: 'pending', customId: call.customId };
    throw new RouterError('upstream', `routedBatch: could not record ${call.customId}: ${insertError.message}`);
  }

  let batchId: string;
  try {
    const batch = await clientOf(deps).messages.batches.create(
      {
        requests: [
          {
            custom_id: call.customId,
            params: {
              model,
              max_tokens: call.maxTokens,
              system: call.system,
              messages: [{ role: 'user', content: call.user }],
              // The JSON schema alone: a batch request is serialised, and the SDK's parse
              // function would be dropped on the way anyway. Parsing happens in `collect`.
              output_config: { format: { type: 'json_schema', schema: zodOutputFormat(call.schema).schema } },
              ...thinkingFor(model, call.thinking),
            },
          },
        ],
      },
      { signal: deps.signal },
    );
    batchId = batch.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Refused by the API: nothing was billed. Marked errored so the key is not silently reused.
    await deps.db.from('llm_batch_requests').update({ status: 'errored', error: `create: ${detail}`.slice(0, 500), ended_at: new Date().toISOString() }).eq('custom_id', call.customId);
    throw new RouterError('upstream', `routedBatch: ${call.task} batch was not created: ${detail}`);
  }

  await deps.db.from('llm_batch_requests').update({ status: 'submitted', batch_id: batchId }).eq('custom_id', call.customId);

  // Rule 5, at submit: the estimate. Thrown, not swallowed, if it cannot land — the batch is
  // already accepted, and the row above keeps it collectable on the next tick either way.
  const userChars = typeof call.user === 'string' ? call.user.length : JSON.stringify(call.user).length;
  const estimate = await priceLlmCall(deps.db, {
    model,
    endpoint: BATCH_ENDPOINT,
    usage: { inputTokens: Math.ceil((call.system.length + userChars) / 4), outputTokens: call.maxTokens },
    usdInrRate: deps.usdInrRate,
  });
  if (!estimate.priced) throw new RouterError('unpriced', `routedBatch: the batch rate vanished between the probe and the estimate: ${estimate.detail}`);
  await writeLlmCost(deps.db, subjectFor(deps.subject, call.customId), estimate, 'estimate');

  return { state: 'pending', customId: call.customId };
}

/**
 * Ask the API about one submitted request and, if its batch has ended, record how: the
 * reconcile from the result's own usage, then the output. Returns the row's new status.
 *
 * Schema-free on purpose — the sweep collects for callers that may no longer exist — so a
 * 'succeeded' row holds the model's JSON as returned, and the schema is applied when a caller
 * reads it (`fromStored`). Truncation, refusal and unparseable text end as 'errored'.
 */
async function collectRow(
  row: SubmittedRow,
  deps: Pick<RouterDeps, 'db' | 'apiKey' | 'client' | 'signal'>,
): Promise<'submitted' | 'succeeded' | 'errored' | 'expired' | 'canceled'> {
  const client = clientOf(deps);
  const batch = await client.messages.batches.retrieve(row.batch_id, { signal: deps.signal });
  if (batch.processing_status !== 'ended') return 'submitted';

  let found: Anthropic.Messages.Batches.MessageBatchIndividualResponse | null = null;
  for await (const r of await client.messages.batches.results(row.batch_id, { signal: deps.signal })) {
    if (r.custom_id === row.custom_id) {
      found = r;
      break;
    }
  }
  const ended = new Date().toISOString();
  const end = async <T extends 'succeeded' | 'errored' | 'expired' | 'canceled'>(status: T, patch: { error?: string; result?: Json; usage?: Json } = {}): Promise<T> => {
    await deps.db.from('llm_batch_requests').update({ status, ...patch, ended_at: ended }).eq('custom_id', row.custom_id);
    return status;
  };

  if (!found) return end('errored', { error: 'the ended batch carried no result for this custom_id' });
  if (found.result.type !== 'succeeded') {
    // Not billed: no reconcile, and the estimate stays committed-and-unknown.
    const detail = found.result.type === 'errored' ? JSON.stringify(found.result.error).slice(0, 400) : found.result.type;
    return end(found.result.type, { error: detail });
  }

  // Billed from here on. The reconcile lands BEFORE the output is judged, for the router's
  // reason: a bad parse is billed exactly like a good one (rule 5).
  const message = found.result.message;
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  const pricing = await priceLlmCall(deps.db, { model: row.model, endpoint: BATCH_ENDPOINT, usage, usdInrRate: Number(row.usd_inr_rate) });
  if (!pricing.priced) throw new RouterError('unpriced', `routedBatch: ${row.custom_id} was billed and cannot be priced: ${pricing.detail}`);
  await writeLlmCost(deps.db, subjectFor(row.subject as unknown as LlmCostSubject, row.custom_id), pricing);
  const usageJson = { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheWrite5mTokens } as Json;

  if (message.stop_reason === 'refusal') return end('errored', { error: 'refusal: the model declined', usage: usageJson });
  if (message.stop_reason === 'max_tokens') return end('errored', { error: `truncated: hit ${row.max_tokens} tokens before finishing`, usage: usageJson });
  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  try {
    return end('succeeded', { result: JSON.parse(text) as Json, usage: usageJson });
  } catch {
    return end('errored', { error: `no_parse: ${text.slice(0, 200)}`, usage: usageJson });
  }
}

function fromStored<S extends z.ZodType>(call: BatchedCall<S>, model: string, result: Json | null): BatchOutcome<z.infer<S>> {
  // The schema lives with the caller, so it is applied here, every time the result is read —
  // the row holds the model's JSON as returned.
  const checked = call.schema.safeParse(result);
  if (!checked.success) {
    return { state: 'failed', customId: call.customId, reason: `${call.task}: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  return { state: 'done', customId: call.customId, data: checked.data, model };
}

/** The caller's subject, keyed on the batch's custom_id so estimate and reconcile pair up. */
function subjectFor(subject: LlmCostSubject, customId: string): LlmCostSubject {
  return subject.kind === 'script' ? subject : { ...subject, idempotencyKey: `batch:${customId}` };
}
