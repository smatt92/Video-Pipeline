import Anthropic from '@anthropic-ai/sdk';

import { priceLlmCall } from '../cost/llm';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { STUDIO_TOOLS, toolDescriptors } from './tools';

/**
 * The Studio agent loop.
 *
 * One user turn in, one assistant turn out, with however many tool calls happen in
 * between. Everything that makes this different from a chat wrapper is in three places:
 * the spend cap stops the session rather than warning about it, the transcript is
 * editorial evidence rather than a debug log, and every turn writes a ledger row before it
 * is treated as having happened.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The one leg that cannot be exercised from a container
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `mcp_servers` is a **server-side** connector. Anthropic's infrastructure makes the HTTP
 * connection to the MCP server URL; the client that called the Messages API does not. That
 * is what Addendum 01 §2 constraint 3 means by "no local servers" — the requirement is not
 * that the URL be reachable from *here*, it is that it be reachable from *Anthropic*.
 *
 * So on a deployment with a public hostname this runs as written and the tools are called
 * over `/api/mcp`. In a development container with no public hostname, that one leg cannot
 * execute, and no amount of local wiring makes it. `ToolChannel` names the two paths
 * honestly rather than pretending there is one:
 *
 *   `connector`  — production. Anthropic fetches `/api/mcp` and runs the tools itself.
 *                  The response carries `mcp_tool_use` / `mcp_tool_result` blocks and the
 *                  loop only re-sends on `pause_turn`.
 *
 *   `bridge`     — verification. The same tool objects, declared as ordinary tools, called
 *                  over real HTTP against the same `/api/mcp` handler by this process.
 *                  Real Anthropic API, real MCP server, real tool implementations, real
 *                  rows. The only substituted component is *who* dials the MCP server.
 *
 * The bridge is not a mock and must not be described as one, but it is also not a run of
 * the production path. `docs/decisions/0008-what-is-unverified.md` records exactly which
 * leg remains unproven.
 */

const MODEL = 'claude-opus-5';
const ENDPOINT = '/v1/messages';
const MAX_TOKENS = 16_000;

/** Required by the connector; see Addendum 01 §2. */
const MCP_BETA = 'mcp-client-2025-11-20';
const MCP_SERVER_NAME = 'kiln';

export type ToolChannel =
  | {
      kind: 'connector';
      /** Public URL of this deployment's `/api/mcp`. Must be reachable from Anthropic. */
      url: string;
      /** The session-scoped bearer minted by `mintSessionToken`. */
      token: string;
    }
  | {
      kind: 'bridge';
      /** Where this process POSTs `tools/call`. The same handler, dialled locally. */
      endpoint: string;
      token: string;
      fetchImpl?: typeof fetch;
    };

export interface SessionDeps {
  db: Db;
  apiKey: string;
  usdInrRate: number;
  channel: ToolChannel;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type TurnOutcome =
  | { kind: 'replied'; text: string; toolCalls: ToolCallRecord[]; costInr: number; totalInr: number }
  | { kind: 'capped'; reason: string; totalInr: number; capInr: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; code: string; detail: string };

export interface ToolCallRecord {
  name: string;
  /** True when the tool returned `refused: true` — a result, not a fault. */
  refused: boolean;
  summary: string;
}

const noop = { info: () => {}, error: () => {} };

export const STUDIO_SYSTEM_PROMPT = `You are the Studio lane of Kiln, an AI video pipeline.

Your job is to help decide what to make and then to make it, using the tools you have been
given. You are talking to the one person who operates this workspace.

How this pipeline works, and what it means for you:

- Production never improvises. A shot can only be generated from a recipe already in the
  prompt library, saved with the exact parameters it was proven with. If the library is
  empty, the honest answer is that nothing can be generated yet — say so and say what would
  change it. Do not invent parameters.
- Generation spends real money and cannot be undone. Every call is costed and every cost is
  recorded, so an experiment you run casually shows up in the cost-per-video figure that
  this whole project is measured by.
- A tool result with "refused": true is the tool working correctly. It lists every blocker
  and what would clear each one. Relay those to the person in plain language. Do not retry
  the same call, and do not describe a refusal as an error or a failure.
- This conversation is stored as editorial evidence. The record of a human making editorial
  judgments is what distinguishes this from templated content under YouTube's
  inauthentic-content policy, so argue for choices rather than just executing them.

Be concise. Prefer asking one sharp question over producing five options.`;

// ═════════════════════════════════════════════════════════════════════════════
// Starting a session
// ═════════════════════════════════════════════════════════════════════════════

export type StartResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: string; detail: string };

