import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import {
  PROMPT_REF,
  SYSTEM_PROMPT,
  buildUserMessage,
  type ConceptPromptInput,
} from '../prompts/02-concept.v1';
import { ProposedConceptsSchema, type ProposedConcept } from './schema';

/**
 * Stage 2 — the model call.
 *
 * Deliberately the same shape as `src/lib/script/draft.ts`, down to the error class and the
 * usage-on-failure rule, because they are the same problem: a billed call whose result may
 * be a refusal, a truncation, or a payload that fails its schema. Three near-identical
 * modules would be the `normalise` duplication again, so the *differences* are worth
 * naming — they are the only reason this is not shared code:
 *
 *   Stage 3 drafts one script for one concept and a failure is total. Stage 2 proposes many
 *   concepts at once and a failure is partial: four good concepts and one with a duplicate
 *   angle is a successful call that cost real money, and throwing it away would be the
 *   expensive half failing over the cheap half.
 *
 * If a third stage needs this shape, that is the point at which the client wrapper becomes
 * shared and this becomes its caller.
 *
 * ── The vendor is named here, like stage 3 ───────────────────────────────────
 *
 * CLAUDE.md rule 1 covers the video and voice vendors, which are config values that rotate.
 * The LLM is the substrate — `scripts.drafted_by` is typed as a recorded fact rather than a
 * swappable slot — and `check:vendors` enforces the two names the rule actually lists.
 */

const MODEL = 'claude-opus-5';
const ENDPOINT = '/v1/messages';

/**
 * Lower than stage 3's ceiling, and that is a judgement rather than a copy.
 *
 * Ten concepts at roughly 120 tokens each is well under 2 000; the headroom is for the
 * rationales. A ceiling that is too high does not cost anything on a well-behaved call —
 * output tokens are billed as produced — but it turns a runaway into an expensive runaway.
 */
const MAX_TOKENS = 4_000;

export type ProposeFailureCode =
  | 'auth'
  | 'rate_limited'
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'upstream';

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Carries the usage, always.
 *
 * The same rule as stage 3 and the same reason: tokens are billed on a refusal and on a
 * truncation exactly as on a success, and a failure path that drops the usage under-reports
 * cost permanently.
 */
export class ProposeError extends Error {
  constructor(
    readonly code: ProposeFailureCode,
    message: string,
    readonly usage?: TokenUsage,
  ) {
    super(message);
    this.name = 'ProposeError';
  }
}

function classify(err: unknown): ProposeFailureCode {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) return 'auth';
    if (err.status === 429) return 'rate_limited';
  }
  return 'upstream';
}

export interface ProposeResult {
  readonly concepts: ProposedConcept[];
  readonly usage: TokenUsage;
  readonly promptRef: string;
}

export async function proposeConcepts(
  input: ConceptPromptInput,
  opts: { apiKey: string; baseURL?: string; signal?: AbortSignal },
): Promise<ProposeResult> {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    // Present so a harness can point this at a local server and exercise the real client,
    // its real retries and its real error classes. Absent in production, where the default
    // is correct and an override would be a way to send traffic somewhere unintended.
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  let response;
  try {
    response = await client.messages.parse(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(input) }],
        output_config: { format: zodOutputFormat(ProposedConceptsSchema) },
      },
      { signal: opts.signal },
    );
  } catch (err) {
    throw new ProposeError(classify(err), err instanceof Error ? err.message : String(err));
  }

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  // Checked before the content is read. On a refusal the content blocks are not the thing
  // you asked for, and reading them first produces a parse error in place of the reason.
  if (response.stop_reason === 'refusal') {
    throw new ProposeError(
      'refusal',
      `The model declined to propose concepts. stop_details: ${JSON.stringify(response.stop_details ?? null)}`,
      usage,
    );
  }

  if (response.stop_reason === 'max_tokens') {
    throw new ProposeError(
      'truncated',
      `Hit the ${MAX_TOKENS}-token ceiling. A truncated batch is not a shorter batch — the ` +
        'last concept is cut mid-object and storing it would put a half-scored row in the ' +
        'queue.',
      usage,
    );
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new ProposeError(
      'invalid_output',
      'The response carried no parsed output despite a normal stop reason.',
      usage,
    );
  }

  return { concepts: parsed.concepts, usage, promptRef: PROMPT_REF };
}

export { MODEL as PROPOSE_MODEL, ENDPOINT as PROPOSE_ENDPOINT };
