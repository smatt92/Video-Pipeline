import { logger, schedules, tasks, wait } from '@trigger.dev/sdk';

import { notify } from '@/lib/bureau/alerts';
import { listChannels } from '@/lib/channels/list';
import { capAlerts, headroom } from '@/lib/bureau/caps';
import { advanceSubmitted, dispatchProvider, settleEpisodes } from '@/lib/bureau/dispatch';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { PROVIDER_INTEGRATION, pollJob, providerDisabled, submitJob } from '@/lib/drivers/jobs';
import { expectedWebhookSecret } from '@/lib/drivers/video-status';
import { env } from '@/lib/env';
import { verifiedCredentials, type VerifiedCredentials } from '@/lib/integrations/verify';
import { runIngest } from '@/lib/ingest/run';
import { storage } from '@/lib/storage';
import { putterFor } from '@/lib/storage/put';

import type { ingestTask } from './05b-ingest';

/**
 * The generation queue's heartbeat, every minute: per provider, claim what the concurrency
 * limit allows and submit it; advance submitted jobs (poll the providers without a webhook,
 * read the outcome of the one with); then wake every episode whose jobs are all terminal.
 *
 * Concurrency lives in `claim_gen_jobs` (provider_limits: 10 / 5 / 3 / 5 per provider, as the
 * plan sets them), not here — two overlapping runs of this task cannot exceed it, which is why the
 * queue setting below is 1 only to keep the logs readable.
 *
 * Production never uses an MCP connector for generation: every call below is the REST driver.
 * Caller: the Trigger schedule.
 */
export const genDispatchTask = schedules.task({
  id: '21-gen-dispatch',
  cron: '* * * * *',
  queue: { concurrencyLimit: 1 },
  // A tick is DB reads and HTTP calls; the encode is 05b-ingest's. Short, so a stuck tick
  // cannot pile up a backlog behind a one-per-minute schedule (118 queued on 10-Oct).
  maxDuration: 240,

  run: async (_payload, { ctx }) => {
    const db = serverClient();
    const { data: providers } = await db.from('provider_limits').select('provider, max_concurrency');
    const { data: anyOpen } = await db.from('gen_jobs').select('id').in('status', ['queued', 'claimed', 'submitted', 'throttled']).limit(1);
    const { data: waiting } = await db.from('episodes').select('id').not('gen_wait_token', 'is', null).limit(1);
    if (!anyOpen?.length && !waiting?.length) return { idle: true };

    const usdInrRate = await requireUsdInrRate(db, 'writing generation cost rows');
    const put = putterFor().put;
    const driver = storage();
    const credentialCache = new Map<string, VerifiedCredentials>();
    const deps = {
      db,
      worker: ctx.run.id,
      usdInrRate,
      webhook: env.WEBHOOK_CALLBACK_BASE_URL ? { baseUrl: env.WEBHOOK_CALLBACK_BASE_URL, secret: expectedWebhookSecret() ?? '' } : undefined,
      async credentialsFor(provider: string) {
        // The refusal itself is verifiedCredentials's, in the lib, where verify:integration-gate
        // drives it; this only caches it for the run.
        let c = credentialCache.get(provider);
        if (!c) {
          c = await verifiedCredentials(db, PROVIDER_INTEGRATION[provider] ?? provider);
          credentialCache.set(provider, c);
        }
        return c;
      },
      // Reference frames in our bucket, resolved per call; 15 min is long enough for the vendor
      // to fetch the frame at submit and short enough that a leaked link is useless.
      presign: async (key: string) => (await driver.presignGet({ key, expiresIn: 15 * 60 })).url,
      submit: submitJob,
      poll: pollJob,
      // A download that needs no header goes to 05b-ingest, keyed on the generation so a
      // repeat tick cannot start a second encode. One that carries a key in a header stays
      // inline, so the key never lands in a run payload.
      ingest: async ({ generationId, assetUrl, headers }: { generationId: string; assetUrl: string; headers: Record<string, string> }) => {
        if (Object.keys(headers).length === 0) {
          await tasks.trigger<typeof ingestTask>('05b-ingest', { generationId, assetUrl, kind: 'video' }, { idempotencyKey: `ingest:${generationId}` });
          return { pending: true as const };
        }
        return runIngest(
          { generationId, assetUrl },
          { db, putBytes: put, fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } }), log: logger },
        );
      },
      log: logger,
    };

    const summary: Record<string, unknown> = {};
    for (const p of providers ?? []) {
      if (providerDisabled(p.provider)) continue; // off entirely — drivers/jobs.ts DISABLED_PROVIDERS
      const d = await dispatchProvider(p.provider, p.max_concurrency, deps);
      const a = await advanceSubmitted(p.provider, deps);
      summary[p.provider] = { ...d, ...a };
    }
    // The 80% alerts, once per day / month each.
    // Per channel: each has its own caps and its own spend.
    for (const ch of await listChannels(db)) {
      for (const a of capAlerts(await headroom(db, ch.id), new Date())) {
        await notify(db, ch.id, 'cap_80', a.text, { dedupeKey: `${ch.id}:${a.key}` });
      }
    }
    const settled = await settleEpisodes(db, async (token, output) => {
      await wait.completeToken(token, output);
    });
    logger.info('dispatch', { ...summary, ...settled });
    return { ...summary, ...settled };
  },
});
