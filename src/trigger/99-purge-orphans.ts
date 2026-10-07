import { logger, queue, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { purgeOrphans } from '@/lib/settings/orphans';
import { storage } from '@/lib/storage';

/**
 * Settings → Danger zone → Find orphans → Delete. Not a pipeline stage — numbered 99 so `ls`
 * keeps it apart from them.
 *
 * Here and not in the Server Action because rules 2 and 3 keep every call that touches
 * stored bytes off Vercel. The action (`requestOrphanPurgeAction`) checks the approver, the
 * typed slug and the confirmed count, records the request in authorship_log, and hands over
 * the ids; this task runs `purgeOrphans`, which looks again before each delete — a file that
 * gained a reference since the dry run is kept, never deleted — and records the outcome.
 *
 * Concurrency 1: two purges racing would both try the same keys. The driver's delete is
 * idempotent, so a retried run cannot fail on what the first one already removed.
 */
const purgeQueue = queue({ name: '99-purge-orphans', concurrencyLimit: 1 });

export const purgeOrphansTask = schemaTask({
  id: '99-purge-orphans',
  queue: purgeQueue,
  schema: z.object({ channelId: z.uuid(), assetIds: z.array(z.uuid()).min(1).max(5000), profileId: z.uuid().nullable() }),
  run: async (payload) => {
    const db = serverClient();
    const driver = storage();
    const out = await purgeOrphans(db, payload.assetIds, (key) => driver.delete(key));
    logger.info('orphans purged', { deleted: out.deleted.length, kept: out.kept.length, failed: out.failed.length, bytes: out.bytes });
    await db.from('authorship_log').insert({
      channel_id: payload.channelId,
      actor_scope: 'system',
      profile_id: payload.profileId,
      action: 'orphans_purged',
      subject_type: 'assets',
      subject_id: `${out.deleted.length} assets`,
      payload: { deleted: out.deleted, kept: out.kept, failed: out.failed, bytes: out.bytes },
    });
    return out;
  },
});