/**
 * Open a session.
 *
 * The cap is required, not defaulted. Addendum 01 §4: *"The spend cap is not optional; an
 * agent loop with tool access can burn a lot of tokens on one bad turn."* A default would
 * be a number nobody chose being enforced as though somebody had.
 */
export async function startSession(
  db: Db,
  input: { title?: string; channelId?: string | null; spendCapInr: number },
): Promise<StartResult> {
  if (!Number.isFinite(input.spendCapInr) || input.spendCapInr <= 0) {
    return {
      ok: false,
      code: 'no_spend_cap',
      detail:
        'A session needs a positive spend cap in rupees. Set one in Settings → Guardrails ' +
        '(spend_cap_session_inr). This is not defaulted on purpose.',
    };
  }

  // A cap in rupees is only enforceable if a rupee figure can be computed, and this
  // project's own rule is that an unverified rate produces no rupee figure anywhere. So
  // the pricing is checked here, at zero tokens, rather than discovered after a turn that
  // has already been billed and cannot be attributed.
  const priced = await priceLlmCall(db, {
    model: MODEL,
    endpoint: ENDPOINT,
    usage: { inputTokens: 1, outputTokens: 1 },
    usdInrRate: 1,
  });

  if (!priced.priced) {
    return {
      ok: false,
      code: 'unpriceable',
      detail:
        `A spend cap cannot be enforced against spend that cannot be priced: ${priced.detail} ` +
        'Fix the rate card before opening a session.',
    };
  }

  const { data, error } = await db
    .from('studio_sessions')
    .insert({
      title: input.title?.trim() || null,
      channel_id: input.channelId ?? null,
      model: MODEL,
      spend_cap_inr: input.spendCapInr,
      status: 'active',
      transcript: [] as unknown as Json,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, code: 'insert_failed', detail: error?.message ?? 'No row returned.' };
  }

  return { ok: true, sessionId: data.id };
}

// ═════════════════════════════════════════════════════════════════════════════
// One turn
// ═════════════════════════════════════════════════════════════════════════════

