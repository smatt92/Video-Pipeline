import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { priceLlmCall, writeLlmCost } from '../cost/llm';
import type { Db } from '../db/server';
import {
  PROMPT_REF,
  SYSTEM_PROMPT,
  buildUserMessage,
} from '../prompts/09-metadata.v1';
import { MetadataSchema, checkUniqueness } from './schema';

/**
 * Stage 9 — write the publishing metadata for a reviewed render.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * It writes a draft publication and cannot write anything else
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The row lands with `status = 'draft'`, and that is not a convention this function is
 * choosing to follow — `enforce_review_pass` is a DB trigger that refuses `scheduled`,
 * `uploading` or `live` unless the named review's decision is `pass`. Rule 7 forbids an
 * application-level bypass, so this stage does not have one to forget: it writes the draft,
 * and moving it further is a separate act with the gate in front of it.
 *
 * `altered_content_disclosed` is set to `true` here rather than asked of the model. Every
 * video this pipeline makes is synthetic; the value is a policy fact, and a policy fact must
 * not be an opinion. See the note in the prompt.
 *
 * ── Uniqueness is checked, not requested ─────────────────────────────────────
 *
 * The prompt is shown the recent titles and told not to reuse their construction. This
 * reduces the result to a skeleton and compares it anyway, because the intervention and the
 * check must not be the same thing — that is the arrangement `structure_hash` already uses
 * for scripts, and it is the one that catches a prompt quietly drifting.
 *
 * A collision does **not** throw. It is recorded on the row and returned, because one
 * repeat is a coincidence and four is a template, and that judgement belongs to a human
 * looking at the channel rather than to a threshold in here.
 *
 * ── One draft per render, and why that is a billing decision ─────────────────
 *
 * A second run for the same render is refused. The first version allowed it — "metadata is
 * editorial, a second opinion is useful" — and that was wrong for a reason the lint caught
 * before a human did: `runId` was unused, because the charge is keyed on
 * `(script_id, stage, entry_kind, unit)`. A replay would call the vendor, be billed, and
 * have its ledger row swallowed as a duplicate. Money moves, no row lands, and rule 5 has no
 * exceptions.
 *
 * The schema is what decides this: that unique index means one metadata charge per script,
 * full stop. Rather than add a migration to permit a second opinion nobody asked for, the
 * stage refuses — and says how to get one, which is to delete the draft you did not want.
 */

const MODEL = 'claude-opus-5';
const ENDPOINT = '/v1/messages';
const MAX_TOKENS = 2_000;

/** How many published or queued titles the uniqueness check considers. */
const RECENT_WINDOW = 20;

export interface MetadataRunPayload {
  readonly renderId: string;
}

