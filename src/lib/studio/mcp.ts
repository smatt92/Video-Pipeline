import 'server-only';

import { z } from 'zod';

import { toolByName, toolDescriptors, type ToolContext } from './tools';

/**
 * The MCP wire protocol, as a pure function of a JSON-RPC message.
 *
 * Transport-free on purpose. `src/app/api/mcp/route.ts` is a thin shell that authenticates
 * and calls `dispatch`; `scripts/verify-studio.mjs` reaches the same function over a real
 * HTTP server it starts itself. A protocol bug is therefore found by the harness, not
 * inferred from it.
 *
 * ── What the connector actually uses ─────────────────────────────────────────
 *
 * Addendum 01 §2, constraint 2: the connector calls `tools/list` and `tools/call` only.
 * Resources, prompts and sampling are not exposed even if the server implements them. So
 * this server implements the three methods that are reached plus `ping`, and advertises
 * exactly the one capability it has. Implementing resources here would be code that
 * nothing can call — the same category of thing this project keeps deleting.
 *
 * ── Errors, and the two kinds of them ────────────────────────────────────────
 *
 * A *protocol* error — unknown method, malformed params — is a JSON-RPC `error` object.
 * A *tool* error — the tool ran and failed — is a successful JSON-RPC response whose
 * result carries `isError: true`, because the model needs to read it and decide what to
 * do. Collapsing the two would hide a broken argument shape behind "the tool failed".
 *
 * A tool *refusal* is neither: it is `isError: false` with a structured payload. See the
 * note at the top of `tools.ts` — refusing to generate against an empty library is the
 * tool working, and a model told its tool errored will report a fault that does not exist.
 */

/** The revision this server implements. Echoed back when the client asks for it. */
export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

export const SERVER_INFO = {
  name: 'kiln-studio',
  title: 'Kiln Studio',
  version: '0.1.0',
} as const;

const RpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  // Absent on a notification, which is the whole distinction: a notification gets no
  // response at all, and answering one is a protocol violation.
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type RpcId = string | number | null | undefined;

export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function ok(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: RpcId, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns `null` for a notification — the caller answers 202 with no body. Anything else
 * is a response object the caller serialises.
 */
export async function dispatch(message: unknown, ctx: ToolContext): Promise<RpcResponse | null> {
  const parsed = RpcRequest.safeParse(message);
  if (!parsed.success) {
    return fail(
      (message as { id?: RpcId } | null)?.id,
      INVALID_REQUEST,
      'Not a JSON-RPC 2.0 request.',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  const { id, method, params } = parsed.data;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = readProtocolVersion(params);
      return ok(id, {
        // Echo the client's version when it is one we speak, so a client pinned to the
        // older revision is not told to downgrade to a version it did not ask for.
        protocolVersion:
          requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSION,
        capabilities: {
          // No listChanged: the tool set is compiled in, so it cannot change while a
          // connection is open, and advertising a notification we will never send is a
          // promise to a client that may wait for it.
          tools: {},
        },
        serverInfo: SERVER_INFO,
        instructions:
          'Kiln Studio. These tools write real rows in a real pipeline. Generation costs ' +
          'money and cannot be undone by deleting a row. Tools refuse rather than guess: a ' +
          'result with `refused: true` lists every blocker and what would clear it — relay ' +
          'those to the person rather than retrying the same call.',
      });
    }

    // Notifications. Acknowledged by returning nothing, which is what the spec requires.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : ok(id, {});

    case 'tools/list':
      return ok(id, { tools: toolDescriptors() });

    case 'tools/call': {
      const call = ToolCall.safeParse(params);
      if (!call.success) {
        return fail(id, INVALID_PARAMS, 'tools/call needs a `name` and an `arguments` object.');
      }

      const tool = toolByName(call.data.name);
      if (!tool) {
        return fail(
          id,
          INVALID_PARAMS,
          `No tool named "${call.data.name}". Call tools/list for the ones that exist.`,
        );
      }

      try {
        const result = await tool.run(ctx, call.data.arguments ?? {});
        return ok(id, toolResult(result, false));
      } catch (err) {
        // The tool threw. That is a fault, not a refusal — refusals are returned as data —
        // so it comes back as a tool error the model can see and report, with the message
        // preserved. Not as a JSON-RPC error: the request was well-formed.
        const detail = err instanceof Error ? err.message : String(err);
        console.error('[mcp] tool threw', { tool: call.data.name, detail });
        return ok(
          id,
          toolResult(
            {
              ok: false,
              error: detail,
              note:
                'This is a fault in the tool, not a refusal. Report it rather than retrying ' +
                'with different arguments.',
            },
            true,
          ),
        );
      }
    }

    default:
      if (isNotification) return null;
      return fail(id, METHOD_NOT_FOUND, `This server does not implement "${method}".`);
  }
}

const ToolCall = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/**
 * One tool result, in both shapes MCP defines.
 *
 * `content` is the text the model reads; `structuredContent` is the same object for a
 * client that wants it typed. Serialising once and reusing it keeps them from disagreeing,
 * which is a class of bug that only shows up as a model confidently describing a result
 * nobody returned.
 */
function toolResult(payload: unknown, isError: boolean) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError,
  };
}

function readProtocolVersion(params: unknown): string | null {
  if (params && typeof params === 'object' && 'protocolVersion' in params) {
    const v = (params as { protocolVersion?: unknown }).protocolVersion;
    if (typeof v === 'string') return v;
  }
  return null;
}

export { PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR };
