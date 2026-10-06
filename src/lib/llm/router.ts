import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import { priceLlmCall, writeLlmCost, type LlmCostSubject } from '../cost/llm';
import type { Db } from '../db/server';

/**
 * The model router. One module, one table, every LLM call in the Bureau path goes through
 * `routed()`.
 *
 * No "Jev (TypeSafe)" orchestration module exists in any repository or note reachable from
 * this project (decision 0012 #12), so this is the prompt's fallback, typed:
 *
 *   judge tier   (Opus)    the policy judge, edge cases, the weekly strategy memo, vision QC
 *   writer tier  (Sonnet)  briefs, script polish, shotlists
 *   fast tier    (Haiku)   dedup, metadata, QC triage, comment mining, caption translation
 *
 * The task names the work; the router names the model. A caller never passes a model id,
 * so moving a task between tiers — or a tier to a new model — is one line here.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────────
 *
 * Every call writes its ledger rows through `writeLlmCost`, priced from `rate_card`, and a
 * call whose rate is missing or unverified is refused before it is made (rule 5). Tokens
 * billed on a failed call are still written: a failure path that drops the usage
 * under-reports cost permanently.
 */

export const MODELS = {
  judge: 'claude-opus-5-5',
  writer: 'claude-sonnet-5-5',
  fast: 'claude-haiku-4-5-20251001',
} as const;
export type Tier = keyof typeof MODELS;

export const TASK_TIER = {
  policy_judge: 'judge',
  weekly_strategy: 'judge',
  vision_qc: 'judge',
  brief: 'writer',
  script_polish: 'writer',
  shotlist: 'writer',
  dedup: 'fast',
  metadata: 'fast',
  qc_triage: 'fast',
  comment_mining: 'fast',
  translation: 'fast',
} as const satisfies Record<string, Tier>;
export type RoutedTask = keyof typeof TASK_TIER;

export const ENDPOINT = '/v1/messages';

export function modelFor(task: RoutedTask): string {
  return MODELS[TASK_TIER[task]];
}

export type UserContent = string | Anthropic.Messages.ContentBlockParam[];

export interface RoutedCall<S extends z.ZodType> {
  task: RoutedTask;
  system: string;
  user: UserContent;
  schema: S;
  maxTokens: number;
}

export interface RouterDeps {
  db: Db;
  apiKey: string;
  usdInrRate: number;
  subject: LlmCostSubject;
  /** Injected by harnesses; production builds the SDK client. */
  client?: Pick<Anthropic, 'messages'>;
  signal?: AbortSignal;
}

export interface RoutedResult<T> {
  data: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** null = the rate vanished between the probe and the call; the cost is unknown, not 0. */
  costInr: number | null;
}

export class RouterError extends Error {
  constructor(
    readonly code: 'unpriced' | 'refusal' | 'truncated' | 'no_parse' | 'upstream',
    message: string,
    readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

export async function routed<S extends z.ZodType>(
  call: RoutedCall<S>,
  deps: RouterDeps,
): Promise<RoutedResult<z.infer<S>>> {
  const model = modelFor(call.task);

  // Refuse before spending: price a zero-token call to prove the rate rows exist.
  const probe = await priceLlmCall(deps.db, {
    model,
    endpoint: ENDPOINT,
    usage: { inputTokens: 0, outputTokens: 0 },
    usdInrRate: deps.usdInrRate,
  });
  if (!probe.priced) {
    throw new RouterError('unpriced', `Refusing ${call.task} on ${model}: ${probe.detail}`);
  }

  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });

  let response;
  try {
    response = await client.messages.parse(
      {
        model,
        max_tokens: call.maxTokens,
        system: call.system,
        messages: [{ role: 'user', content: call.user }],
        output_config: { format: zodOutputFormat(call.schema) },
      },
      { signal: deps.signal },
    );
  } catch (err) {
    throw new RouterError('upstream', err instanceof Error ? err.message : String(err));
  }

  const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  const pricing = await priceLlmCall(deps.db, { model, endpoint: ENDPOINT, usage, usdInrRate: deps.usdInrRate });
  if (pricing.priced) await writeLlmCost(deps.db, deps.subject, pricing);
  const costInr = pricing.priced ? pricing.totalInr : null;

  if (response.stop_reason === 'refusal') {
    throw new RouterError('refusal', `${call.task}: the model declined.`, usage);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new RouterError('truncated', `${call.task}: hit ${call.maxTokens} tokens before finishing.`, usage);
  }
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new RouterError('no_parse', `${call.task}: the response did not parse against its schema.`, usage);
  }
  const checked = call.schema.safeParse(parsed);
  if (!checked.success) {
    throw new RouterError(
      'no_parse',
      `${call.task}: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      usage,
    );
  }
  return { data: checked.data, model, usage, costInr };
}