export async function runTurn(
  sessionId: string,
  userText: string,
  deps: SessionDeps,
): Promise<TurnOutcome> {
  const { db } = deps;
  const log = deps.log ?? noop;

  const { data: session } = await db
    .from('studio_sessions')
    .select('id, status, model, transcript, spend_cap_inr, cost_inr, stopped_reason')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session) return { kind: 'failed', code: 'unknown_session', detail: `No session ${sessionId}.` };

  if (session.status !== 'active') {
    return {
      kind: 'refused',
      reason:
        session.stopped_reason ??
        `This session is ${session.status}. Start a new one to keep working.`,
    };
  }

  const cap = session.spend_cap_inr === null ? null : Number(session.spend_cap_inr);
  const spentBefore = Number(session.cost_inr ?? 0);

  if (cap === null) {
    return {
      kind: 'refused',
      reason:
        'This session has no spend cap. It was created before the cap became mandatory, or ' +
        'by something that bypassed startSession. It cannot run.',
    };
  }

  // Checked before the call, not only after it. A session already at its ceiling must not
  // buy one more turn to discover it is at its ceiling.
  if (spentBefore >= cap) {
    await stopSession(
      db,
      sessionId,
      `Stopped at ₹${spentBefore.toFixed(2)} against a ₹${cap.toFixed(2)} cap, before this turn ran.`,
    );
    return { kind: 'capped', reason: 'The cap was already reached.', totalInr: spentBefore, capInr: cap };
  }

  const transcript = readTranscript(session.transcript);
  const messages = toMessages(transcript);
  messages.push({ role: 'user', content: userText });

  const client = new Anthropic({ apiKey: deps.apiKey });
  const toolCalls: ToolCallRecord[] = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = '';
  const appended: TranscriptEntry[] = [
    { role: 'user', content: userText, at: new Date().toISOString() },
  ];

  // Bounded. An agent loop that cannot terminate is the failure mode the cap exists for,
  // and the cap is checked between calls — but a loop that ping-pongs on cheap turns could
  // in principle run for a long time inside one cap. Twelve is generous for a chat turn and
  // finite, which is the property that matters.
  const MAX_ROUNDS = 12;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let response: Anthropic.Messages.Message;

    try {
      response = await callModel(client, messages, deps.channel);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error('studio turn failed', { sessionId, detail });
      return { kind: 'failed', code: classify(err), detail };
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    // Checked before the content is read. On a refusal the blocks are not what was asked
    // for, and reading them first produces a confusing parse error in place of the reason.
    if (response.stop_reason === 'refusal') {
      appended.push({
        role: 'assistant',
        content: response.content as unknown as Json,
        at: new Date().toISOString(),
        stopReason: 'refusal',
      });
      await settleTurn(db, sessionId, appended, { inputTokens, outputTokens }, deps, response.id);
      return {
        kind: 'refused',
        reason: 'The model declined this turn. The tokens are still billed and recorded.',
      };
    }

    messages.push({ role: 'assistant', content: response.content });
    appended.push({
      role: 'assistant',
      content: response.content as unknown as Json,
      at: new Date().toISOString(),
      stopReason: response.stop_reason ?? undefined,
    });

    finalText = textOf(response);
    recordToolCalls(response, toolCalls);

    // `pause_turn` is the connector's "I am mid-tool and need another request". Nothing to
    // execute locally — the tools already ran on Anthropic's side.
    if (response.stop_reason === 'pause_turn') continue;

    if (response.stop_reason === 'tool_use' && deps.channel.kind === 'bridge') {
      const results = await runBridgeTools(response, deps.channel, toolCalls);
      messages.push({ role: 'user', content: results });
      appended.push({
        role: 'user',
        content: results as unknown as Json,
        at: new Date().toISOString(),
        toolResults: true,
      });
      continue;
    }

    break;
  }

  const settled = await settleTurn(
    db,
    sessionId,
    appended,
    { inputTokens, outputTokens },
    deps,
    `${sessionId}:${appended.length}`,
  );

  if (!settled.ok) {
    return { kind: 'failed', code: 'ledger', detail: settled.detail };
  }

  // ── The cap stops, it does not warn ──────────────────────────────────────
  //
  // Read back from the session row, which 0017's trigger derives from the ledger — not
  // from a running total this function maintained. The number the cap is enforced against
  // must not be one the spender computed.
  const { data: after } = await db
    .from('studio_sessions')
    .select('cost_inr')
    .eq('id', sessionId)
    .maybeSingle();

  const total = Number(after?.cost_inr ?? spentBefore + settled.costInr);

  if (total >= cap) {
    const reason =
      `Session stopped: ₹${total.toFixed(2)} spent against a ₹${cap.toFixed(2)} cap. ` +
      'The transcript, the script and the cost rows are all intact — nothing was rolled back, ' +
      'the session simply stops accepting turns.';
    await stopSession(db, sessionId, reason);
    return { kind: 'capped', reason, totalInr: total, capInr: cap };
  }

  return {
    kind: 'replied',
    text: finalText,
    toolCalls,
    costInr: settled.costInr,
    totalInr: total,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The two channels
// ═════════════════════════════════════════════════════════════════════════════

async function callModel(
  client: Anthropic,
  messages: Anthropic.Messages.MessageParam[],
  channel: ToolChannel,
): Promise<Anthropic.Messages.Message> {
  if (channel.kind === 'connector') {
    // Both halves are required. `mcp_servers` declares the connection and the
    // `mcp_toolset` entry in `tools` is what actually exposes the tools to the model —
    // omitting the toolset is a validation error, not a request with no tools.
    return client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: STUDIO_SYSTEM_PROMPT,
      messages,
      mcp_servers: [
        {
          type: 'url',
          url: channel.url,
          name: MCP_SERVER_NAME,
          authorization_token: channel.token,
        },
      ],
      tools: [{ type: 'mcp_toolset', mcp_server_name: MCP_SERVER_NAME }],
      betas: [MCP_BETA],
    }) as unknown as Promise<Anthropic.Messages.Message>;
  }

  return client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: STUDIO_SYSTEM_PROMPT,
    messages,
    // The same names and the same JSON Schemas the MCP server serves from `tools/list`.
    // One source (`tools.ts`), so the two channels cannot drift into describing different
    // tools to the model.
    tools: toolDescriptors().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    })),
  });
}

