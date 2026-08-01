import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import {
  PROMPT_REF,
  SYSTEM_PROMPT,
  buildUserMessage,
  type ShotlistPromptInput,
} from '../prompts/04-shotlist.v1';
import type { TokenUsage } from '../script/draft';
import { ShotlistSchema, resolveShotSpans, type ResolvedShot } from './schema';

/**
 * Stage 4 — break a script into shots.
 *
 * Pure, like `script/draft.ts`: no database, no Trigger, nothing but the API key. The task
 * owns the rows; this owns the call. That split is what let stage 3 be proven for real
 * against a reachable vendor while its database was not, and the same applies here.
 *
 * The vendor is named for the same reason it is in stage 3 — the LLM is the substrate
 * rather than a rotating generator, and `scripts.drafted_by` in SCHEMA.sql treats the
 * drafting model as a recorded fact. See the longer note in `script/draft.ts`.
 */

const MODEL = 'claude-opus-5';
const ENDPOINT = '/v1/messages';
const MAX_TOKENS = 8_000;

export interface ShotlistResult {
  shots: ResolvedShot[];
  raw: string;
  usage: TokenUsage;
  model: string;
  endpoint: string;
  promptRef: string;
}

export type ShotlistFailureCode =
  | 'refusal'
  | 'truncated'
  | 'no_parse'
  | 'schema_violation'
  | 'coverage_violation'
  | 'auth'
  | 'rate_limited'
  | 'upstream';

export class ShotlistError extends Error {
  constructor(
    readonly code: ShotlistFailureCode,
    message: string,
    readonly usage?: TokenUsage,
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'ShotlistError';
  }
}

function classify(err: unknown): ShotlistFailureCode {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) return 'auth';
    if (err.status === 429) return 'rate_limited';
  }
  return 'upstream';
}

export async function draftShotlist(
  input: ShotlistPromptInput,
  opts: { apiKey: string; signal?: AbortSignal },
): Promise<ShotlistResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  let response;
  try {
    response = await client.messages.parse(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(input) }],
        output_config: { format: zodOutputFormat(ShotlistSchema) },
      },
      { signal: opts.signal },
    );
  } catch (err) {
    throw new ShotlistError(classify(err), err instanceof Error ? err.message : String(err));
  }

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  if (response.stop_reason === 'refusal') {
    throw new ShotlistError(
      'refusal',
      `The model declined to shot-list this script. stop_details: ${JSON.stringify(response.stop_details ?? null)}`,
      usage,
    );
  }

  if (response.stop_reason === 'max_tokens') {
    throw new ShotlistError(
      'truncated',
      `Hit the ${MAX_TOKENS}-token ceiling. The shotlist is incomplete and would leave part ` +
        'of the voiceover with nothing on screen.',
      usage,
    );
  }

  const raw = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new ShotlistError('no_parse', 'The response did not parse against the output schema.', usage, raw);
  }

  // Coverage is checked against the *real* vo_text, not against the model's idea of it.
  // A shotlist that is structurally perfect and skips a sentence produces a video with
  // audio nobody is on screen for, and it surfaces two stages later as a sync bug.
  const resolved = resolveShotSpans(parsed, input.voText);
  if (!resolved.ok) {
    throw new ShotlistError(
      'coverage_violation',
      resolved.problems.join('; '),
      usage,
      raw,
    );
  }

  return {
    shots: resolved.shots,
    raw,
    usage,
    model: MODEL,
    endpoint: ENDPOINT,
    promptRef: PROMPT_REF,
  };
}

export { MODEL as SHOTLIST_MODEL, ENDPOINT as SHOTLIST_ENDPOINT };
