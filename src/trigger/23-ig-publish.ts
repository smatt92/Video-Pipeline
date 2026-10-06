import { logger, schedules } from '@trigger.dev/sdk';

import { serverClient } from '@/lib/db/server';
import { resolveCredentials } from '@/lib/integrations/credentials';
import { publishDueReels } from '@/lib/publish/ig-run';
import { storage } from '@/lib/storage';

/**
 * The Reels mirror, every 15 minutes: post what is due. Refuses (per publication, as a row
 * outcome) while channel_policy.instagram_publish_enabled is false — which it is until Meta
 * app review clears (CLAUDE.md current phase). Caller: the Trigger schedule.
 */
export const igPublishTask = schedules.task({
  id: '23-ig-publish',
  cron: '*/15 * * * *',
  queue: { concurrencyLimit: 1 },

  run: async () => {
    const db = serverClient();
    const { data: any } = await db.from('publications').select('id').eq('platform', 'instagram').eq('status', 'scheduled').limit(1);
    if (!any?.length) return { due: 0 };
    const creds = await resolveCredentials(db, 'instagram');
    if (creds.missing.length) {
      logger.error('instagram credentials missing', { missing: creds.missing });
      return { skipped: 'no_credentials' };
    }
    const driver = storage();
    const results = await publishDueReels(
      db,
      { igUserId: creds.values.META_IG_USER_ID, accessToken: creds.values.META_ACCESS_TOKEN },
      {
        videoUrlFor: async (renderId) => {
          const { data: r } = await db.from('renders').select('asset_id, width, height, duration_s').eq('id', renderId).single();
          const { data: a } = await db.from('assets').select('storage_key').eq('id', r!.asset_id!).single();
          return {
            url: (await driver.presignGet({ key: a!.storage_key, expiresIn: 3600 })).url,
            width: r!.width,
            height: r!.height,
            durationS: r!.duration_s === null ? null : Number(r!.duration_s),
          };
        },
      },
    );
    logger.info('reels', { results });
    return { results };
  },
});
