import { logger, schedules } from '@trigger.dev/sdk';

import { pullBureauMetrics } from '@/lib/bureau/metrics-pull';
import { serverClient } from '@/lib/db/server';
import { resolveCredentials } from '@/lib/integrations/credentials';
import { spend } from '@/lib/publish/quota';
import { fetchAccessToken } from '@/lib/publish/youtube';
import { commentThreads, shortsMetrics } from '@/lib/publish/yt-analytics';

/**
 * Bureau metric pulls at 1h / 24h / 72h / 7d after each slot, and comment ingestion
 * (character mentions, Complaint Box scores), hourly at :17.
 *
 * Reads only publications that know their YouTube video id (mark_scheduled with video_url,
 * or a 10-publish upload). Comment reads spend Data API units through the ledger
 * (`commentThreads.list`, 1 unit); a refused spend skips comments for that run rather than
 * calling unledgered. Caller: the Trigger schedule.
 */
export const bureauMetricsTask = schedules.task({
  id: '22-bureau-metrics',
  cron: '17 * * * *',
  queue: { concurrencyLimit: 1 },

  run: async () => {
    const db = serverClient();
    const creds = await resolveCredentials(db, 'youtube');
    if (creds.missing.length) {
      logger.info('publish credential not configured; no metrics to pull', { missing: creds.missing });
      return { skipped: 'no_credentials' };
    }
    const token = await fetchAccessToken({
      clientId: creds.values.YOUTUBE_CLIENT_ID,
      clientSecret: creds.values.YOUTUBE_CLIENT_SECRET,
      refreshToken: creds.values.YOUTUBE_REFRESH_TOKEN,
    });
    if (!token.ok) {
      logger.error('access token refused', { code: token.code, revoked: token.credentialRevoked });
      return { skipped: token.code };
    }
    const result = await pullBureauMetrics({
      db,
      analytics: (videoId, startDate, endDate) => shortsMetrics({ accessToken: token.accessToken, videoId, startDate, endDate }),
      comments: async (videoId) => {
        const s = await spend(db, 'youtube', 'commentThreads.list', { detail: `bureau comments ${videoId}` });
        if (!s.ok) return { ok: false, code: s.code, detail: s.detail };
        return commentThreads({ accessToken: token.accessToken, videoId });
      },
    });
    logger.info('bureau metrics', result);
    return result;
  },
});
