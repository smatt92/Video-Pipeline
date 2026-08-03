import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The bearer token `/api/mcp` accepts.
 *
 * ── Why this route cannot be behind the sign-in gate ─────────────────────────
 *
 * The Messages API's MCP connector is *server-side*: Anthropic's infrastructure makes the
 * HTTP connection to the MCP server URL, not the client that called the Messages API. So
 * the caller of `/api/mcp` in production is Anthropic, carrying no Supabase session and no
 * cookie. Middleware that redirects an unauthenticated request to a sign-in page would
 * turn every tool call into an HTML login form.
 *
 * That leaves a bearer token as the entire authentication, which is the same position the
 * generation callback under `/api/webhooks/` is in and gets the same treatment:
 * constant-time comparison, uninformative refusals, and nothing in the body trusted for
 * authorisation.
 *
 * ── Scoped to one session, deliberately ──────────────────────────────────────
 *
 * A single static token would authenticate every tool call in the workspace, and the tools
 * write shots, materialise scripts and queue renders. Instead the token *is* the session
 * scope: it carries the session id and an HMAC over it, and `ToolContext.sessionId` is
 * read from the token rather than from a tool argument. A model cannot name a session it
 * was not given, and a leaked token reaches one session's data.
 *
 * ── What this token is not ───────────────────────────────────────────────────
 *
 * It does not expire. That is a real limitation and it is recorded rather than hidden: a
 * session is long-lived by nature and there is no refresh path through the connector,
 * which accepts a static `authorization_token` per request. The mitigation is scope, not
 * lifetime — plus revocation, which is why `verifySessionToken` is a signature check and
 * the *caller* still confirms the session is active. Archiving or capping a session stops
 * its token working.
 */

const VERSION = 'k1';

export function mintSessionToken(sessionId: string, secret: string): string {
  const payload = `${VERSION}.${sessionId}`;
  return `${payload}.${sign(payload, secret)}`;
}

export type TokenCheck =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' };

export function verifySessionToken(token: string | null | undefined, secret: string): TokenCheck {
  if (!token) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }

  const payload = `${parts[0]}.${parts[1]}`;
  if (!constantTimeEquals(parts[2], sign(payload, secret))) {
    return { ok: false, reason: 'bad_signature' };
  }

  return { ok: true, sessionId: parts[1] };
}

/** `Authorization: Bearer <token>` → the token. Case-insensitive on the scheme. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Both digests are fixed-width base64url, so a length mismatch here means the token was
 * malformed rather than merely wrong — but it is still compared through a padded buffer,
 * because an early return on length is itself a timing signal.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.alloc(64);
  const right = Buffer.alloc(64);
  Buffer.from(a).copy(left, 0, 0, Math.min(Buffer.byteLength(a), 64));
  Buffer.from(b).copy(right, 0, 0, Math.min(Buffer.byteLength(b), 64));
  return timingSafeEqual(left, right) && Buffer.byteLength(a) === Buffer.byteLength(b);
}