/**
 * Execute the model's tool calls by dialling the MCP server over HTTP.
 *
 * This is the bridge, and it is deliberately not a function call into `tools.ts`. Going
 * over the wire means the JSON-RPC framing, the bearer check, the session-active check and
 * the result serialisation are all exercised — everything the connector would exercise
 * except which machine opens the socket.
 */
async function runBridgeTools(
  response: Anthropic.Messages.Message,
  channel: Extract<ToolChannel, { kind: 'bridge' }>,
  record: ToolCallRecord[],
): Promise<Anthropic.Messages.ContentBlockParam[]> {
  const doFetch = channel.fetchImpl ?? fetch;
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;

    const rpc = {
      jsonrpc: '2.0',
      id: block.id,
      method: 'tools/call',
      params: { name: block.name, arguments: block.input },
    };

    let payload: unknown;
    let isError = false;

    try {
      const res = await doFetch(channel.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${channel.token}`,
        },
        body: JSON.stringify(rpc),
      });

      const body = await res.json();

      if (body?.error) {
        // A JSON-RPC protocol error. Surfaced to the model as a tool error so it can say
        // what happened rather than silently receiving nothing.
        payload = { ok: false, protocol_error: body.error };
        isError = true;
      } else {
        payload = body?.result?.structuredContent ?? body?.result ?? null;
        isError = body?.result?.isError === true;
      }
    } catch (err) {
      payload = { ok: false, transport_error: err instanceof Error ? err.message : String(err) };
      isError = true;
    }

    const refused =
      !!payload && typeof payload === 'object' && (payload as { refused?: unknown }).refused === true;

    record.push({
      name: block.name,
      refused,
      summary: refused
        ? String((payload as { summary?: unknown }).summary ?? 'refused')
        : isError
          ? 'error'
          : 'ok',
    });

    blocks.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      is_error: isError,
    });
  }

  return blocks;
}

function recordToolCalls(response: Anthropic.Messages.Message, record: ToolCallRecord[]) {
  for (const block of response.content) {
    // The connector's blocks. `mcp_tool_result` carries what the server returned, so the
    // refusal is legible here too — the transcript should not need the model's paraphrase
    // to say whether a tool refused.
    const b = block as unknown as {
      type: string;
      name?: string;
      is_error?: boolean;
      content?: unknown;
    };
    if (b.type !== 'mcp_tool_result') continue;

    const parsed = firstJson(b.content);
    const refused = !!parsed && (parsed as { refused?: unknown }).refused === true;

    record.push({
      name: b.name ?? 'mcp_tool',
      refused,
      summary: refused
        ? String((parsed as { summary?: unknown }).summary ?? 'refused')
        : b.is_error
          ? 'error'
          : 'ok',
    });
  }
}

function firstJson(content: unknown): unknown {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      try {
        return JSON.parse(String((block as { text?: unknown }).text ?? ''));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// Settling: transcript, then ledger
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Persist the turn.
 *
 * Transcript first, ledger second, and the order is deliberate. If the process dies
 * between them the session shows a turn with no cost row, which is visible in
 * `v_studio_session_spend` as ledger_rows lagging the turn count. The other order would
 * lose the evidence and keep the charge, and the transcript is the compliance artifact.
 *
 * The ledger row is keyed on the Anthropic message id, not on a turn index. A retry of the
 * same turn is a second real API call with a second real charge and a new message id, so it
 * writes a second row — which is correct. A re-run of *this function* over the same
 * response writes one row, which is also correct.
 */
async function settleTurn(
  db: Db,
  sessionId: string,
  entries: TranscriptEntry[],
  usage: { inputTokens: number; outputTokens: number },
  deps: SessionDeps,
  idempotencyBase: string,
): Promise<{ ok: true; costInr: number } | { ok: false; detail: string }> {
  const { data: current } = await db
    .from('studio_sessions')
    .select('transcript')
    .eq('id', sessionId)
    .maybeSingle();

  const merged = [...readTranscript(current?.transcript ?? []), ...entries];

  const { error: transcriptError } = await db
    .from('studio_sessions')
    .update({ transcript: merged as unknown as Json })
    .eq('id', sessionId);

  if (transcriptError) {
    return { ok: false, detail: `Transcript write failed: ${transcriptError.message}` };
  }

  const priced = await priceLlmCall(db, {
    model: MODEL,
    endpoint: ENDPOINT,
    usage,
    usdInrRate: deps.usdInrRate,
  });

  if (!priced.priced) {
    // Money moved and cannot be priced. Not swallowed: this is the one accounting failure
    // the project does not tolerate quietly, and `startSession` checks for it precisely so
    // this branch stays unreachable.
    return {
      ok: false,
      detail:
        `The turn was billed and cannot be priced: ${priced.detail} The transcript is saved; ` +
        'the cost is not, and cost-per-video cannot be backfilled.',
    };
  }

  const rows = priced.rows.map((r) => ({
    driver: 'anthropic',
    stage: 'studio',
    entry_kind: 'reconcile' as const,
    studio_session_id: sessionId,
    unit: r.unit,
    quantity: r.quantity,
    cost_usd: r.costUsd,
    cost_inr: r.costInr,
    usd_inr_rate: priced.usdInrRate,
    idempotency_key: `studio:${idempotencyBase}:${r.unit}`,
  }));

  const { error: costError } = await db
    .from('cost_ledger')
    .upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true });

  if (costError) {
    return { ok: false, detail: `Cost ledger write failed after the turn was billed: ${costError.message}` };
  }

  return { ok: true, costInr: priced.totalInr };
}

async function stopSession(db: Db, sessionId: string, reason: string): Promise<void> {
  // One statement. A status of 'capped' with the reason written separately could be
  // interrupted between the two, and a session that says it stopped without saying why is
  // the swallowed exception wearing a status column.
  await db
    .from('studio_sessions')
    .update({
      status: 'capped',
      stopped_at: new Date().toISOString(),
      stopped_reason: reason,
    })
    .eq('id', sessionId);
}

// ═════════════════════════════════════════════════════════════════════════════
// Transcript
// ═════════════════════════════════════════════════════════════════════════════

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  /** A string for a typed user turn, or the API's content blocks verbatim. */
  content: Json;
  at: string;
  stopReason?: string;
  /** Marks a synthetic user turn that carries tool results rather than typed text. */
  toolResults?: boolean;
}

export function readTranscript(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is TranscriptEntry =>
      !!e && typeof e === 'object' && 'role' in e && 'content' in e,
  );
}

/**
 * Rebuild the API's message list from the stored transcript.
 *
 * Verbatim content blocks are what makes this possible, and it is why the transcript
 * stores them rather than a rendered string. Thinking blocks carry signatures that must be
 * passed back unmodified across a tool-use turn; a transcript that kept only the visible
 * text would be unable to continue its own conversation.
 */
export function toMessages(entries: TranscriptEntry[]): Anthropic.Messages.MessageParam[] {
  return entries.map((e) => ({
    role: e.role,
    content: e.content as unknown as Anthropic.Messages.MessageParam['content'],
  }));
}

function textOf(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function classify(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) return 'auth';
    if (err.status === 429) return 'rate_limited';
    if (err.status === 400) return 'invalid_request';
  }
  return 'upstream';
}

export { MODEL as STUDIO_MODEL, ENDPOINT as STUDIO_ENDPOINT, MCP_BETA, MCP_SERVER_NAME, STUDIO_TOOLS };
