import type { Db } from '../db/server';

import { fetchAccessToken, type OauthApp } from './youtube';

/**
 * Is the publish credential still working? Asked by doing it, not by reading a date.
 *
 * ── Why there is no `refresh_token_expires_at` anywhere in this codebase ─────
 *
 * Because it cannot be filled in honestly, and a column that cannot be filled in honestly
 * gets filled in dishonestly. Google issues refresh tokens with **no expiry** for a
 * published app and a **seven-day** expiry while the OAuth consent screen is in Testing —
 * and tells you neither which you have nor when the clock started. Any date written there
 * would be a guess rendered as a fact.
 *
 * The failure that produces is the one this project keeps building instruments against:
 * publishing stops working, the screen says the credential is fine until a date in the
 * future, and nothing anywhere is red. Silence, again.
 *
 * So the probe IS the measurement. This performs a real refresh and records what happened,
 * and the screen says "last confirmed working at" — a fact — instead of "expires at" — a
 * guess. It is the same discipline as `consumptionObserved` in
 * `src/lib/pipeline/observability.ts`: a number a screen withholds must be withheld by a
 * probe, not by a constant, so that the day it becomes knowable it appears without anyone
 * remembering to change the code.
 *
 * ── Consecutive failures, not total ──────────────────────────────────────────
 *
 * `token_refresh_failures` resets to 0 on success. A running total would say "this
 * credential has failed nine times", which is true and useless; consecutive failures say
 * "this credential is broken NOW", which is the question an alert is asking.
 */

export interface TokenHealthDeps {
  db: Db;
  app: OauthApp;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export type TokenHealth =
  | { ok: true; channelId: string; expiresAt: string; recoveredFrom: number }
  | { ok: false; channelId: string; code: string; detail: string; consecutiveFailures: number; needsHuman: boolean };

/**
 * Refresh one channel's credential and write the outcome.
 *
 * Returns the outcome rather than throwing, because the caller is a cron that must keep
 * going across channels: one dead credential must not stop the others being checked, and a
 * thrown error in a loop is how that happens.
 */
export async function checkTokenHealth(
  channelId: string,
  deps: TokenHealthDeps,
): Promise<TokenHealth> {
  const { db, app } = deps;
  const now = deps.now ?? (() => new Date());

  const { data: before } = await db
    .from('channels')
    .select('token_refresh_failures')
    .eq('id', channelId)
    .maybeSingle();
  const priorFailures = Number(before?.token_refresh_failures ?? 0);

  const token = await fetchAccessToken(app, deps.fetchImpl);

  if (!token.ok) {
    const consecutive = priorFailures + 1;
    await db
      .from('channels')
      .update({
        token_refresh_error: `${token.code}: ${token.detail}`,
        token_refresh_failures: consecutive,
      })
      .eq('id', channelId);

    return {
      ok: false,
      channelId,
      code: token.code,
      detail: token.detail,
      consecutiveFailures: consecutive,
      // The distinction an alert has to make. `invalid_grant` needs a person to re-consent;
      // everything else is worth retrying. Collapsing them is how a dead credential gets
      // retried for a week while the queue silently stops moving.
      needsHuman: token.credentialRevoked,
    };
  }

  await db
    .from('channels')
    .update({
      token_expires_at: token.expiresAt,
      token_last_refreshed_at: now().toISOString(),
      token_refresh_error: null,
      token_refresh_failures: 0,
    })
    .eq('id', channelId);

  return {
    ok: true,
    channelId,
    expiresAt: token.expiresAt,
    // Non-zero means this run fixed a channel that was failing — worth saying once rather
    // than leaving a person to notice a counter went back to zero.
    recoveredFrom: priorFailures,
  };
}
