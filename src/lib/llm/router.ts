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
  // The Studio session's conversation (studio/session.ts): a tool-use loop, not a routed
  // completion, but the model is still the router's to name.
  studio_session: 'judge',
  brief: 'writer',
  script_polish: 'writer',
  shotlist: 'writer',
  dedup: 'fast',
  metadata: 'fast',
  qc_triage: 'fast',
  comment_mining: 'fast',
  translation: 'fast',
  // Scene stills (0021): a constrained rewrite checked deterministically afterwards — the
  // cheapest tier, because a wrong answer is refused by code, not trusted.
  still_prompt: 'fast',
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
  /** Covers thinking AND text on the 5.x models — thinking tokens are billed as output. */
  maxTokens: number;
  /**
   * 'minimal' sends `thinking: {type: 'between_tools'}`, the lowest setting the 5.x models take
   * ('disabled' is a 400 there). Without it Sonnet 5.5 thinks adaptively by default, and the
   * Built Like That writer (08-Oct) spent its whole 6,000-token budget thinking: stop_reason
   * max_tokens with ZERO characters of text, twice, ₹6 each. Ignored on models that predate it.
   */
  thinking?: 'minimal';
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

/**
 * The SDK's structured-output parser THROWS when the text is not valid JSON — after the whole
 * response, and its usage, has come back. Thrown from inside `messages.parse`, that usage never
 * reached `writeLlmCost`: the first Built Like That draft (08-Oct) was paid for and left no
 * ledger row (rule 5). The parse here returns null instead, so the call lands in the ledger
 * first and then fails as `no_parse` with its stop reason, exactly like any other bad output.
 */
function tolerantFormat<S extends z.ZodType>(schema: S) {
  const format = zodOutputFormat(schema);
  return {
    ...format,
    parse: (content: string) => {
      try {
        return format.parse(content);
      } catch {
        return null;
      }
    },
  } as typeof format;
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
        output_config: { format: tolerantFormat(call.schema) },
        ...(call.thinking === 'minimal' && !model.startsWith('claude-haiku-4') ? { thinking: { type: 'between_tools' } as never } : {}),
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
  // What the model wrote, start and end — the evidence for why a call ran long or broke the JSON.
  const text = (response.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  const kinds = (response.content ?? []).map((b) => b.type).join(',') || 'none';
  const glimpse = `blocks ${kinds}; ${text.length} chars of text; starts ${JSON.stringify(text.slice(0, 160))} … ends ${JSON.stringify(text.slice(-240))}`;
  if (response.stop_reason === 'max_tokens') {
    throw new RouterError('truncated', `${call.task}: hit ${call.maxTokens} tokens before finishing (${glimpse}).`, usage);
  }
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new RouterError('no_parse', `${call.task}: the response did not parse as JSON against its schema (stop_reason ${response.stop_reason}, ${usage.outputTokens} output tokens; ${glimpse}).`, usage);
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
