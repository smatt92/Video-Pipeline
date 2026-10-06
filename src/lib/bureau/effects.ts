import 'server-only';

import { tasks, wait } from '@trigger.dev/sdk';

import { readUsdInrRate } from '../cost/fx';
import type { Db } from '../db/server';
import { ledgeredEmbedder } from './embed';
import type { BureauSideEffects } from './mcp/surface';
import { notify, type NotificationKind } from './alerts';

/**
 * The production side effects behind the control plane: start an episode run, wake a cut
 * gate, send an alert, embed a brief. Kept out of the tool modules so a harness can drive
 * every tool with recording fakes and the real implementations live in one file.
 *
 * Needs TRIGGER_SECRET_KEY on Vercel (the same key `publish/actions.ts` already uses).
 */
export function productionEffects(db: Db): BureauSideEffects {
  return {
    async startEpisode(episodeId) {
      const handle = await tasks.trigger('20-episode', { episodeId }, { idempotencyKey: `episode:${episodeId}` });
      return handle.id;
    },
    async completeWaitToken(tokenId, output) {
      await wait.completeToken(tokenId, output);
    },
    async notify(channelId, kind, text, dedupeKey) {
      await notify(db, channelId, kind as NotificationKind, text, { dedupeKey });
    },
    async embedderFor(d, ch) {
      const fx = await readUsdInrRate(d);
      return ledgeredEmbedder(d, ch, fx.ok ? fx.rate : null);
    },
  };
}
