import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { resolveCredentials } from '@/lib/integrations/credentials';
import { publishVideo, type PublishResult } from '@/lib/publish/run';
import { storage } from '@/lib/storage';

/**
 * Stage 10 — the upload.
 *
 * ── Why it is a task and not a route ─────────────────────────────────────────
 *
 * Rule 2: a finished render is tens of megabytes and Vercel's hard limit is 4.5MB. The
 * worker fetches it from the bucket by presigned GET and streams it to the vendor; Vercel
 * never sees a byte. The resumable session also outlives any request a serverless function
 * could hold open.
 *
 * ── It has a caller, and here is the entry point ─────────────────────────────
 *
 * The **Publish button on `/publish`** calls `publishNowAction`
 * (`src/lib/publish/actions.ts`), which triggers this. That chain ends at a route a person
 * can open — stated as the entry point rather than as the intermediate, because CLAUDE.md
 * has three instances of a comment naming a caller that was itself uncalled.
 *
 * ── Concurrency 1, and it is load-bearing ────────────────────────────────────
 *
 * Not throughput management. `spend()` in the quota module reads the remaining units and
 * then inserts, and two workers could both see 1,600 remaining and both take it. One at a
 * time makes that race impossible from this path, which is why the quota module documents
 * the race rather than defending against it — a database-side reservation would be a guard
 * for a state no write path produces.
 *
 * ── What is unverified ───────────────────────────────────────────────────────
 *
 * Everything past `resolveCredentials`. No YouTube credential exists, nothing has been
 * uploaded, and `verify:publish` drives `publishVideo` against a local HTTP stub standing
 * in for the vendor. Rule 8 is not satisfied and 0008 §13 says so.
 */

const Payload = z.object({
  publicationId: z.uuid(),
  /** Rule 6. Supplied by the caller so a retry of the same intent reuses it. */
  idempotencyKey: z.string().min(8).max(200),
});

export const publishTask = schemaTask({
  id: '10-publish',
  schema: Payload,

  // See the note above: this is the reason the quota race cannot happen, not a throughput
  // choice. Raising it requires a database-side reservation first.
  queue: { concurrencyLimit: 1 },
  machine: 'small-2x',

  run: async (payload): Promise<PublishResult> => {
    const db = serverClient();

    // Configuration is resolved here and handed down; the decisions are all in the lib, so
    // a harness can reach them. The one guard that genuinely belongs to the task is this
    // one, because it is about the environment the task runs in rather than about a row.
    const creds = await resolveCredentials(db, 'youtube');
    if (creds.missing.length > 0) {
      throw new Error(
        `The publish integration is missing ${creds.missing.join(', ')}. This refusal lives `
        + 'in the task rather than in publishVideo because it is about the worker\'s '
        + 'configuration rather than about the publication — and it is therefore NOT '
        + 'covered by verify:publish, which supplies credentials in its deps object. '
        + 'See CLAUDE.md on refusals that live in a Trigger task.',
      );
    }

    const driver = storage();

    return publishVideo(payload, {
      db,
      app: {
        clientId: creds.values.YOUTUBE_CLIENT_ID,
        clientSecret: creds.values.YOUTUBE_CLIENT_SECRET,
        refreshToken: creds.values.YOUTUBE_REFRESH_TOKEN,
      },
      // Byte-moving stays in the driver module and is imported only from `src/trigger/`,
      // which is what keeps rule 2 structural rather than remembered.
      downloadRender: async (renderId) => {
        // The key lives on the asset, not the render — a render points at the asset it
        // produced. Reading it off `renders` directly is the mistake the type system
        // caught here, and it is worth the join rather than a denormalised copy.
        const { data } = await db
          .from('renders')
          .select('asset_id, assets(storage_key)')
          .eq('id', renderId)
          .single();
        const key = (data?.assets as { storage_key: string } | null)?.storage_key ?? null;
        if (!key) {
          throw new Error(
            `Render ${renderId} has no asset to download — it has not finished rendering, `
            + 'or its asset row was never written. Refusing rather than uploading nothing.',
          );
        }
        const presigned = await driver.presignGet({ key, expiresIn: 3600 });
        const res = await fetch(presigned.url);
        if (!res.ok) throw new Error(`Presigned GET for ${key} returned ${res.status}.`);
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          contentType: res.headers.get('content-type') ?? 'video/mp4',
        };
      },
      log: {
        info: (m, d) => logger.info(m, d as Record<string, unknown>),
        warn: (m, d) => logger.warn(m, d as Record<string, unknown>),
      },
    });
  },
});
