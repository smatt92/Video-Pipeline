import type { DriverErrorCode } from './types';

/**
 * One fetch wrapper for the vendors reached over plain HTTP (no SDK): a timeout, a
 * classified failure, and a body that is never trusted before a Zod parse at the caller.
 *
 * Every vendor here is treated as unreliable (CLAUDE.md): a request that hangs is a
 * failure with a code, not a worker held open until the run's maxDuration.
 */

export interface HttpOk {
  ok: true;
  status: number;
  json: unknown;
  headers: Headers;
}

export interface HttpFail {
  ok: false;
  status: number | null;
  code: DriverErrorCode;
  detail: string;
  retryAfterS: number | null;
}

export type HttpResult = HttpOk | HttpFail;

export function classifyStatus(status: number, body: string): DriverErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'insufficient_credits';
  if (status === 404) return 'not_found';
  if (status === 409) return 'concurrency_limited';
  if (status === 429 || /RESOURCE_EXHAUSTED|THROTTLED/i.test(body)) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_input';
  if (status >= 500) return 'upstream';
  return 'unknown';
}

export async function httpJson(
  url: string,
  init: RequestInit & { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HttpResult> {
  const { timeoutMs = 60_000, fetchImpl = fetch, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      return {
        ok: false,
        status: res.status,
        code: classifyStatus(res.status, text),
        detail: redactSecrets(text).slice(0, 500) || `HTTP ${res.status}`,
        retryAfterS: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      };
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: res.status,
          code: 'upstream',
          detail: 'The vendor answered 2xx with a body that is not JSON.',
          retryAfterS: null,
        };
      }
    }
    return { ok: true, status: res.status, json, headers: res.headers };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: null,
      code: aborted ? 'timeout' : 'upstream',
      detail: err instanceof Error ? err.message : String(err),
      retryAfterS: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function redactSecrets(s: string): string {
  return s.replace(/([?&]key=)[^&\s"]+/gi, '$1[redacted]').replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}
