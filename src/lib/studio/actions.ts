'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { currentChannel } from '../channels/active';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { env } from '../env';
import { sessionSpendCap } from '../settings/guardrails';
import { resolveCredentials } from '../integrations/credentials';
import { runTurn, startSession, type ToolChannel } from './session';
import { mintSessionToken } from './token';
import { readUsdInrRate } from '../cost/fx';
import { getBible } from '../bureau/bible';
import { channelPolicy } from '../screens/common';
import { readChannelFlags } from '../settings/channel-flags';
import { proposeIdeas, type StudioIdea } from './ideas';

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
  return sessionSpendCap();
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

    // The channel the sidebar has selected. A session makes videos for that channel only, and
    // keeps it if the sidebar changes later — its briefs are on that channel's Approvals.
    const { active } = await currentChannel();
    const brief = String(formData.get('brief') ?? '').trim();
    // The title is the brief's first line, shortened — the whole brief is the first message.
    const firstLine = brief.split(/\n/).find((l) => l.trim())?.trim() ?? '';
    const title = String(formData.get('title') ?? '').trim() || (firstLine ? (firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine) : '');
    const result = await startSession(serverClient(), {
      title: title || undefined,
      channelId: active?.id ?? null,
      spendCapInr: cap,
    });

    if (!result.ok) return { status: 'error', message: result.detail };

    revalidatePath('/studio');
    if (brief) {
      // The session opens either way; a first turn that fails says why on the session screen
      // and the text is in the transcript only if the turn ran.
      const first = await performTurn(result.sessionId, brief);
      return { status: first.status === 'ok' ? 'ok' : first.status, sessionId: result.sessionId, message: first.message };
    }
    return { status: 'ok', sessionId: result.sessionId, message: `Session open on ${active?.name ?? 'the active channel'}. Cap ₹${cap}.` };
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
    return await performTurn(sessionId, text);
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One turn of a session — shared by the composer and by the start form, which sends the box's
 * text as the session's first message (Sahil, 08-Oct: the brief belongs where the session is
 * opened, not in a one-line title). Callers have already checked the user.
 */
async function performTurn(sessionId: string, text: string): Promise<StudioState> {
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

  // Refused, not thrown: a turn writes cost rows, so an unset rate would put a rupee figure
  // nobody configured onto them — and the turn is billed either way.
  const fx = await readUsdInrRate(db);
  if (!fx.ok) {
    return { status: 'error', message: `${fx.reason} ${fx.remedy}` };
  }

  const outcome = await runTurn(sessionId, text, {
    db,
    apiKey,
    usdInrRate: fx.rate,
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
}

export interface IdeasState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  ideas?: StudioIdea[];
}

/**
 * The Ideas button: five ideas for the active channel from its most relevant trends, each with
 * a ready first message. One fast-tier call, ledgered against the channel by the router.
 */
export async function studioIdeasAction(): Promise<IdeasState> {
  try {
    await requireUser();
    const db = serverClient();
    const { active } = await currentChannel();
    if (!active) return { status: 'error', message: 'Pick a channel first.' };
    if (!active.hasBible) return { status: 'error', message: `${active.name} has no bible yet, so it has no series to suggest ideas for.` };
    const apiKey = (await resolveCredentials(db, 'anthropic')).values.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: 'error', message: 'No Anthropic credential is configured (Settings → Integrations).' };
    const fx = await readUsdInrRate(db);
    if (!fx.ok) return { status: 'error', message: `${fx.reason} ${fx.remedy}` };
    const [cb, flags, policy] = await Promise.all([getBible(db, active.id), readChannelFlags(db, active.id), channelPolicy(db, active.id)]);
    const r = await proposeIdeas(
      { id: active.id, name: active.name },
      cb,
      { relevanceThreshold: flags.values.relevanceThreshold, perShortCapInr: policy?.perShortCap ?? null },
      { db, apiKey, usdInrRate: fx.rate },
    );
    if (!r.ok) return { status: 'error', message: r.reason };
    return { status: 'ok', ideas: r.ideas, message: `${r.basis} · ${r.costInr === null ? 'cost —' : `₹${r.costInr.toFixed(2)}`}` };
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
