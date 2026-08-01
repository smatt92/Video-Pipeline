import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import {
  PROMPT_REF,
  SYSTEM_PROMPT,
  buildUserMessage,
  type ScriptPromptInput,
} from '../prompts/03-script.v1';
import {
  DraftedScriptSchema,
  ValidatedScriptSchema,
  estimatedSeconds,
  type DraftedScript,
} from './schema';

/**
 * Stage 3 — draft a script.
 *
 * ── Why this vendor is not behind a driver ───────────────────────────────────
 *
 * CLAUDE.md rule 1 puts the video generator and the voice vendor behind interfaces because
 * they are *config values*: models rotate quarterly and the loop is the durable asset
 * (ARCHITECTURE.md §0.1). The LLM is listed in §1 as the substrate rather than as one of
 * those, and `scripts.drafted_by` in SCHEMA.sql is typed `'claude-opus-5' | 'human'` — the
 * schema itself treats the drafting model as a recorded fact, not a swappable slot. So
 * this module names its vendor deliberately; the CI check enforces the two names the rule
 * actually lists, and this is not one of them.
 *
 * If that changes — if a second LLM has to be supported — the interface goes in
 * `src/lib/drivers/` and this file becomes an implementation of it. It is written as one
 * module with one exported function so that move is small.
 *
 * ── Pure on purpose ──────────────────────────────────────────────────────────
 *
 * No database, no Trigger.dev, no environment beyond the API key. The task in
 * `src/trigger/03-script.ts` owns the rows; this owns the call. That split is what lets
 * the call be exercised for real without a reachable database, which in this environment
 * is the difference between "verified" and "written".
 */

const MODEL = 'claude-opus-5';
const ENDPOINT = '/v1/messages';

/** Enough for the script plus adaptive thinking. A short-form script is a few hundred
 *  tokens; the headroom is for the reasoning, not the output. */
const MAX_TOKENS = 8_000;

/**
 * ── Do not lower the reasoning effort to save money ──────────────────────────
 *
 * Thinking is on by default on this model and dominates the bill: a real run produced 924
 * output tokens for a 415-character script, so roughly 70% of the ₹3.01 was reasoning.
 * Disabling it is the obvious cost lever and it is the wrong one.
 *
 * The arithmetic first. At thirty scripts a month the saving is about ₹63, against ₹300 to
 * ₹1200 of video generation *per video*. It is a rounding error on the number that matters.
 *
 * The real argument is compliance. `structure_hash` exists because YouTube's
 * inauthentic-content policy disqualifies "templated scripts with minor substitutions"
 * (ARCHITECTURE.md §0.2), and the defence is that the beat structure genuinely varies per
 * concept. Three real drafts produced 3, 4 and 4 beats, with a CTA twice out of three —
 * the model deciding structure from the material rather than filling a fixed skeleton.
 * Reasoning is the most likely source of that variation, so lowering effort trades
 * monetisation margin for a rounding error.
 *
 * Revisit on quality grounds if the scripts get worse. Never on cost.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DraftResult {
  script: DraftedScript;
  /** The model's untouched output, for `scripts.draft_raw`. Never the reserialised
   *  object — provenance that has been through a round trip is provenance you edited. */
  raw: string;
  usage: TokenUsage;
  model: string;
  endpoint: string;
  promptRef: string;
  estimatedSeconds: number;
}

export type DraftFailureCode =
  | 'refusal'
  | 'truncated'
  | 'no_parse'
  | 'schema_violation'
  | 'auth'
  | 'rate_limited'
  | 'upstream';

/**
 * A failure that is a row, not a swallowed exception.
 *
 * `usage` is present whenever the call reached the model, because tokens are billed on a
 * refusal and on a truncation exactly as they are on a success. A failure path that drops
 * the usage is a failure path that under-reports cost, and cost-per-video cannot be
 * backfilled (CLAUDE.md rule 5).
 */
export class DraftError extends Error {
  constructor(
    readonly code: DraftFailureCode,
    message: string,
    readonly usage?: TokenUsage,
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'DraftError';
  }
}

function classify(err: unknown): DraftFailureCode {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) return 'auth';
    if (err.status === 429) return 'rate_limited';
  }
  return 'upstream';
}

export async function draftScript(
  input: ScriptPromptInput,
  opts: { apiKey: string; signal?: AbortSignal },
): Promise<DraftResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  let response;
  try {
    response = await client.messages.parse(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(input) }],
        // The structural schema, not the refined one. A decode constraint can honour
        // "3 to 5 beats"; it cannot honour "vo_text must contain every beat". Those rules
        // are checked below, where a violation is a legible validation error rather than
        // a generation that quietly cannot terminate.
        output_config: { format: zodOutputFormat(DraftedScriptSchema) },
      },
      { signal: opts.signal },
    );
  } catch (err) {
    throw new DraftError(
      classify(err),
      err instanceof Error ? err.message : String(err),
    );
  }

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  // Checked before the content is read, not after. On a refusal the content blocks are
  // not the thing you asked for, and reading them first produces a confusing parse error
  // in place of the real reason.
  if (response.stop_reason === 'refusal') {
    throw new DraftError(
      'refusal',
      `The model declined to draft this concept. stop_details: ${JSON.stringify(response.stop_details ?? null)}`,
      usage,
    );
  }

  if (response.stop_reason === 'max_tokens') {
    throw new DraftError(
      'truncated',
      `Hit the ${MAX_TOKENS}-token ceiling before finishing. The draft is incomplete and ` +
        'must not be stored as if it were a script.',
      usage,
    );
  }

  const raw = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Nullable by contract, and it is null exactly when the response did not parse. The
  // guard is the reason nothing here needs `as` — CLAUDE.md forbids casting a parsed
  // external payload, and a cast here would turn a failed parse into a runtime crash two
  // functions away.
  const parsed = response.parsed_output;
  if (!parsed) {
    throw new DraftError(
      'no_parse',
      'The response did not parse against the output schema.',
      usage,
      raw,
    );
  }

  // Second pass: the cross-field rules. Structurally valid and semantically wrong is the
  // interesting failure, and it is the one a constrained decode cannot catch.
  const validated = ValidatedScriptSchema.safeParse(parsed);
  if (!validated.success) {
    throw new DraftError(
      'schema_violation',
      validated.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
      usage,
      raw,
    );
  }

  return {
    script: validated.data,
    raw,
    usage,
    model: MODEL,
    endpoint: ENDPOINT,
    promptRef: PROMPT_REF,
    estimatedSeconds: estimatedSeconds(validated.data),
  };
}

export { MODEL as DRAFT_MODEL, ENDPOINT as DRAFT_ENDPOINT };
