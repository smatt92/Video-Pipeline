import { logger, schedules, wait } from '@trigger.dev/sdk';

import { advanceSubmitted, dispatchProvider, settleEpisodes } from '@/lib/bureau/dispatch';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { PROVIDER_INTEGRATION, pollJob, submitJob } from '@/lib/drivers/jobs';
import { expectedWebhookSecret } from '@/lib/drivers/video-status';
import { env } from '@/lib/env';
import { resolveCredentials } from '@/lib/integrations/credentials';
import { runIngest } from '@/lib/ingest/run';
import { putterFor } from '@/lib/storage/put';

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

  run: async (_payload, { ctx }) => {
    const db = serverClient();
    const { data: providers } = await db.from('provider_limits').select('provider, max_concurrency');
    const { data: anyOpen } = await db.from('gen_jobs').select('id').in('status', ['queued', 'claimed', 'submitted', 'throttled']).limit(1);
    const { data: waiting } = await db.from('episodes').select('id').not('gen_wait_token', 'is', null).limit(1);
    if (!anyOpen?.length && !waiting?.length) return { idle: true };

    const usdInrRate = await requireUsdInrRate(db, 'writing generation cost rows');
    const put = putterFor().put;
    const credentialCache = new Map<string, Record<string, string> | null>();
    const deps = {
      db,
      worker: ctx.run.id,
      usdInrRate,
      webhook: env.WEBHOOK_CALLBACK_BASE_URL ? { baseUrl: env.WEBHOOK_CALLBACK_BASE_URL, secret: expectedWebhookSecret() ?? '' } : undefined,
      async credentialsFor(provider: string) {
        if (!credentialCache.has(provider)) {
          const c = await resolveCredentials(db, PROVIDER_INTEGRATION[provider] ?? provider).catch(() => null);
          credentialCache.set(provider, c && c.missing.length === 0 ? c.values : null);
        }
        return credentialCache.get(provider) ?? null;
      },
      submit: submitJob,
      poll: pollJob,
      ingest: ({ generationId, assetUrl, headers }: { generationId: string; assetUrl: string; headers: Record<string, string> }) =>
        runIngest(
          { generationId, assetUrl },
          { db, putBytes: put, fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } }), log: logger },
        ),
      log: logger,
    };

    const summary: Record<string, unknown> = {};
    for (const p of providers ?? []) {
      const d = await dispatchProvider(p.provider, p.max_concurrency, deps);
      const a = await advanceSubmitted(p.provider, deps);
      summary[p.provider] = { ...d, ...a };
    }
    const settled = await settleEpisodes(db, async (token, output) => {
      await wait.completeToken(token, output);
    });
    logger.info('dispatch', { ...summary, ...settled });
    return { ...summary, ...settled };
  },
});
