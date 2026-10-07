import { logger, schemaTask, wait } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { resolveCredentials } from '@/lib/integrations/credentials';
import { publishReel } from '@/lib/publish/ig-run';
import { storage } from '@/lib/storage';

/**
 * Stage 10 for Instagram — one Reel, now. Decision 0023.
 *
 * Caller: the "Publish to Instagram now" button on Ready (`publishInstagramAction` →
 * requestInstagramPublish → productionEffects.startInstagramPost), after the row went to
 * `scheduled` through bureau_mark_scheduled. The slot path is `23-ig-publish`; both run
 * `publishReel`, whose compare-and-set claim means they cannot post one row twice.
 *
 * The container wait is Meta's own guidance (once a minute, at most five minutes — no webhook
 * exists; ig-run.ts) and uses `wait.for`, which checkpoints rather than holding the worker.
 * No automatic retry: every retry decision belongs to publishReel's marks, not to Trigger.
 */
const Payload = z.object({ publicationId: z.uuid() });

export const igPostTask = schemaTask({
  id: '26-ig-post',
  schema: Payload,
  queue: { concurrencyLimit: 1 },
  machine: 'small-1x',
  retry: { maxAttempts: 1 },
  maxDuration: 900,

  run: async ({ publicationId }) => {
    const db = serverClient();
    // About the worker's configuration, so it lives here (CLAUDE.md: refusals in tasks). The
    // integration's verified state is checked in publishReel, where a harness reaches it.
    const creds = await resolveCredentials(db, 'instagram');
    if (creds.missing.length) throw new Error(`The Instagram integration is missing ${creds.missing.join(', ')} on the worker.`);
    const driver = storage();
    const r = await publishReel(
      db,
      publicationId,
      { igUserId: creds.values.META_IG_USER_ID, accessToken: creds.values.META_ACCESS_TOKEN },
      {
        presign: async (key, expiresIn) => (await driver.presignGet({ key, expiresIn })).url,
        render: async (renderId) => {
          const { data: r } = await db.from('renders').select('asset_id, width, height, duration_s').eq('id', renderId).single();
          const { data: a } = await db.from('assets').select('storage_key').eq('id', r!.asset_id!).single();
          return { key: a!.storage_key, width: r!.width, height: r!.height, durationS: r!.duration_s === null ? null : Number(r!.duration_s) };
        },
        sleep: (s) => wait.for({ seconds: s }),
      },
    );
    logger.info('reel', r);
    return r;
  },
});
