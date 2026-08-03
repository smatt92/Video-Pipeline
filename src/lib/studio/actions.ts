'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { env } from '../env';
import { GUARDRAILS } from '../fixtures/settings';
import { resolveCredentials } from '../integrations/credentials';
import { runTurn, startSession, type ToolChannel } from './session';
import { mintSessionToken } from './token';

/**
 * The Studio lane's writes.
 *
 * Same allowlist re-check as every other Server Action here: an action is an HTTP endpoint,
 * and this one starts an agent loop with tool access that spends money. "Has a session" is
 * not the gate; ALLOWED_EMAIL is.
 */

export interface StudioState {
  status: 'idle' | 'ok' | 'error' | 'capped';
  message?: string;
  sessionId?: string;
}

async function requireUser() {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error('Not signed in.');
  if (!checkEmail(user.email).ok) throw new Error('Not permitted.');
}

/**
 * The cap the Guardrails screen proposes.
 *
 * Read from the guardrail rather than from a constant here, so the number the Studio lane
 * enforces and the number that screen displays are the same number. It is still a
 * *default* — `guardrails` is not a table yet and that screen says so — which is exactly
 * why the start form makes the operator see it and lets them change it before the session
 * opens. A cap nobody looked at is not a control, and 0003's own comment on
 * `spend_cap_inr` is about a loop that "can burn a lot of tokens on one bad turn".
 */
export async function proposedSessionCap(): Promise<number | null> {
  const guardrail = GUARDRAILS.find((g) => g.key === 'spend_cap_session_inr');
  const value = Number(guardrail?.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function startSessionAction(
  _prev: StudioState,
  formData: FormData,
): Promise<StudioState> {
  try {
    await requireUser();

    const submitted = Number(String(formData.get('spend_cap_inr') ?? '').trim());
    const cap = Number.isFinite(submitted) && submitted > 0 ? submitted : await proposedSessionCap();

    if (cap === null || !Number.isFinite(cap) || cap <= 0) {
      return {
        status: 'error',
        message:
          'No per-session spend cap is set. Settings → Guardrails → spend cap per Studio ' +
          'session. This is deliberately not defaulted: a cap nobody chose is not a control.',
      };
    }

    const result = await startSession(serverClient(), {
      title: String(formData.get('title') ?? '').trim() || undefined,
      spendCapInr: cap,
    });

    if (!result.ok) return { status: 'error', message: result.detail };

    revalidatePath('/studio');
    return { status: 'ok', sessionId: result.sessionId, message: `Session open. Cap ₹${cap}.` };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTurnAction(
  sessionId: string,
  _prev: StudioState,
  formData: FormData,
): Promise<StudioState> {
  try {
    await requireUser();

    const text = String(formData.get('text') ?? '').trim();
    if (!text) return { status: 'error', message: 'Nothing to send.' };

    const db = serverClient();
    const credentials = await resolveCredentials(db, 'anthropic');
    const apiKey = credentials.values.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return {
        status: 'error',
        message:
          'No Anthropic credential is configured. Settings → Integrations, then Test ' +
          'connection — an unverified integration cannot be selected by a task.',
      };
    }

    const secret = process.env.STUDIO_MCP_TOKEN_SECRET?.trim();
    if (!secret) {
      return {
        status: 'error',
        message:
          'STUDIO_MCP_TOKEN_SECRET is not set, so this deployment cannot mint a token for ' +
          'its own MCP server and the tools would be unreachable.',
      };
    }

    // The production channel. Anthropic dials this URL from its own infrastructure, so it
    // must be the public origin — not a preview hostname that changes on the next push,
    // and never localhost.
    const channel: ToolChannel = {
      kind: 'connector',
      url: new URL('/api/mcp', env.APP_URL).toString(),
      token: mintSessionToken(sessionId, secret),
    };

    const outcome = await runTurn(sessionId, text, {
      db,
      apiKey,
      usdInrRate: env.USD_INR_RATE,
      channel,
    });

    revalidatePath(`/studio/${sessionId}`);

    switch (outcome.kind) {
      case 'replied':
        return {
          status: 'ok',
          message: `₹${outcome.costInr.toFixed(2)} this turn · ₹${outcome.totalInr.toFixed(2)} total`,
        };
      case 'capped':
        return { status: 'capped', message: outcome.reason };
      case 'refused':
        return { status: 'error', message: outcome.reason };
      case 'failed':
        return { status: 'error', message: `${outcome.code}: ${outcome.detail}` };
    }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function archiveSessionAction(sessionId: string): Promise<StudioState> {
  try {
    await requireUser();
    await serverClient()
      .from('studio_sessions')
      .update({
        status: 'archived',
        stopped_at: new Date().toISOString(),
        stopped_reason: 'Archived by the operator.',
      })
      .eq('id', sessionId);

    revalidatePath('/studio');
    revalidatePath(`/studio/${sessionId}`);
    return { status: 'ok', message: 'Archived. The transcript stays — it is evidence.' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
