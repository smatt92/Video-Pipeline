import { logger, schedules } from '@trigger.dev/sdk';

import { serverClient } from '@/lib/db/server';
import { resolveCredentials } from '@/lib/integrations/credentials';
import { checkTokenHealth } from '@/lib/publish/token-health';

/**
 * Stage 10b — is the publish credential still alive?
 *
 * A letter rather than a number, for the same reason `05b-ingest` carries one: this is part
 * of stage 10, not a stage of its own. Nothing downstream consumes its output; it exists so
 * that stage 10's failure is discovered on a schedule rather than on the evening somebody
 * wants to publish.
 *
 * ── The schedule is the alert ────────────────────────────────────────────────
 *
 * Every six hours. That number comes from the failure it is sized against: while an OAuth
 * consent screen is in Testing, Google expires refresh tokens after **seven days**, and the
 * expiry is silent. Six-hourly means the gap between a credential dying and a row saying so
 * is at most a quarter of a day, against a publishing cadence measured in days.
 *
 * It does not send anything. `channels.token_refresh_failures` and `token_refresh_error`
 * are the alert, and `/publish` reads them — which is the answer to "and what reads this?",
 * named here because a probe nobody reads is the original problem wearing the costume of
 * its solution.
 *
 * ── Why it performs a real refresh rather than checking a date ───────────────
 *
 * There is no date to check. See `src/lib/publish/token-health.ts` — a refresh token's
 * expiry is not knowable, only its death is observable, and the only way to observe it is
 * to use it. A cron that read `token_expires_at` would be checking the ACCESS token, which
 * is a different credential and always about to expire by design.
 *
 * ── Unverified ───────────────────────────────────────────────────────────────
 *
 * Never deployed, never fired. `verify:publish` drives `checkTokenHealth` directly against
 * a stub; the schedule itself has run nowhere. 0008 §13.
 */
export const tokenHealthTask = schedules.task({
  id: '10b-token-health',
  cron: '0 */6 * * *',

  run: async () => {
    const db = serverClient();

    const creds = await resolveCredentials(db, 'youtube');
    if (creds.missing.length > 0) {
      // Not an error and not silence. A workspace that has not configured publishing yet is
      // the normal state in Phase 1, and a cron that threw here would go red every six
      // hours for a thing nobody has done yet — which trains people to ignore it.
      logger.info('publish credential not configured; nothing to check', {
        missing: creds.missing,
      });
      return { checked: 0, healthy: 0, broken: 0, needsHuman: 0 };
    }

    const { data: channels } = await db
      .from('channels')
      .select('id, name')
      .eq('platform', 'youtube')
      .eq('is_active', true);

    const app = {
      clientId: creds.values.YOUTUBE_CLIENT_ID,
      clientSecret: creds.values.YOUTUBE_CLIENT_SECRET,
      refreshToken: creds.values.YOUTUBE_REFRESH_TOKEN,
    };

    let healthy = 0;
    let broken = 0;
    let needsHuman = 0;

    for (const channel of channels ?? []) {
      // Sequential and non-throwing on purpose: one dead credential must not stop the
      // others being checked, and a throw inside a loop is exactly how that happens.
      const health = await checkTokenHealth(channel.id, { db, app });
      if (health.ok) {
        healthy += 1;
        if (health.recoveredFrom > 0) {
          logger.info('credential recovered', {
            channel: channel.name,
            afterFailures: health.recoveredFrom,
          });
        }
      } else {
        broken += 1;
        if (health.needsHuman) needsHuman += 1;
        logger.warn('credential refresh failed', {
          channel: channel.name,
          code: health.code,
          consecutiveFailures: health.consecutiveFailures,
          // The distinction that decides what to do about it. Retrying an invalid_grant
          // for a week is the failure this flag exists to prevent.
          needsHuman: health.needsHuman,
        });
      }
    }

    return { checked: (channels ?? []).length, healthy, broken, needsHuman };
  },
});