export interface MetadataRunDeps {
  readonly db: Db;
  readonly apiKey: string;
  readonly usdInrRate: number;
  readonly runId: string;
  readonly baseURL?: string;
  readonly log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type MetadataRunResult =
  | {
      ok: true;
      publicationId: string;
      title: string;
      shape: string;
      unique: boolean;
      collidesWith: string[];
      costInr: number | null;
    }
  | { ok: false; code: string; detail: string; costInr: number | null };

const noop = { info: () => {}, error: () => {} };

export async function runMetadata(
  payload: MetadataRunPayload,
  deps: MetadataRunDeps,
): Promise<MetadataRunResult> {
  const { db, apiKey, usdInrRate, runId } = deps;
  const log = deps.log ?? noop;

  const price = (usage: { inputTokens: number; outputTokens: number }) =>
    priceLlmCall(db, { model: MODEL, endpoint: ENDPOINT, usage, usdInrRate });

  // ── 1. The render, its script, its concept, its channel ────────────────────
  const { data: render } = await db
    .from('renders')
    .select('id, script_id, duration_s, status')
    .eq('id', payload.renderId)
    .maybeSingle();

  if (!render) {
    return { ok: false, code: 'no_render', detail: `no render ${payload.renderId}`, costInr: null };
  }

  // ── The render has to be a video before anything describes one ─────────────
  //
  // `status` was already selected here and never looked at, and `duration_s` reached the
  // prompt as `Number(render.duration_s ?? 0)`. Together those made the worst version of
  // the absent-versus-zero mistake this project keeps finding, in the duration path where
  // three bugs have already produced a file that plays and is wrong:
  //
  //   · A queued or failed render has no file. This stage would still pay for a call and
  //     write a draft publication describing it.
  //   · A ready render with no recorded duration would be described to the model as
  //     `runtime: 0s`, and the model would write a title, a description and tags for a
  //     zero-second video — confidently, because 0 is a number and nothing in the prompt
  //     says it might be a missing measurement.
  //
  // Both are refusals rather than defaults, and both sit here, above the pricing probe, so
  // no money moves on a render nobody can describe. Failure states are rows: these codes
  // come back to the Trigger task, which records them.
  if (render.status !== 'ready') {
    return {
      ok: false,
      code: 'render_not_ready',
      detail: `render ${render.id} is ${render.status}; metadata describes a finished video`,
      costInr: null,
    };
  }

  if (render.duration_s === null) {
    return {
      ok: false,
      code: 'no_duration',
      detail:
        `render ${render.id} is ready but has no recorded duration. That is unknown, not ` +
        `zero — describing it as a 0s video is how a wrong runtime reaches a publication.`,
      costInr: null,
    };
  }

  const { data: script } = await db
    .from('scripts')
    .select('id, hook, vo_text, concept_id')
    .eq('id', render.script_id)
    .maybeSingle();

  if (!script) {
    return { ok: false, code: 'no_script', detail: 'the render has no script', costInr: null };
  }

  const { data: concept } = await db
    .from('concepts')
    .select('id, title, angle, channel_id')
    .eq('id', script.concept_id)
    .maybeSingle();

  if (!concept) {
    return { ok: false, code: 'no_concept', detail: 'the script has no concept', costInr: null };
  }

  // Two queries rather than PostgREST's embedded-resource syntax, and deliberately.
  //
  // Stages 3 and 4 read their channel with `concepts(channels(...))`, which is why neither
  // has a database harness: the `pg` shim the other harnesses use has no embed support, so
  // driving them means either a real PostgREST or a second implementation of the query. One
  // extra round trip buys this stage a harness, and a stage with a harness is worth more
  // than a stage with one fewer query.
  const { data: channel } = await db
    .from('channels')
    .select('name, platform, niche')
    .eq('id', concept.channel_id)
    .maybeSingle();

  if (!channel) {
    return { ok: false, code: 'no_channel', detail: 'the concept has no channel', costInr: null };
  }

  // ── 2. The review must have passed ─────────────────────────────────────────
  //
  // Read here so the refusal is legible. Writing a draft publication with a failed review
  // would be permitted — the trigger only guards the publishing statuses — and it would
  // produce a queue entry nobody can ever publish, which reads as the gate being broken
  // rather than as the review being the reason.
  const { data: review } = await db
    .from('reviews')
    .select('id, decision')
    .eq('render_id', render.id)
    .eq('decision', 'pass')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Before the spend, like every other refusal here. See the note above: a second run is
  // billed by the vendor and cannot be recorded, so it must not happen.
  const { data: existing } = await db
    .from('publications')
    .select('id')
    .eq('render_id', render.id)
    .limit(1)
    .maybeSingle();

  if (existing) {
    return {
      ok: false,
      code: 'already_has_metadata',
      detail:
        `this render already has publication ${existing.id}. A second run would be billed ` +
        'and its charge could not be recorded — the ledger allows one metadata charge per ' +
        'script. Delete the draft you do not want, then run again.',
      costInr: null,
    };
  }

  if (!review) {
    return {
      ok: false,
      code: 'no_passing_review',
      detail:
        'this render has no review with decision "pass". Metadata is written for videos a ' +
        'human has approved; writing it earlier would put an unpublishable row in the queue.',
      costInr: null,
    };
  }

  // ── 3. Refuse to spend before the spend can be recorded ────────────────────
  const probe = await price({ inputTokens: 0, outputTokens: 0 });
  if (!probe.priced) {
    return {
      ok: false,
      code: 'unpriced',
      detail: `Refusing to write metadata: the call cannot be priced (${probe.reason}). ${probe.detail}`,
      costInr: null,
    };
  }

  // ── 4. What the channel has already said ───────────────────────────────────
  const { data: recent } = await db
    .from('publications')
    .select('title, created_at')
    .eq('channel_id', concept.channel_id)
    .order('created_at', { ascending: false })
    .limit(RECENT_WINDOW);

  const recentTitles = (recent ?? []).map((r) => r.title);

  // ── 5. The call ────────────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey, ...(deps.baseURL ? { baseURL: deps.baseURL } : {}) });

  let response;
  try {
    response = await client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildUserMessage({
            channel,
            concept: { title: concept.title, angle: concept.angle },
            hook: script.hook,
            voText: script.vo_text,
            recentTitles,
            durationSeconds: Number(render.duration_s),
          }),
        },
      ],
      output_config: { format: zodOutputFormat(MetadataSchema) },
    });
  } catch (err) {
    return {
      ok: false,
      code: 'upstream',
      detail: err instanceof Error ? err.message : String(err),
      costInr: null,
    };
  }

  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  // ── 6. The charge, before anything that can fail on its own ────────────────
  const pricing = await price(usage);
  if (!pricing.priced) {
    throw new Error(`The call was billed and cannot now be priced: ${pricing.detail}`);
  }
  await writeLlmCost(
    db,
    {
      kind: 'script',
      scriptId: script.id,
      conceptId: concept.id,
      stage: '09-metadata',
    },
    pricing,
  );
  const costInr = pricing.rows.reduce((n, r) => n + r.costInr, 0);

  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
    return {
      ok: false,
      code: response.stop_reason === 'refusal' ? 'refusal' : 'truncated',
      detail: `the model stopped with "${response.stop_reason}" — no metadata was produced`,
      costInr,
    };
  }

  const meta = response.parsed_output;
  if (!meta) {
    return { ok: false, code: 'invalid_output', detail: 'no parsed output', costInr };
  }

  // ── 7. The check on the intervention ───────────────────────────────────────
  const verdict = checkUniqueness(meta.title, recentTitles);
  if (!verdict.unique) {
    log.info('title reuses a shape already on this channel', {
      shape: verdict.shape,
      collidesWith: verdict.collidesWith,
    });
  }

  // ── 8. The draft ───────────────────────────────────────────────────────────
  const { data: publication, error } = await db
    .from('publications')
    .insert({
      render_id: render.id,
      channel_id: concept.channel_id,
      review_id: review.id,
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      // A policy fact, not a model's opinion. Every video here is synthetic.
      altered_content_disclosed: true,
      // The only status this stage may write. See the note at the top — the gate is a DB
      // trigger and rule 7 forbids an application-level way around it.
      status: 'draft',
    })
    .select('id')
    .maybeSingle();

  if (error || !publication) {
    return {
      ok: false,
      code: 'refused',
      detail: `the publication row was refused: ${error?.message}`,
      costInr,
    };
  }

  log.info('metadata written', {
    publicationId: publication.id,
    runId,
    unique: verdict.unique,
    costInr,
  });

  return {
    ok: true,
    publicationId: publication.id,
    title: meta.title,
    shape: verdict.shape,
    unique: verdict.unique,
    collidesWith: verdict.collidesWith,
    costInr,
  };
}

export { PROMPT_REF as METADATA_PROMPT_REF };
